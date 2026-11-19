import HomeySDK from 'homey';
import { AukController, AukState } from '../../lib/AukController';
import { AukConnectionError } from '../../lib/AukSession';
import { HomeyBleTransport } from '../../lib/HomeyBleTransport';
import {
  GrowthMode,
  LightMode,
  cycleOnSeconds,
  cycleWindow,
  formatTimeOfDay,
  isLightMode,
  isLit,
  parseTimeOfDay,
  wallSecondsAt,
} from '../../lib/protocol';

/** Brief link drops are normal for BLE; only report the device unavailable after this long. */
const UNAVAILABLE_GRACE_MS = 2 * 60_000;
/** Re-read shortly after a cycle boundary: the device clears manual overrides around then. */
const BOUNDARY_REFRESH_DELAY_MS = 30_000;
const LAST_INTENSITY_KEY = 'lastIntensity';

type Intensity = Extract<LightMode, 'full' | 'dim'>;
type ModeKind = 'light' | 'growth';
const MODE_CAPABILITY: Record<ModeKind, string> = { light: 'auk_light_mode', growth: 'auk_growth_mode' };
/** Ignore sub-second jitter so the settings label is not rewritten on every poll. */
const REPORTED_DRIFT_MIN_SECONDS = 5;

class AukMini2Device extends HomeySDK.Device {
  private controller!: AukController;
  private unavailableTimer: NodeJS.Timeout | null = null;
  private boundaryTimer: NodeJS.Timeout | null = null;
  private latest: AukState | null = null;
  /**
   * Last mode seen from the device. Kept apart from the capability values because
   * Homey also writes those when a mode is picked in the UI, which would hide the change.
   */
  private readonly knownMode: Record<ModeKind, string | null> = { light: null, growth: null };
  /** Last light-on time seen (HH:mm). The light button on the garden moves it, without announcing it. */
  private knownLightOnTime: string | null = null;
  /** State updates arrive in bursts; apply them in order so a change is never seen (and triggered) twice. */
  private applying: Promise<void> = Promise.resolve();

  async onInit(): Promise<void> {
    const { id } = this.getData() as { id: string };
    // Dropped in 0.1.0 before release: it always equalled the lights-on time.
    if (this.hasCapability('auk_next_light_on')) await this.removeCapability('auk_next_light_on');
    this.knownLightOnTime = this.getCapabilityValue('auk_light_on_time') as string | null;
    for (const kind of ['light', 'growth'] as const) {
      this.knownMode[kind] = this.getCapabilityValue(MODE_CAPABILITY[kind]) as string | null;
    }
    this.controller = new AukController({
      transport: new HomeyBleTransport(this.homey, id),
      nowWall: () => this.nowWall(),
      log: (...args) => this.log(...args),
    });
    this.controller.on('state', (state) => {
      this.applying = this.applying
        .then(() => this.applyState(state))
        .catch((error) => this.error('Failed to apply state:', error));
    });
    this.controller.on('connected', () => this.handleConnected());
    this.controller.on('disconnected', () => this.handleDisconnected());

    this.registerCapabilityListener('onoff', async (value: boolean) => {
      await this.setLightMode(value ? this.lastIntensity() : 'off');
    });
    this.registerCapabilityListener('auk_light_mode', async (value: LightMode) => this.setLightMode(value));
    this.registerCapabilityListener('auk_growth_mode', async (value: GrowthMode) => this.setGrowthMode(value));

    const address = this.getStoreValue('address') as string | undefined;
    if (address) await this.updateSettingIfChanged('address', address);

    this.controller.start();
  }

  async onUninit(): Promise<void> {
    await this.shutdown();
  }

  async onDeleted(): Promise<void> {
    await this.shutdown();
  }

  async setLightMode(mode: LightMode): Promise<void> {
    await this.command(() => this.controller.setLightMode(mode));
  }

  async setGrowthMode(mode: GrowthMode): Promise<void> {
    await this.command(() => this.controller.setGrowthMode(mode));
  }

  async setLightOnTime(value: string): Promise<void> {
    const startOfDay = parseTimeOfDay(value);
    if (startOfDay === null) throw new Error(this.homey.__('errors.invalid_time'));
    await this.command(() => this.controller.setCycleStart(startOfDay));
  }

