/**
 * Auk Mini 2 BLE protocol.
 *
 * The device exposes one write and one notify characteristic. Traffic is
 * newline-terminated ASCII: `<VERB> READ`, `<VERB> WRITE <operand>`, and the
 * device answers with `<VERB> <operand>` (writes are echoed back). Operands
 * are space-separated uppercase hex bytes. Rejected commands answer `ERR xx`.
 *
 * Timestamps are 4-byte big-endian epoch seconds of the local wall clock
 * relabelled as UTC: the device has no notion of time zones. This module
 * calls such a value a "wall second".
 */

export const LOCAL_NAME = 'Auk Mini 2';
export const WRITE_CHARACTERISTIC = '3a916589a0b14d384d388f8ecc94ff01';
export const NOTIFY_CHARACTERISTIC = '3a916589a0b14d384d388f8ecc94ff02';

/** The daily cycle is 16 hours on, 8 off; Fruit & veggies runs 20 on, 4 off (observed on a device). */
export const CYCLE_ON_SECONDS = 16 * 3600;
const FRUIT_CYCLE_ON_SECONDS = 20 * 3600;
export const DAY_SECONDS = 24 * 3600;

const FRAME_CAP_BYTES = 4096;

export const LIGHT_MODES = ['auto', 'full', 'dim', 'off'] as const;
export type LightMode = typeof LIGHT_MODES[number];

export const GROWTH_MODES = ['herbs', 'fruit', 'slow'] as const;
export type GrowthMode = typeof GROWTH_MODES[number];

/** `auto` means no manual override: the light follows its daily cycle. */
const LIGHT_MODE_CODES: Record<LightMode, string> = {
  auto: '00',
  full: '01',
  dim: '02',
  off: '03',
};

const GROWTH_MODE_CODES: Record<GrowthMode, string> = {
  herbs: '00',
  fruit: '01',
  slow: '02',
};

export const VERB = {
  lightState: 'LC_STATE',
  cycleStart: 'LIGHT_CYCLE_ON_TIME',
  growthMode: 'MODE',
  clock: 'TIME',
  firmware: 'FW_VERSION',
} as const;

/** Hours of light per day for a growth mode. Unknown (older firmware) runs the standard cycle. */
export const cycleOnSeconds = (growthMode: GrowthMode | null): number => (
  growthMode === 'fruit' ? FRUIT_CYCLE_ON_SECONDS : CYCLE_ON_SECONDS
);

export const isLightMode = (value: unknown): value is LightMode => (
  typeof value === 'string' && (LIGHT_MODES as readonly string[]).includes(value)
);

export const isGrowthMode = (value: unknown): value is GrowthMode => (
  typeof value === 'string' && (GROWTH_MODES as readonly string[]).includes(value)
);

export const lightModeCode = (mode: LightMode): string => LIGHT_MODE_CODES[mode];
export const growthModeCode = (mode: GrowthMode): string => GROWTH_MODE_CODES[mode];

const decodeFrom = <T extends string>(codes: Record<T, string>, operand: string): T | null => {
  const match = (Object.keys(codes) as T[]).find((key) => codes[key] === operand);
  return match ?? null;
};

export const decodeLightMode = (operand: string): LightMode | null => decodeFrom(LIGHT_MODE_CODES, operand);
export const decodeGrowthMode = (operand: string): GrowthMode | null => decodeFrom(GROWTH_MODE_CODES, operand);

export interface ParsedLine {
  verb: string;
  operand: string;
}

export const parseLine = (line: string): ParsedLine | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const space = trimmed.indexOf(' ');
  if (space < 0) return { verb: trimmed, operand: '' };
  return { verb: trimmed.slice(0, space), operand: trimmed.slice(space + 1).trim() };
};

export const isErrorLine = (line: string): boolean => line.startsWith('ERR');

/** Reassembles notification fragments into lines. */
export class LineFramer {
  private buffer = '';

  /** Returns complete non-empty lines. Drops the buffer if it grows past the cap. */
  push(data: Buffer): { lines: string[]; overflowed: boolean } {
    this.buffer += data.toString('latin1');
    if (this.buffer.length > FRAME_CAP_BYTES) {
      this.buffer = '';
      return { lines: [], overflowed: true };
    }
    const parts = this.buffer.split('\n');
    this.buffer = parts.pop() ?? '';
    const lines = parts.map((part) => part.trim()).filter((part) => part.length > 0);
    return { lines, overflowed: false };
  }

  reset(): void {
    this.buffer = '';
  }
}

export const encodeWallSeconds = (wallSeconds: number): string => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(Math.floor(wallSeconds));
  return Array.from(buf, (byte) => byte.toString(16).toUpperCase().padStart(2, '0')).join(' ');
};

/** Decodes the first four bytes. Clock reads answer twelve bytes; only the first four carry time. */
export const decodeWallSeconds = (operand: string): number | null => {
  const bytes = operand.split(/\s+/).filter(Boolean).slice(0, 4);
  if (bytes.length !== 4 || bytes.some((byte) => !/^[0-9A-Fa-f]{2}$/.test(byte))) return null;
  return Buffer.from(bytes.join(''), 'hex').readUInt32BE();
};

export const decodeFirmware = (operand: string): string | null => {
  const bytes = operand.split(/\s+/).filter(Boolean);
  if (bytes.length === 0 || bytes.some((byte) => !/^[0-9A-Fa-f]{2}$/.test(byte))) return null;
  return bytes.map((byte) => String(parseInt(byte, 16))).join('.');
};

/** Local wall-clock time in `timeZone`, as epoch seconds relabelled as UTC. */
export const wallSecondsAt = (instant: Date, timeZone: string): number => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  return Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second'),
  ) / 1000;
};

export const secondOfDay = (wallSeconds: number): number => (
  ((Math.floor(wallSeconds) % DAY_SECONDS) + DAY_SECONDS) % DAY_SECONDS
);

export const formatTimeOfDay = (seconds: number): string => {
  const sod = secondOfDay(seconds);
  const hours = Math.floor(sod / 3600);
  const minutes = Math.floor((sod % 3600) / 60);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

/** Parses `HH:mm` into seconds after midnight. */
export const parseTimeOfDay = (value: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 3600 + minutes * 60;
};

/** The next wall second at `startOfDay`, strictly after `nowWall`. */
export const nextOccurrence = (startOfDay: number, nowWall: number): number => {
  const midnight = nowWall - secondOfDay(nowWall);
  const today = midnight + startOfDay;
  return today > nowWall ? today : today + DAY_SECONDS;
};

export interface CycleWindow {
  /** True when the daily cycle has the light on right now. */
  lit: boolean;
  nextOn: number;
  nextOff: number;
}

export const cycleWindow = (
  startOfDay: number,
  nowWall: number,
  onSeconds: number = CYCLE_ON_SECONDS,
): CycleWindow => {
  const nextOn = nextOccurrence(startOfDay, nowWall);
  const lastOn = nextOn - DAY_SECONDS;
  const lastOff = lastOn + onSeconds;
  const lit = nowWall >= lastOn && nowWall < lastOff;
  return { lit, nextOn, nextOff: lit ? lastOff : nextOn + onSeconds };
};

/** Whether the light is physically on, given its mode and the daily cycle. */
export const isLit = (
  mode: LightMode,
  startOfDay: number | null,
  nowWall: number,
  onSeconds: number = CYCLE_ON_SECONDS,
): boolean | null => {
  if (mode === 'full' || mode === 'dim') return true;
  if (mode === 'off') return false;
  if (startOfDay === null) return null;
  return cycleWindow(startOfDay, nowWall, onSeconds).lit;
};
