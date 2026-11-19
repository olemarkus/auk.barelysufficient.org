import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeAuk } from './fakeAuk';

const fakes: FakeAuk[] = [];

vi.mock('../lib/HomeyBleTransport', () => ({
  HomeyBleTransport: class {
    constructor() {
      return fakes[fakes.length - 1];
    }
  },
}));

vi.mock('homey', () => {
  class Device {
    capabilities: Record<string, unknown> = {};
    store: Record<string, unknown> = {};
    settings: Record<string, unknown> = {};
    listeners: Record<string, (value: unknown) => Promise<void>> = {};
    homey: any;
    getData() { return { id: 'peripheral-1' }; }
    hasCapability(id: string) { return id in this.capabilities; }
    async removeCapability(id: string) { delete this.capabilities[id]; }
    getCapabilityValue(id: string) { return this.capabilities[id] ?? null; }
    async setCapabilityValue(id: string, value: unknown) { this.capabilities[id] = value; }
    registerCapabilityListener(id: string, fn: (value: unknown) => Promise<void>) { this.listeners[id] = fn; }
    getStoreValue(key: string) { return this.store[key]; }
    async setStoreValue(key: string, value: unknown) { this.store[key] = value; }
    getSetting(key: string) { return this.settings[key]; }
    async setSettings(values: Record<string, unknown>) { Object.assign(this.settings, values); }
    async setAvailable() {}
    async setUnavailable() {}
    log() {}
    error() {}
  }
  return { default: { Device, Driver: class {}, App: class {} } };
});

const AukMini2Device = (await import('../drivers/mini2/device')).default as any;

interface Fired { card: string; tokens: Record<string, string>; state?: Record<string, string> }

const makeDevice = async (initial: Record<string, unknown> = {}) => {
  const fake = new FakeAuk();
  fake.fragment = false;
  fakes.push(fake);
  const fired: Fired[] = [];
  const device = new AukMini2Device();
  Object.assign(device.capabilities, initial);
  device.homey = {
    __: (key: string) => key.split('.').pop(),
    clock: { getTimezone: () => 'UTC' },
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (t: NodeJS.Timeout) => clearTimeout(t),
    flow: {
      getDeviceTriggerCard: (card: string) => ({
        trigger: async (_d: unknown, tokens: Record<string, string>, state?: Record<string, string>) => {
          fired.push({ card, tokens, state });
        },
      }),
    },
  };
  await device.onInit();
  await vi.waitFor(() => expect(device.capabilities.auk_light_mode).toBeTruthy());
  return { device, fake, fired };
};

const devices: any[] = [];
afterEach(async () => {
  await Promise.all(devices.splice(0).map((d) => d.onUninit()));
  fakes.splice(0);
});

describe('Auk Mini 2 device', () => {
  it('fills capabilities on first contact without firing change triggers', async () => {
    const { device, fired } = await makeDevice();
    devices.push(device);
    await vi.waitFor(() => expect(device.capabilities.auk_light_on_time).toBe('07:00'));
    expect(device.capabilities.auk_growth_mode).toBe('herbs');
    expect(fired).toEqual([]);
  });

  it('fires light mode triggers when the device announces a change', async () => {
    const { device, fake, fired } = await makeDevice();
    devices.push(device);
    fake.lightCode = '03';
    fake.announce('LC_STATE 03');

    await vi.waitFor(() => expect(fired).toHaveLength(2));
    expect(fired).toEqual([
      { card: 'light_mode_changed', tokens: { mode: 'off', previous_mode: 'auto' }, state: undefined },
      { card: 'light_mode_changed_to', tokens: { previous_mode: 'auto' }, state: { mode: 'off' } },
    ]);
    expect(device.capabilities.onoff).toBe(false);
  });

  it('fires a trigger when the mode was changed from Homey itself', async () => {
    const { device, fake, fired } = await makeDevice();
    devices.push(device);
    // Homey stores the picked value as well as calling the listener.
    device.capabilities.auk_growth_mode = 'slow';
    await device.listeners.auk_growth_mode('slow');

    expect(fake.modeCode).toBe('02');
    await vi.waitFor(() => expect(fired.map((f) => f.card)).toContain('growth_mode_changed'));
  });

  it('fires a trigger for a change that happened while the app was not running', async () => {
    const { device, fired } = await makeDevice({ auk_light_mode: 'dim' });
    devices.push(device);
    await vi.waitFor(() => expect(fired.map((f) => f.card)).toContain('light_mode_changed'));
    expect(fired[0].tokens).toEqual({ mode: 'auto', previous_mode: 'dim' });
  });

  it('turns back on at the last intensity used', async () => {
    const { device, fake } = await makeDevice();
    devices.push(device);
    fake.announce('LC_STATE 02');
    await vi.waitFor(() => expect(device.store.lastIntensity).toBe('dim'));

    await device.listeners.onoff(false);
    expect(fake.lightCode).toBe('03');
    await device.listeners.onoff(true);
    expect(fake.lightCode).toBe('02');
  });

  it('rejects an invalid light-on time', async () => {
    const { device } = await makeDevice();
    devices.push(device);
    await expect(device.setLightOnTime('25:00')).rejects.toThrow('invalid_time');
  });

  it('fires a trigger when the light-on time moves', async () => {
    const { device, fake, fired } = await makeDevice();
    devices.push(device);
    await vi.waitFor(() => expect(device.capabilities.auk_light_on_time).toBe('07:00'));

    // The light button restarts the cycle; the device does not announce it, the next poll sees it.
    fake.cycleStartWall = Date.parse('2026-11-16T05:30:00Z') / 1000;
    await device.controller.refresh();

    await vi.waitFor(() => expect(fired.map((f) => f.card)).toContain('light_on_time_changed'));
    expect(fired.find((f) => f.card === 'light_on_time_changed')?.tokens)
      .toEqual({ time: '05:30', previous_time: '07:00' });
    expect(device.capabilities.auk_light_on_time).toBe('05:30');
  });
});
