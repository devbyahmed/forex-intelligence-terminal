import { describe, expect, it } from 'vitest';
import { isGoldMarketOpen } from './ingestMarket.js';
import { parseTwelveDataTime } from '@forex-agent/providers';
import { validateMacroPoint } from '@forex-agent/providers';
import type { MacroPoint } from '@forex-agent/providers';

describe('isGoldMarketOpen', () => {
  // Gold trades roughly Sunday 22:00 UTC to Friday 22:00 UTC. Polling outside that
  // only burns provider credits to re-store a price that has not moved.
  it('is closed all day Saturday', () => {
    expect(isGoldMarketOpen(new Date('2026-08-29T12:00:00Z'))).toBe(false);
    expect(isGoldMarketOpen(new Date('2026-08-29T23:00:00Z'))).toBe(false);
  });

  it('opens Sunday at 22:00 UTC', () => {
    expect(isGoldMarketOpen(new Date('2026-08-30T21:59:00Z'))).toBe(false);
    expect(isGoldMarketOpen(new Date('2026-08-30T22:00:00Z'))).toBe(true);
  });

  it('closes Friday at 22:00 UTC', () => {
    expect(isGoldMarketOpen(new Date('2026-09-04T21:59:00Z'))).toBe(true);
    expect(isGoldMarketOpen(new Date('2026-09-04T22:00:00Z'))).toBe(false);
  });

  it('is open through the midweek', () => {
    for (const day of ['2026-09-01', '2026-09-02', '2026-09-03']) {
      expect(isGoldMarketOpen(new Date(`${day}T03:00:00Z`))).toBe(true);
      expect(isGoldMarketOpen(new Date(`${day}T20:00:00Z`))).toBe(true);
    }
  });
});

describe('parseTwelveDataTime', () => {
  it('reads a daily bar as UTC midnight', () => {
    expect(parseTwelveDataTime('2026-08-28')?.toISOString()).toBe('2026-08-28T00:00:00.000Z');
  });

  it('reads an intraday bar as UTC', () => {
    // Their datetimes carry no zone marker. Stating UTC explicitly beats letting
    // Date.parse fall back to the server's local zone, which would put the same bar
    // at different instants on Vercel and on a laptop.
    expect(parseTwelveDataTime('2026-08-28 14:30:00')?.toISOString()).toBe(
      '2026-08-28T14:30:00.000Z',
    );
  });

  it('returns null on malformed input rather than an invalid Date', () => {
    expect(parseTwelveDataTime('not a date')).toBeNull();
    expect(parseTwelveDataTime('')).toBeNull();
  });
});

describe('validateMacroPoint', () => {
  const point = (o: Partial<MacroPoint>): MacroPoint => ({
    seriesId: 'DGS10',
    observationDate: '2026-08-27',
    value: 4.67,
    vintage: new Date('2026-08-28T00:00:00Z'),
    ...o,
  });

  it('accepts a plausible value', () => {
    expect(validateMacroPoint(point({}))).toHaveLength(0);
  });

  it('flags a value outside the plausible range', () => {
    // A 10-year yield of 400% means the provider changed units or returned an error
    // payload that happened to parse.
    expect(validateMacroPoint(point({ value: 400 }))).toContain('IMPOSSIBLE_VALUE');
    expect(validateMacroPoint(point({ value: -50 }))).toContain('IMPOSSIBLE_VALUE');
  });

  it('flags an implausible overnight move', () => {
    const previous = point({ observationDate: '2026-08-26', value: 4.6 });
    expect(validateMacroPoint(point({ value: 9.2 }), previous)).toContain('ANOMALY');
  });

  it('accepts a normal daily move', () => {
    const previous = point({ observationDate: '2026-08-26', value: 4.6 });
    expect(validateMacroPoint(point({ value: 4.67 }), previous)).toHaveLength(0);
  });

  it('flags a revision when the period repeats', () => {
    // Two rows for the same period at different vintages is exactly a revision —
    // real and material: June payrolls moved 158,984 to 158,881.
    const first = point({ seriesId: 'PAYEMS', observationDate: '2026-06-01', value: 158_984 });
    const revised = point({ seriesId: 'PAYEMS', observationDate: '2026-06-01', value: 158_881 });
    expect(validateMacroPoint(revised, first)).toContain('REVISED');
  });

  it('does not flag a null value as impossible', () => {
    // FRED writes '.' for a period that exists with no figure. That is a real
    // absence; range-checking it or comparing it to zero would flag every
    // legitimate gap as an anomaly.
    const flags = validateMacroPoint(point({ value: null }));
    expect(flags).not.toContain('IMPOSSIBLE_VALUE');
    expect(flags).not.toContain('ANOMALY');
  });

  it('still detects a revision when the value is null', () => {
    const first = point({ observationDate: '2026-08-27', value: 4.6 });
    expect(validateMacroPoint(point({ value: null }), first)).toContain('REVISED');
  });

  it('does not compare against a null previous value', () => {
    const previous = point({ observationDate: '2026-08-26', value: null });
    expect(validateMacroPoint(point({ value: 4.67 }), previous)).not.toContain('ANOMALY');
  });

  it('applies the right range per series', () => {
    // Payrolls are in thousands of persons; a yield range would reject every value.
    expect(validateMacroPoint(point({ seriesId: 'PAYEMS', value: 158_881 }))).toHaveLength(0);
    expect(validateMacroPoint(point({ seriesId: 'UNRATE', value: 4.1 }))).toHaveLength(0);
    expect(validateMacroPoint(point({ seriesId: 'VIXCLS', value: 14.5 }))).toHaveLength(0);
  });

  it('has no opinion on a series it does not know', () => {
    // Better to store an unrecognised series unflagged than to invent a range for it.
    expect(
      validateMacroPoint(point({ seriesId: 'UNKNOWN' as MacroPoint['seriesId'], value: 1e9 })),
    ).toHaveLength(0);
  });
});
