import { describe, expect, it } from 'vitest';
import {
  LineFramer,
  cycleOnSeconds,
  cycleWindow,
  decodeFirmware,
  decodeGrowthMode,
  decodeLightMode,
  decodeWallSeconds,
  encodeWallSeconds,
  formatTimeOfDay,
  isLit,
  nextOccurrence,
  parseLine,
  parseTimeOfDay,
  wallSecondsAt,
} from '../lib/protocol';

const wall = (iso: string) => Date.parse(`${iso}Z`) / 1000;
const hm = (h: number, m = 0) => h * 3600 + m * 60;

describe('protocol encoding', () => {
  it('round-trips wall-clock timestamps as four hex bytes', () => {
    const seconds = wall('2026-11-14T07:00:00');
    const operand = encodeWallSeconds(seconds);
    expect(operand).toMatch(/^([0-9A-F]{2} ){3}[0-9A-F]{2}$/);
    expect(decodeWallSeconds(operand)).toBe(seconds);
  });

  it('reads the clock from the first four bytes of a padded answer', () => {
    const operand = `${encodeWallSeconds(1000)} 00 00 00 00 00 00 00 00`;
    expect(decodeWallSeconds(operand)).toBe(1000);
  });

  it('rejects malformed timestamps', () => {
    expect(decodeWallSeconds('01 02')).toBeNull();
    expect(decodeWallSeconds('ZZ 00 00 00')).toBeNull();
  });

  it('decodes light and growth modes and ignores unknown codes', () => {
    expect(decodeLightMode('00')).toBe('auto');
    expect(decodeLightMode('03')).toBe('off');
    expect(decodeLightMode('09')).toBeNull();
    expect(decodeGrowthMode('01')).toBe('fruit');
    expect(decodeGrowthMode('07')).toBeNull();
  });

  it('formats firmware bytes as a dotted version', () => {
    expect(decodeFirmware('01 00 0A')).toBe('1.0.10');
    expect(decodeFirmware('')).toBeNull();
  });

  it('splits lines into verb and operand', () => {
    expect(parseLine('LC_STATE 01')).toEqual({ verb: 'LC_STATE', operand: '01' });
    expect(parseLine('TIME 00 00 00 01')).toEqual({ verb: 'TIME', operand: '00 00 00 01' });
    expect(parseLine('OK')).toEqual({ verb: 'OK', operand: '' });
    expect(parseLine('  ')).toBeNull();
  });
});

describe('line framing', () => {
  it('joins fragments split across notifications', () => {
    const framer = new LineFramer();
    expect(framer.push(Buffer.from('LC_ST')).lines).toEqual([]);
    expect(framer.push(Buffer.from('ATE 01\nMODE 0')).lines).toEqual(['LC_STATE 01']);
    expect(framer.push(Buffer.from('2\r\n\n')).lines).toEqual(['MODE 02']);
  });

  it('drops runaway data without a newline', () => {
    const framer = new LineFramer();
    expect(framer.push(Buffer.alloc(5000, 0x41)).overflowed).toBe(true);
    expect(framer.push(Buffer.from('MODE 00\n')).lines).toEqual(['MODE 00']);
  });
});

describe('time of day', () => {
  it('parses and formats HH:mm', () => {
    expect(parseTimeOfDay('7:05')).toBe(hm(7, 5));
    expect(parseTimeOfDay('24:00')).toBeNull();
    expect(parseTimeOfDay('noon')).toBeNull();
    expect(formatTimeOfDay(hm(23, 59))).toBe('23:59');
    expect(formatTimeOfDay(wall('2026-11-14T06:30:00'))).toBe('06:30');
  });

  it('converts an instant to local wall clock', () => {
    const instant = new Date('2026-07-01T10:00:00Z');
    expect(wallSecondsAt(instant, 'Europe/Oslo')).toBe(wall('2026-07-01T12:00:00'));
    expect(wallSecondsAt(instant, 'UTC')).toBe(wall('2026-07-01T10:00:00'));
  });

  it('finds the next occurrence strictly after now', () => {
    const now = wall('2026-11-14T07:00:00');
    expect(nextOccurrence(hm(8), now)).toBe(wall('2026-11-14T08:00:00'));
    expect(nextOccurrence(hm(7), now)).toBe(wall('2026-11-15T07:00:00'));
  });
});

describe('daily cycle', () => {
  const start = hm(7);

  it('is lit for sixteen hours from the start time', () => {
    const at = (iso: string) => cycleWindow(start, wall(iso));
    expect(at('2026-11-14T07:00:00')).toEqual({
      lit: true, nextOn: wall('2026-11-15T07:00:00'), nextOff: wall('2026-11-14T23:00:00'),
    });
    expect(at('2026-11-14T22:59:00').lit).toBe(true);
    expect(at('2026-11-14T23:00:00')).toEqual({
      lit: false, nextOn: wall('2026-11-15T07:00:00'), nextOff: wall('2026-11-15T23:00:00'),
    });
    expect(at('2026-11-14T03:00:00').lit).toBe(false);
  });

  it('handles a window that spans midnight', () => {
    const evening = hm(20);
    expect(cycleWindow(evening, wall('2026-11-14T02:00:00'))).toEqual({
      lit: true, nextOn: wall('2026-11-14T20:00:00'), nextOff: wall('2026-11-14T12:00:00'),
    });
    expect(cycleWindow(evening, wall('2026-11-14T13:00:00')).lit).toBe(false);
  });

  it('derives physical light state from the mode', () => {
    const night = wall('2026-11-14T03:00:00');
    expect(isLit('full', start, night)).toBe(true);
    expect(isLit('dim', null, night)).toBe(true);
    expect(isLit('off', start, wall('2026-11-14T12:00:00'))).toBe(false);
    expect(isLit('auto', start, night)).toBe(false);
    expect(isLit('auto', null, night)).toBeNull();
  });

  it('keeps the light on for twenty hours in Fruit & veggies', () => {
    const fruit = cycleOnSeconds('fruit');
    expect(cycleOnSeconds('herbs')).toBe(16 * 3600);
    expect(cycleOnSeconds('slow')).toBe(16 * 3600);
    expect(cycleOnSeconds(null)).toBe(16 * 3600);
    expect(cycleWindow(start, wall('2026-11-14T23:30:00'), fruit)).toEqual({
      lit: true, nextOn: wall('2026-11-15T07:00:00'), nextOff: wall('2026-11-15T03:00:00'),
    });
    expect(cycleWindow(start, wall('2026-11-15T03:00:00'), fruit).lit).toBe(false);
    expect(isLit('auto', start, wall('2026-11-15T02:00:00'), fruit)).toBe(true);
  });
});
