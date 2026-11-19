import { EventEmitter } from 'node:events';
import {
  AukConnectionError, AukError, AukLink, AukSession, Observation,
} from './AukSession';
import { GrowthMode, LightMode } from './protocol';

/** Opens a link to the device. `onData` receives notifications; `onClose` fires when the link drops. */
export interface AukTransport {
  open(handlers: { onData: (data: Buffer) => void; onClose: () => void }): Promise<AukLink>;
}

export interface AukState {
  lightMode: LightMode | null;
  growthMode: GrowthMode | null;
  /** Daily light-on time, seconds after local midnight. */
  cycleStart: number | null;
  firmware: string | null;
  /** Device clock minus local wall clock, in seconds. */
  clockDrift: number | null;
}

export interface ControllerOptions {
  transport: AukTransport;
  /** Local wall clock as epoch seconds relabelled as UTC. */
  nowWall: () => number;
  log: (...args: unknown[]) => void;
  /** How often everything is re-read (schedule, clock, modes). */
  pollIntervalMs?: number;
  /** How often just the light and growth modes are re-read, to catch changes made elsewhere quickly. */
  modePollIntervalMs?: number;
  clockSyncIntervalMs?: number;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  responseTimeoutMs?: number;
}

export interface AukControllerEvents {
  state: [AukState];
  connected: [];
  disconnected: [Error | null];
}

const MINUTE = 60_000;

/**
 * Keeps one Auk Mini 2 connected: reconnects with backoff, polls as a fallback
 * for changes the device does not announce, and keeps the device clock in
 * step with local time (it has no time zone and drifts).
 */
export class AukController extends EventEmitter<AukControllerEvents> {
  readonly state: AukState = {
    lightMode: null, growthMode: null, cycleStart: null, firmware: null, clockDrift: null,
  };

  private session: AukSession | null = null;
  private connecting: Promise<AukSession> | null = null;
  private stopped = true;
  private reconnectDelayMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastClockSyncMs = 0;
  private lastFullReadMs = 0;
  private growthModeUnsupported = false;

  private readonly pollIntervalMs: number;
  private readonly modePollIntervalMs: number;
  private readonly clockSyncIntervalMs: number;
  private readonly reconnectMinMs: number;
  private readonly reconnectMaxMs: number;

  constructor(private readonly options: ControllerOptions) {
    super();
    this.pollIntervalMs = options.pollIntervalMs ?? 5 * MINUTE;
    // Changes made in the Auk app are not announced to other clients, so they are only seen by polling.
    this.modePollIntervalMs = Math.min(options.modePollIntervalMs ?? 30_000, this.pollIntervalMs);
    // Hourly keeps daylight-saving shifts short; the write is a single line.
    this.clockSyncIntervalMs = options.clockSyncIntervalMs ?? 60 * MINUTE;
    this.reconnectMinMs = options.reconnectMinMs ?? 5000;
    this.reconnectMaxMs = options.reconnectMaxMs ?? 5 * MINUTE;
    this.reconnectDelayMs = this.reconnectMinMs;
  }