  private async command(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.error('Command failed:', error);
      if (error instanceof AukConnectionError) throw new Error(this.homey.__('errors.not_connected'), { cause: error });
      throw error;
    }
  }

  private async shutdown(): Promise<void> {
    this.clearUnavailableTimer();
    if (this.boundaryTimer) this.homey.clearTimeout(this.boundaryTimer);
    this.boundaryTimer = null;
    await this.controller?.stop();
  }

  private nowWall(): number {
    return wallSecondsAt(new Date(), this.homey.clock.getTimezone());
  }

  private lastIntensity(): Intensity {
    return this.getStoreValue(LAST_INTENSITY_KEY) === 'dim' ? 'dim' : 'full';
  }

  private handleConnected(): void {
    this.clearUnavailableTimer();
    this.setAvailable().catch((error) => this.error(error));
  }

  private handleDisconnected(): void {
    if (this.unavailableTimer) return;
    this.unavailableTimer = this.homey.setTimeout(() => {
      this.unavailableTimer = null;
      if (this.controller.isConnected) return;
      this.setUnavailable(this.homey.__('status.reconnecting')).catch((error) => this.error(error));
    }, UNAVAILABLE_GRACE_MS);
  }

  private clearUnavailableTimer(): void {
    if (this.unavailableTimer) this.homey.clearTimeout(this.unavailableTimer);
    this.unavailableTimer = null;
  }

  private async applyState(state: AukState): Promise<void> {
    this.latest = state;
    if (state.lightMode === 'full' || state.lightMode === 'dim') {
      if (this.getStoreValue(LAST_INTENSITY_KEY) !== state.lightMode) {
        await this.setStoreValue(LAST_INTENSITY_KEY, state.lightMode);
      }
    }
    await this.updateMode('light', state.lightMode);
    await this.updateMode('growth', state.growthMode);
    if (state.cycleStart !== null) await this.updateLightOnTime(formatTimeOfDay(state.cycleStart));
    await this.updateSchedule();
    if (state.firmware) await this.updateSettingIfChanged('firmware', state.firmware);
    if (state.clockDrift !== null && Math.abs(state.clockDrift) >= REPORTED_DRIFT_MIN_SECONDS) {
      await this.updateSettingIfChanged('clock_drift', `${state.clockDrift} s`);
    }
  }

  /** Updates a mode capability and fires its triggers when the value actually changed. */
  private async updateMode(kind: ModeKind, mode: string | null): Promise<void> {
    if (mode === null) return;
    const previous = this.knownMode[kind];
    if (previous === mode) return;
    this.knownMode[kind] = mode;
    await this.setIfChanged(MODE_CAPABILITY[kind], mode);
    if (previous === null) return;
    this.log(`${kind} mode changed: ${previous} -> ${mode}`);
    const tokens = {
      mode: this.homey.__(`modes.${kind}.${mode}`),
      previous_mode: this.homey.__(`modes.${kind}.${previous}`),
    };
    const flow = this.homey.flow;
    await Promise.all([
      flow.getDeviceTriggerCard(`${kind}_mode_changed`).trigger(this, tokens),
      flow.getDeviceTriggerCard(`${kind}_mode_changed_to`)
        .trigger(this, { previous_mode: tokens.previous_mode }, { mode }),
    ]).catch((error) => this.error('Trigger failed:', error));
  }

  private async updateLightOnTime(time: string): Promise<void> {
    const previous = this.knownLightOnTime;
    if (previous === time) return;
    this.knownLightOnTime = time;
    await this.setIfChanged('auk_light_on_time', time);
    if (previous === null) return;
    this.log(`light-on time changed: ${previous} -> ${time}`);
    await this.homey.flow.getDeviceTriggerCard('light_on_time_changed')
      .trigger(this, { time, previous_time: previous })
      .catch((error) => this.error('Trigger failed:', error));
  }

  /** Derives on/off and the next transitions from the mode and daily cycle; re-arms at the next boundary. */
  private async updateSchedule(): Promise<void> {
    const state = this.latest;
    if (!state) return;
    const now = this.nowWall();
    const onSeconds = cycleOnSeconds(state.growthMode);
    if (isLightMode(state.lightMode)) {
      const lit = isLit(state.lightMode, state.cycleStart, now, onSeconds);
      if (lit !== null && this.getCapabilityValue('onoff') !== lit) await this.setCapabilityValue('onoff', lit);
    }
    if (state.cycleStart === null) return;
    const window = cycleWindow(state.cycleStart, now, onSeconds);
    await this.setIfChanged('auk_next_light_off', formatTimeOfDay(window.nextOff));
    this.armBoundaryTimer(Math.min(window.nextOn, window.nextOff) - now);
  }

  private armBoundaryTimer(secondsUntil: number): void {
    if (this.boundaryTimer) this.homey.clearTimeout(this.boundaryTimer);
    this.boundaryTimer = this.homey.setTimeout(() => {
      this.boundaryTimer = null;
      this.updateSchedule().catch((error) => this.error(error));
      this.homey.setTimeout(() => {
        this.controller.refresh().catch((error) => this.log('Boundary refresh failed:', String(error)));
      }, BOUNDARY_REFRESH_DELAY_MS);
    }, Math.max(1, secondsUntil) * 1000 + 1000);
  }

  private async setIfChanged(capability: string, value: string): Promise<void> {
    if (this.getCapabilityValue(capability) !== value) await this.setCapabilityValue(capability, value);
  }

  private async updateSettingIfChanged(key: string, value: string): Promise<void> {
    if (this.getSetting(key) !== value) await this.setSettings({ [key]: value });
  }
}

export = AukMini2Device;
