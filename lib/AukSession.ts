import {
  GrowthMode,
  LightMode,
  LineFramer,
  VERB,
  decodeFirmware,
  decodeGrowthMode,
  decodeLightMode,
  decodeWallSeconds,
  encodeWallSeconds,
  growthModeCode,
  isErrorLine,
  lightModeCode,
  nextOccurrence,
  parseLine,
  secondOfDay,
} from './protocol';

/** One open BLE link: a way to write a line and to close it. */
export interface AukLink {
  write(data: Buffer): Promise<void>;
  close(): Promise<void>;
}

export type Observation =
  | { kind: 'light'; mode: LightMode }
  | { kind: 'growth'; mode: GrowthMode }
  | { kind: 'cycleStart'; secondOfDay: number }
  | { kind: 'clock'; wallSeconds: number }
  | { kind: 'firmware'; version: string };

export class AukError extends Error {}
/** The device answered `ERR`, or never answered. */
export class AukProtocolError extends AukError {}
/** The link is gone. */
export class AukConnectionError extends AukError {}

export interface SessionOptions {
  responseTimeoutMs?: number;
  attempts?: number;
  onObservation: (observation: Observation) => void;
  log?: (...args: unknown[]) => void;
}

interface Waiter {
  timer?: NodeJS.Timeout;
  matches: (line: string) => boolean;
  resolve: (line: string) => void;
  reject: (error: Error) => void;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_ATTEMPTS = 2;

const observe = (line: string): Observation | null => {
  const parsed = parseLine(line);
  if (!parsed || !parsed.operand) return null;
  const { verb, operand } = parsed;
  switch (verb) {
    case VERB.lightState: {
      const mode = decodeLightMode(operand);
      return mode ? { kind: 'light', mode } : null;
    }
    case VERB.growthMode: {
      const mode = decodeGrowthMode(operand);
      return mode ? { kind: 'growth', mode } : null;
    }
    case VERB.cycleStart: {
      const seconds = decodeWallSeconds(operand);
      return seconds === null ? null : { kind: 'cycleStart', secondOfDay: secondOfDay(seconds) };
    }
    case VERB.clock: {
      const seconds = decodeWallSeconds(operand);
      return seconds === null ? null : { kind: 'clock', wallSeconds: seconds };
    }
    case VERB.firmware: {
      const version = decodeFirmware(operand);
      return version ? { kind: 'firmware', version } : null;
    }
    default:
      return null;
  }
};

/**
 * Request/response over one connection. Commands are serialised; every line
 * the device sends, asked for or not, is reported through `onObservation`.
 */
export class AukSession {
  private readonly framer = new LineFramer();
  private readonly timeoutMs: number;
  private readonly attempts: number;
  private waiter: Waiter | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(private readonly link: AukLink, private readonly options: SessionOptions) {
    this.timeoutMs = options.responseTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.attempts = options.attempts ?? DEFAULT_ATTEMPTS;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  handleData(data: Buffer): void {
    const { lines, overflowed } = this.framer.push(data);
    if (overflowed) this.options.log?.('Notification buffer overflow, dropped partial data');
    for (const line of lines) this.handleLine(line);
  }

  private handleLine(line: string): void {
    const observation = observe(line);
    if (observation) this.options.onObservation(observation);
    const waiter = this.waiter;
    if (!waiter) return;
    if (isErrorLine(line)) {
      this.waiter = null;
      waiter.reject(new AukProtocolError(`Device rejected the command: ${line}`));
    } else if (waiter.matches(line)) {
      this.waiter = null;
      waiter.resolve(line);
    }
  }

  /** Fails any command in flight. Further commands fail immediately. */
  markClosed(): void {
    this.closed = true;
    const waiter = this.waiter;
    this.waiter = null;
    waiter?.reject(new AukConnectionError('Disconnected'));
  }

  async close(): Promise<void> {
    this.markClosed();
    await this.link.close();
  }

  private request(command: string, matches: (line: string) => boolean): Promise<string> {
    const run = () => this.send(command, matches);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async send(command: string, matches: (line: string) => boolean): Promise<string> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.sendOnce(command, matches);
      } catch (error) {
        const timedOut = error instanceof AukProtocolError && error.message.startsWith('No answer');
        if (!timedOut || attempt >= this.attempts) throw error;
        this.options.log?.(`No answer to ${command} (attempt ${attempt}/${this.attempts}), retrying`);
      }
    }
  }

  private sendOnce(command: string, matches: (line: string) => boolean): Promise<string> {
    if (this.closed) return Promise.reject(new AukConnectionError('Not connected'));
    return new Promise<string>((resolve, reject) => {
      const waiter: Waiter = {
        matches,
        resolve: (line) => { clearTimeout(waiter.timer); resolve(line); },
        reject: (error) => { clearTimeout(waiter.timer); reject(error); },
      };
      waiter.timer = setTimeout(() => {
        if (this.waiter !== waiter) return;
        this.waiter = null;
        reject(new AukProtocolError(`No answer to ${command}`));
      }, this.timeoutMs);
      // Register before writing: the answer can arrive before the write call resolves.
      this.waiter = waiter;
      this.link.write(Buffer.from(`${command}\n`, 'latin1')).catch((error: unknown) => {
        if (this.waiter === waiter) this.waiter = null;
        waiter.reject(new AukConnectionError(`Write failed: ${String(error)}`));
      });
    });
  }

  private read(verb: string): Promise<string> {
    return this.request(`${verb} READ`, (line) => line.startsWith(`${verb} `));
  }

  private async write(verb: string, operand: string): Promise<void> {
    const echo = `${verb} ${operand}`;
    await this.request(`${verb} WRITE ${operand}`, (line) => line === echo);
  }

  readLightMode(): Promise<string> {
    return this.read(VERB.lightState);
  }

  setLightMode(mode: LightMode): Promise<void> {
    return this.write(VERB.lightState, lightModeCode(mode));
  }

  readGrowthMode(): Promise<string> {
    return this.read(VERB.growthMode);
  }

  setGrowthMode(mode: GrowthMode): Promise<void> {
    return this.write(VERB.growthMode, growthModeCode(mode));
  }

  readCycleStart(): Promise<string> {
    return this.read(VERB.cycleStart);
  }

  readClock(): Promise<string> {
    return this.read(VERB.clock);
  }

  readFirmware(): Promise<string> {
    return this.read(VERB.firmware);
  }

  syncClock(nowWall: number): Promise<void> {
    return this.write(VERB.clock, encodeWallSeconds(nowWall));
  }

  /**
   * Sets the daily light-on time. The device anchors the cycle at an absolute
   * timestamp, so the clock is synced first and the anchor is the next
   * occurrence of the requested time.
   */
  async setCycleStart(startOfDay: number, nowWall: number): Promise<void> {
    await this.syncClock(nowWall);
    await this.write(VERB.cycleStart, encodeWallSeconds(nextOccurrence(startOfDay, nowWall)));
  }
}