  get isConnected(): boolean {
    return this.session !== null && !this.session.isClosed;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connectSoon(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimers();
    const session = this.session;
    this.session = null;
    if (session) await session.close().catch(() => undefined);
  }

  async setLightMode(mode: LightMode): Promise<void> {
    await (await this.ensureSession()).setLightMode(mode);
  }

  async setGrowthMode(mode: GrowthMode): Promise<void> {
    await (await this.ensureSession()).setGrowthMode(mode);
  }

  async setCycleStart(startOfDay: number): Promise<void> {
    const session = await this.ensureSession();
    await session.setCycleStart(startOfDay, this.options.nowWall());
    this.lastClockSyncMs = Date.now();
    await session.readCycleStart();
    if (this.state.cycleStart !== startOfDay) {
      throw new AukError('The device did not keep the new light-on time');
    }
  }

  /** Re-reads everything. Fails when not connected. */
  async refresh(): Promise<void> {
    const session = await this.ensureSession();
    await this.readAll(session);
  }

  private async ensureSession(): Promise<AukSession> {
    if (this.session && !this.session.isClosed) return this.session;
    if (this.stopped) throw new AukConnectionError('Not connected');
    return this.connect();
  }

  private connect(): Promise<AukSession> {
    if (!this.connecting) {
      this.connecting = this.openSession()
        .catch((error: unknown) => {
          this.scheduleRetry(error);
          throw error;
        })
        .finally(() => { this.connecting = null; });
    }
    return this.connecting;
  }

  private scheduleRetry(error: unknown): void {
    if (this.stopped) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(delay * 2, this.reconnectMaxMs);
    this.options.log(`Connect failed (${String(error)}), retrying in ${Math.round(delay / 1000)}s`);
    this.connectSoon(delay);
  }

  private async openSession(): Promise<AukSession> {
    let session: AukSession | null = null;
    const link = await this.options.transport.open({
      onData: (data) => session?.handleData(data),
      onClose: () => { if (session) this.handleClose(session, null); },
    });
    session = new AukSession(link, {
      responseTimeoutMs: this.options.responseTimeoutMs,
      onObservation: (observation) => this.apply(observation),
      log: this.options.log,
    });
    try {
      await this.readAll(session);
      await this.syncClock(session);
    } catch (error) {
      // The device takes one client at a time; never leave a half-set-up link holding it.
      await session.close().catch(() => undefined);
      throw error;
    }
    if (this.stopped) {
      await session.close().catch(() => undefined);
      throw new AukConnectionError('Stopped');
    }
    this.session = session;
    this.reconnectDelayMs = this.reconnectMinMs;
    this.schedulePoll();
    this.emit('connected');
    return session;
  }

  private async readAll(session: AukSession): Promise<void> {
    await session.readLightMode();
    await session.readCycleStart();
    await this.readGrowthMode(session);
    if (this.state.firmware === null) await session.readFirmware().catch(() => undefined);
    await session.readClock().catch(() => undefined);
    this.lastFullReadMs = Date.now();
  }

  private async readModes(session: AukSession): Promise<void> {
    await session.readLightMode();
    await this.readGrowthMode(session);
  }

  private async readGrowthMode(session: AukSession): Promise<void> {
    // Older firmware has no growth mode and answers ERR; don't keep asking.
    if (this.growthModeUnsupported) return;
    await session.readGrowthMode().catch((error: unknown) => {
      if (error instanceof AukConnectionError) throw error;
      this.growthModeUnsupported = true;
      this.options.log('Growth mode not readable:', String(error));
    });
  }

  private async syncClock(session: AukSession): Promise<void> {
    await session.syncClock(this.options.nowWall());
    this.lastClockSyncMs = Date.now();
    this.state.clockDrift = 0;
  }

  private handleClose(session: AukSession, error: Error | null): void {
    session.markClosed();
    if (this.session !== session) return;
    this.session = null;
    this.clearPollTimer();
    this.emit('disconnected', error);
    if (!this.stopped) this.connectSoon(this.reconnectMinMs);
  }

  private connectSoon(delayMs: number): void {
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped || this.isConnected) return;
      this.connect().catch(() => undefined);
    }, delayMs);
  }

  private schedulePoll(): void {
    this.clearPollTimer();
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.poll().catch(() => undefined);
    }, this.modePollIntervalMs);
  }

  private async poll(): Promise<void> {
    const session = this.session;
    if (!session || session.isClosed) return;
    try {
      if (Date.now() - this.lastFullReadMs >= this.pollIntervalMs) await this.readAll(session);
      else await this.readModes(session);
      if (Date.now() - this.lastClockSyncMs >= this.clockSyncIntervalMs) await this.syncClock(session);
    } catch (error) {
      if (session.isClosed) return;
      // A link that stops answering is useless and blocks other clients: drop and rebuild it.
      this.options.log('Poll failed, reconnecting:', String(error));
      await session.close().catch(() => undefined);
      this.handleClose(session, error instanceof Error ? error : new Error(String(error)));
      return;
    }
    if (this.session === session) this.schedulePoll();
  }

  private apply(observation: Observation): void {
    switch (observation.kind) {
      case 'light': this.state.lightMode = observation.mode; break;
      case 'growth': this.state.growthMode = observation.mode; break;
      case 'cycleStart': this.state.cycleStart = observation.secondOfDay; break;
      case 'firmware': this.state.firmware = observation.version; break;
      case 'clock': this.state.clockDrift = observation.wallSeconds - this.options.nowWall(); break;
      default: return;
    }
    this.emit('state', { ...this.state });
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearPollTimer(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private clearTimers(): void {
    this.clearReconnectTimer();
    this.clearPollTimer();
  }
}
