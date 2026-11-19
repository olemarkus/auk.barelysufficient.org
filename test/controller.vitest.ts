import { afterEach, describe, expect, it, vi } from 'vitest';
import { AukController, AukState } from '../lib/AukController';
import { AukConnectionError, AukProtocolError } from '../lib/AukSession';
import { FakeAuk } from './fakeAuk';

const NOW_WALL = Date.parse('2026-11-14T12:00:30Z') / 1000;
const controllers: AukController[] = [];

const makeController = (fake: FakeAuk, overrides: Partial<ConstructorParameters<typeof AukController>[0]> = {}) => {
  const controller = new AukController({
    transport: fake,
    nowWall: () => NOW_WALL,
    log: () => undefined,
    pollIntervalMs: 40,
    clockSyncIntervalMs: 60 * 60_000,
    reconnectMinMs: 10,
    reconnectMaxMs: 40,
    responseTimeoutMs: 30,
    ...overrides,
    modePollIntervalMs: overrides.modePollIntervalMs ?? overrides.pollIntervalMs ?? 40,
  });
  controllers.push(controller);
  return controller;
};

const connected = (controller: AukController) => new Promise<void>((resolve) => {
  if (controller.isConnected) resolve();
  else controller.once('connected', () => resolve());
});

afterEach(async () => {
  await Promise.all(controllers.splice(0).map((c) => c.stop()));
});

