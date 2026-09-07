/**
 * Day boundaries in a named zone.
 *
 * The cases that matter are the ones a UTC slice gets wrong: evenings after the zone's
 * UTC offset has rolled the date over, and the two days a year when the offset changes.
 * A test suite that only checked midday would pass against `runAt.slice(0, 10)`.
 */

import { describe, expect, it } from 'vitest';
import { assertValidTimeZone, civilDateIn, zoneOffsetMinutes, zonedDayBounds } from './timeZone.js';

const ET = 'America/New_York';

describe('zoneOffsetMinutes', () => {
  it('reads standard and daylight offsets from the same zone', () => {
    // The reason the offset is a function of the instant rather than of the zone.
    expect(zoneOffsetMinutes(new Date('2026-01-15T12:00:00Z'), ET)).toBe(-300);
    expect(zoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), ET)).toBe(-240);
  });

  it('reads a zero offset', () => {
    // Formatted as bare 'GMT' by some runtimes, which the pattern has to accept.
    expect(zoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'UTC')).toBe(0);
  });

  it('reads a half-hour offset', () => {
    expect(zoneOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'Asia/Kolkata')).toBe(330);
  });

  it('throws rather than assuming an offset for an unknown zone', () => {
    // A silent fallback would date reports a day out with nothing to signal it.
    expect(() => zoneOffsetMinutes(new Date(), 'Mars/Olympus_Mons')).toThrow();
  });
});

describe('assertValidTimeZone', () => {
  it('accepts real zones', () => {
    expect(() => { assertValidTimeZone(ET); }).not.toThrow();
    expect(() => { assertValidTimeZone('UTC'); }).not.toThrow();
  });

  it('rejects a zone this runtime does not know', () => {
    expect(() => { assertValidTimeZone('America/Nueva_York'); }).toThrow(/not a time zone/);
  });

  it('rejects a value with surrounding whitespace', () => {
    /*
     * The realistic failure: a zone pasted into an environment file with a trailing
     * space or a carriage return. Verified — ICU throws on it, so the guard catches
     * it, and `REPORT_TIMEZONE` is trimmed before it ever gets here.
     */
    expect(() => { assertValidTimeZone('America/New_York '); }).toThrow(/not a time zone/);
  });

  it('tolerates case, because IANA names are case-insensitive', () => {
    /*
     * Not a silent fallback — verified against this runtime, 'America/New_york'
     * resolves to America/New_York and reports the same offset. Asserting it here so
     * nobody later adds a case check believing it prevents a real mistake.
     */
    expect(() => { assertValidTimeZone('America/New_york'); }).not.toThrow();
    const at = new Date('2026-07-15T12:00:00Z');
    expect(zoneOffsetMinutes(at, 'America/New_york')).toBe(zoneOffsetMinutes(at, ET));
  });
});

describe('civilDateIn', () => {
  it('dates an evening run by the local day, not the UTC one', () => {
    /*
     * 20:30 ET on 6 September is 00:30 UTC on 7 September. This is the case that
     * motivated the whole module: the run describes Sunday and UTC would file it as
     * Monday.
     */
    const at = new Date('2026-09-07T00:30:00Z');
    expect(at.toISOString().slice(0, 10)).toBe('2026-09-07');
    expect(civilDateIn(at, ET)).toBe('2026-09-06');
  });

  it('agrees with a UTC slice when the zone is UTC', () => {
    expect(civilDateIn(new Date('2026-09-06T09:15:00Z'), 'UTC')).toBe('2026-09-06');
  });

  it('dates a morning run in a zone ahead of UTC by the local day', () => {
    // 06:00 UTC is already the 7th in Tokyo. Symmetry check: the module must not be
    // quietly assuming a western offset.
    expect(civilDateIn(new Date('2026-09-06T22:00:00Z'), 'Asia/Tokyo')).toBe('2026-09-07');
  });
});

describe('zonedDayBounds', () => {
  it('bounds an ordinary Eastern day at 04:00 and 04:00 UTC', () => {
    const { start, end } = zonedDayBounds('2026-09-06', ET);
    expect(start.toISOString()).toBe('2026-09-06T04:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-07T04:00:00.000Z');
  });

  it('bounds a winter Eastern day at 05:00 UTC', () => {
    const { start, end } = zonedDayBounds('2026-01-15', ET);
    expect(start.toISOString()).toBe('2026-01-15T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-01-16T05:00:00.000Z');
  });

  it('gives the spring-forward day 23 hours', () => {
    // 8 March 2026: clocks go forward at 02:00 ET. A day-length assumption of exactly
    // 86,400,000 ms would put the boundary an hour into the next day.
    const { start, end } = zonedDayBounds('2026-03-08', ET);
    expect(end.getTime() - start.getTime()).toBe(23 * 3_600_000);
    expect(start.toISOString()).toBe('2026-03-08T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-03-09T04:00:00.000Z');
  });

  it('gives the fall-back day 25 hours', () => {
    // 1 November 2026: clocks go back at 02:00 ET.
    const { start, end } = zonedDayBounds('2026-11-01', ET);
    expect(end.getTime() - start.getTime()).toBe(25 * 3_600_000);
  });

  it('tiles the timeline: consecutive days meet exactly, with no gap or overlap', () => {
    /*
     * The property the half-open interval exists for. If two adjacent days overlapped,
     * one analysis would belong to both and the report job could pick either.
     */
    for (const [a, b] of [
      ['2026-03-07', '2026-03-08'],
      ['2026-03-08', '2026-03-09'],
      ['2026-10-31', '2026-11-01'],
      ['2026-11-01', '2026-11-02'],
      ['2026-12-31', '2027-01-01'],
    ] as const) {
      expect(zonedDayBounds(a, ET).end.getTime()).toBe(zonedDayBounds(b, ET).start.getTime());
    }
  });

  it('brackets the civil date it names, at both edges', () => {
    // The round trip that makes the two functions one rule rather than two.
    for (const date of ['2026-03-08', '2026-09-06', '2026-11-01', '2026-01-15']) {
      const { start, end } = zonedDayBounds(date, ET);
      expect(civilDateIn(start, ET)).toBe(date);
      expect(civilDateIn(new Date(end.getTime() - 1), ET)).toBe(date);
      expect(civilDateIn(end, ET)).not.toBe(date);
    }
  });

  it('rejects a malformed date', () => {
    expect(() => zonedDayBounds('06-09-2026', ET)).toThrow();
  });
});
