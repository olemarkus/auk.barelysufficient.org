import type { AukTransport } from '../lib/AukController';
import type { AukLink } from '../lib/AukSession';
import { decodeWallSeconds, encodeWallSeconds } from '../lib/protocol';

/** Simulates an Auk Mini 2 speaking the line protocol, including one-client-at-a-time. */
export class FakeAuk implements AukTransport {
  lightCode = '00';
  modeCode: string | null = '00';
  cycleStartWall = Date.parse('2026-11-14T07:00:00Z') / 1000;
  clockWall = Date.parse('2026-11-14T12:00:00Z') / 1000;
  firmware = '01 00 00';
  /** Answers are split in two notifications to exercise reassembly. */
  fragment = true;
  silent = false;
  failOpens = 0;
  opens = 0;
  readonly received: string[] = [];
  private handlers: { onData: (data: Buffer) => void; onClose: () => void } | null = null;

  get connected(): boolean {
    return this.handlers !== null;
  }

  async open(handlers: { onData: (data: Buffer) => void; onClose: () => void }): Promise<AukLink> {
    this.opens += 1;
    if (this.failOpens > 0) {
      this.failOpens -= 1;
      throw new Error('Peripheral not found');
    }
    if (this.handlers) throw new Error('Device already has a client');
    this.handlers = handlers;
    const own = handlers;
    return {
      write: async (data) => {
        if (this.handlers !== own) throw new Error('Not connected');
        this.handle(data.toString('latin1').trim());
      },
      close: async () => {
        if (this.handlers === own) this.handlers = null;
      },
    };
  }

  /** The device itself drops the link. */
  drop(): void {
    const handlers = this.handlers;
    this.handlers = null;
    handlers?.onClose();
  }

  /** Something on the device changed (button press, schedule) and it announces the new state. */
  announce(line: string): void {
    this.send(line);
  }

  private send(line: string): void {
    const handlers = this.handlers;
    if (!handlers) return;
    const data = Buffer.from(`${line}\n`, 'latin1');
    queueMicrotask(() => {
      if (!this.fragment) {
        handlers.onData(data);
        return;
      }
      const cut = Math.ceil(data.length / 2);
      handlers.onData(data.subarray(0, cut));
      queueMicrotask(() => handlers.onData(data.subarray(cut)));
    });
  }

  private handle(command: string): void {
    this.received.push(command);
    if (this.silent) return;
    const [verb, action, ...rest] = command.split(' ');
    const operand = rest.join(' ');
    const reply = action === 'WRITE' ? this.write(verb, operand) : this.read(verb);
    this.send(reply);
  }

  private read(verb: string): string {
    switch (verb) {
      case 'LC_STATE': return `LC_STATE ${this.lightCode}`;
      case 'MODE': return this.modeCode === null ? 'ERR 04' : `MODE ${this.modeCode}`;
      case 'LIGHT_CYCLE_ON_TIME': return `LIGHT_CYCLE_ON_TIME ${encodeWallSeconds(this.cycleStartWall)}`;
      case 'TIME': return `TIME ${encodeWallSeconds(this.clockWall)} 00 00 00 00 00 00 00 00`;
      case 'FW_VERSION': return `FW_VERSION ${this.firmware}`;
      default: return 'ERR 04';
    }
  }

  private write(verb: string, operand: string): string {
    switch (verb) {
      case 'LC_STATE': this.lightCode = operand; break;
      case 'MODE':
        if (this.modeCode === null) return 'ERR 04';
        this.modeCode = operand;
        break;
      case 'LIGHT_CYCLE_ON_TIME': this.cycleStartWall = decodeWallSeconds(operand) ?? 0; break;
      case 'TIME': this.clockWall = decodeWallSeconds(operand) ?? 0; break;
      default: return 'ERR 04';
    }
    return `${verb} ${operand}`;
  }
}