describe('AukController', () => {
  it('reads the full state and syncs the clock on connect', async () => {
    const fake = new FakeAuk();
    fake.lightCode = '02';
    fake.modeCode = '01';
    const controller = makeController(fake);
    controller.start();
    await connected(controller);

    expect(controller.state).toEqual({
      lightMode: 'dim',
      growthMode: 'fruit',
      cycleStart: 7 * 3600,
      firmware: '1.0.0',
      clockDrift: 0,
    });
    expect(fake.clockWall).toBe(NOW_WALL);
    expect(fake.received).toContain('TIME READ');
  });

  it('reports a light mode the device announces on its own', async () => {
    const fake = new FakeAuk();
    const controller = makeController(fake, { pollIntervalMs: 60_000 });
    controller.start();
    await connected(controller);

    const seen: AukState[] = [];
    controller.on('state', (state) => seen.push(state));
    fake.lightCode = '03';
    fake.announce('LC_STATE 03');

    await vi.waitFor(() => expect(seen.at(-1)?.lightMode).toBe('off'));
  });

  it('picks up a change the device does not announce on the next poll', async () => {
    const fake = new FakeAuk();
    const controller = makeController(fake);
    controller.start();
    await connected(controller);

    fake.lightCode = '01';
    await vi.waitFor(() => expect(controller.state.lightMode).toBe('full'));
  });

  it('sets light and growth modes and confirms them from the echo', async () => {
    const fake = new FakeAuk();
    const controller = makeController(fake, { pollIntervalMs: 60_000 });
    controller.start();
    await connected(controller);

    await controller.setLightMode('off');
    await controller.setGrowthMode('slow');

    expect(fake.lightCode).toBe('03');
    expect(fake.modeCode).toBe('02');
    expect(controller.state.lightMode).toBe('off');
    expect(controller.state.growthMode).toBe('slow');
  });

  it('anchors a new light-on time at its next occurrence and verifies it', async () => {
    const fake = new FakeAuk();
    const controller = makeController(fake, { pollIntervalMs: 60_000 });
    controller.start();
    await connected(controller);

    await controller.setCycleStart(6 * 3600 + 30 * 60);

    expect(fake.cycleStartWall).toBe(Date.parse('2026-11-15T06:30:00Z') / 1000);
    expect(controller.state.cycleStart).toBe(6 * 3600 + 30 * 60);
  });

  it('keeps working on firmware without a growth mode', async () => {
    const fake = new FakeAuk();
    fake.modeCode = null;
    const controller = makeController(fake, { pollIntervalMs: 60_000 });
    controller.start();
    await connected(controller);

    expect(controller.state.growthMode).toBeNull();
    expect(controller.state.lightMode).toBe('auto');
    await expect(controller.setGrowthMode('fruit')).rejects.toBeInstanceOf(AukProtocolError);
  });

  it('reconnects after the device drops the link', async () => {
    const fake = new FakeAuk();
    const controller = makeController(fake, { pollIntervalMs: 60_000 });
    const disconnected = vi.fn();
    controller.on('disconnected', disconnected);
    controller.start();
    await connected(controller);

    fake.drop();
    expect(controller.isConnected).toBe(false);
    expect(disconnected).toHaveBeenCalledOnce();

    await connected(controller);
    expect(fake.opens).toBe(2);
  });

  it('retries with backoff until the device can be found', async () => {
    const fake = new FakeAuk();
    fake.failOpens = 3;
    const controller = makeController(fake);
    controller.start();
    await connected(controller);
    expect(fake.opens).toBe(4);
  });

  it('drops a link that stops answering so the slot is freed and rebuilt', async () => {
    const fake = new FakeAuk();
    const controller = makeController(fake);
    controller.start();
    await connected(controller);

    const dropped = new Promise((resolve) => { controller.once('disconnected', resolve); });
    fake.silent = true;
    expect(await dropped).toBeInstanceOf(Error);

    // The fake refuses a second client, so reconnecting proves the stale link was released.
    fake.silent = false;
    await connected(controller);
  });

  it('releases the device when setup after connecting fails', async () => {
    const fake = new FakeAuk();
    fake.silent = true;
    const controller = makeController(fake, { reconnectMinMs: 60_000 });
    controller.start();

    await vi.waitFor(() => expect(fake.opens).toBe(1));
    await vi.waitFor(() => expect(fake.connected).toBe(false));
    expect(controller.isConnected).toBe(false);
  });

  it('connects on demand for a command after a failed attempt', async () => {
    const fake = new FakeAuk();
    fake.failOpens = 1;
    const controller = makeController(fake, { reconnectMinMs: 60_000 });
    controller.start();
    await vi.waitFor(() => expect(fake.opens).toBe(1));

    await controller.setLightMode('full');
    expect(fake.lightCode).toBe('01');
  });

  it('refuses commands once stopped and frees the device', async () => {
    const fake = new FakeAuk();
    const controller = makeController(fake);
    controller.start();
    await connected(controller);
    await controller.stop();

    expect(fake.connected).toBe(false);
    await expect(controller.setLightMode('off')).rejects.toBeInstanceOf(AukConnectionError);
  });

  it('re-syncs the clock on a poll once the interval has passed', async () => {
    const fake = new FakeAuk();
    const controller = makeController(fake, { clockSyncIntervalMs: 0 });
    controller.start();
    await connected(controller);

    fake.clockWall = 0;
    await vi.waitFor(() => expect(fake.clockWall).toBe(NOW_WALL));
  });

  it('reports clock drift measured before syncing', async () => {
    const fake = new FakeAuk();
    fake.clockWall = NOW_WALL + 95;
    const controller = makeController(fake, { pollIntervalMs: 60_000 });
    const drifts: number[] = [];
    controller.on('state', (state) => { if (state.clockDrift !== null) drifts.push(state.clockDrift); });
    controller.start();
    await connected(controller);
    expect(drifts).toContain(95);
  });

  it('re-reads everything on request', async () => {
    const fake = new FakeAuk();
    const controller = makeController(fake, { pollIntervalMs: 60_000 });
    controller.start();
    await connected(controller);

    fake.lightCode = '01';
    fake.modeCode = '02';
    await controller.refresh();
    expect(controller.state.lightMode).toBe('full');
    expect(controller.state.growthMode).toBe('slow');
  });

  it('re-reads only the modes between full polls', async () => {
    const fake = new FakeAuk();
    const controller = makeController(fake, { pollIntervalMs: 60_000, modePollIntervalMs: 20 });
    controller.start();
    await connected(controller);
    fake.received.length = 0;

    fake.modeCode = '02';
    await vi.waitFor(() => expect(controller.state.growthMode).toBe('slow'));
    expect(new Set(fake.received)).toEqual(new Set(['LC_STATE READ', 'MODE READ']));
  });

  it('stops asking for the growth mode once the firmware says it has none', async () => {
    const fake = new FakeAuk();
    fake.modeCode = null;
    const controller = makeController(fake, { pollIntervalMs: 60_000, modePollIntervalMs: 20 });
    controller.start();
    await connected(controller);
    fake.received.length = 0;

    await vi.waitFor(() => expect(fake.received.filter((c) => c === 'LC_STATE READ').length).toBeGreaterThan(1));
    expect(fake.received).not.toContain('MODE READ');
  });
});
