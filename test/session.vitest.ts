import { describe, expect, it, vi } from 'vitest';
import { AukConnectionError, AukProtocolError, AukSession, Observation } from '../lib/AukSession';

const makeSession = (write: (line: string, session: AukSession) => void, attempts = 2) => {
  const observations: Observation[] = [];
  const link = { write: vi.fn(), close: vi.fn(async () => undefined) };
  const session = new AukSession(link, {
    responseTimeoutMs: 20,
    attempts,
    onObservation: (o) => observations.push(o),
  });
  link.write.mockImplementation(async (data: Buffer) => write(data.toString('latin1'), session));
  return { session, link, observations };
};

describe('AukSession', () => {
  it('fails fast when the device rejects a command', async () => {
    const { session } = makeSession((_line, s) => s.handleData(Buffer.from('ERR 04\n')));
    await expect(session.readGrowthMode()).rejects.toBeInstanceOf(AukProtocolError);
  });

  it('retries once when an answer is lost', async () => {
    let calls = 0;
    const { session, observations } = makeSession((_line, s) => {
      calls += 1;
      if (calls === 2) s.handleData(Buffer.from('LC_STATE 02\n'));
    });
    await session.readLightMode();
    expect(calls).toBe(2);
    expect(observations).toEqual([{ kind: 'light', mode: 'dim' }]);
  });

  it('gives up after the last attempt', async () => {
    const { session, link } = makeSession(() => undefined, 2);
    await expect(session.readLightMode()).rejects.toThrow('No answer to LC_STATE READ');
    expect(link.write).toHaveBeenCalledTimes(2);
  });

  it('accepts a write only when the exact echo comes back', async () => {
    const { session } = makeSession((line, s) => {
      s.handleData(Buffer.from('LC_STATE 01\n'));
      if (line.includes('03')) s.handleData(Buffer.from('LC_STATE 03\n'));
    });
    await expect(session.setLightMode('off')).resolves.toBeUndefined();
  });

  it('runs commands one at a time', async () => {
    const order: string[] = [];
    const { session } = makeSession((line, s) => {
      order.push(line.trim());
      setTimeout(() => s.handleData(Buffer.from(line.startsWith('MODE') ? 'MODE 00\n' : 'LC_STATE 00\n')), 5);
    });
    await Promise.all([session.readLightMode(), session.readGrowthMode()]);
    expect(order).toEqual(['LC_STATE READ', 'MODE READ']);
  });

  it('fails the command in flight when the link closes', async () => {
    const { session } = makeSession((_line, s) => s.markClosed());
    await expect(session.readLightMode()).rejects.toBeInstanceOf(AukConnectionError);
    await expect(session.readLightMode()).rejects.toBeInstanceOf(AukConnectionError);
  });

  it('reports a failed write as a connection error', async () => {
    const { session, link } = makeSession(() => undefined);
    link.write.mockRejectedValue(new Error('ATT error'));
    await expect(session.readLightMode()).rejects.toBeInstanceOf(AukConnectionError);
  });

  it('ignores lines it does not understand', async () => {
    const { session, observations } = makeSession(() => undefined);
    session.handleData(Buffer.from('HELLO there\nLC_STATE 77\nMODE\n'));
    expect(observations).toEqual([]);
  });
});
