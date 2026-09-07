import { describe, expect, it } from 'vitest';
import {
  normaliseFeedItem,
  parseFeedNumber,
  parseFeedTimestamp,
} from './forexFactory.js';
import { TRACKED_RELEASES, easternDateTime, easternOffsetMinutes } from './fred.js';

describe('parseFeedNumber', () => {
  it('parses a plain number', () => {
    expect(parseFeedNumber('55.2')).toEqual({ value: 55.2, unit: null });
  });

  it('parses a percentage and keeps the unit', () => {
    // '4.1%' and '4.1' are different facts; the UI must render what was published.
    expect(parseFeedNumber('4.1%')).toEqual({ value: 4.1, unit: '%' });
  });

  it('parses a negative value', () => {
    expect(parseFeedNumber('-2.0%')).toEqual({ value: -2, unit: '%' });
  });

  it('expands K/M/B suffixes', () => {
    expect(parseFeedNumber('213K').value).toBe(213_000);
    expect(parseFeedNumber('1.5M').value).toBe(1_500_000);
    expect(parseFeedNumber('2B').value).toBe(2_000_000_000);
  });

  it('strips thousands separators', () => {
    expect(parseFeedNumber('1,234.5').value).toBe(1234.5);
  });

  it('returns null for an empty value rather than zero', () => {
    // The critical case. A forecast of zero and no forecast at all are entirely
    // different claims; conflating them feeds a fabricated number into the surprise
    // calculation and violates the no-invented-data rule.
    expect(parseFeedNumber('')).toEqual({ value: null, unit: null });
    expect(parseFeedNumber('   ')).toEqual({ value: null, unit: null });
  });

  it('returns null for unparseable text rather than guessing', () => {
    expect(parseFeedNumber('n/a').value).toBeNull();
    expect(parseFeedNumber('Tentative').value).toBeNull();
  });

  it('parses a genuine zero as zero', () => {
    expect(parseFeedNumber('0.0%')).toEqual({ value: 0, unit: '%' });
  });
});

describe('parseFeedTimestamp — US Eastern offset', () => {
  it('parses the observed EDT format', () => {
    // Real sample from the live feed, 2026-08-30.
    const r = parseFeedTimestamp('2026-09-04T08:30:00-04:00');
    expect(r).not.toBeNull();
    // 08:30 EDT is 12:30 UTC.
    expect(r?.at.toISOString()).toBe('2026-09-04T12:30:00.000Z');
    expect(r?.localTime).toBe('08:30');
  });

  it('parses the winter EST format to a different UTC hour', () => {
    // The whole reason we do not hard-code an offset: the same wall-clock 08:30
    // release is an hour later in UTC once the US leaves daylight saving.
    const summer = parseFeedTimestamp('2026-07-10T08:30:00-04:00');
    const winter = parseFeedTimestamp('2026-12-10T08:30:00-05:00');
    expect(summer?.at.toISOString()).toBe('2026-07-10T12:30:00.000Z');
    expect(winter?.at.toISOString()).toBe('2026-12-10T13:30:00.000Z');
  });

  it('handles a UTC Z suffix', () => {
    expect(parseFeedTimestamp('2026-09-04T12:30:00Z')?.at.toISOString()).toBe(
      '2026-09-04T12:30:00.000Z',
    );
  });

  it('rejects a timestamp with no offset rather than guessing', () => {
    // Without an offset the value would be read in the *server's* local zone —
    // UTC on a serverless host, something else on a laptop. Silently wrong, and
    // wrong differently in each environment.
    expect(parseFeedTimestamp('2026-09-04T08:30:00')).toBeNull();
    expect(parseFeedTimestamp('2026-09-04')).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(parseFeedTimestamp('not a date')).toBeNull();
    expect(parseFeedTimestamp('')).toBeNull();
  });
});

describe('normaliseFeedItem — the Holiday impact value', () => {
  const base = {
    title: 'Bank Holiday',
    country: 'USD',
    date: '2026-09-07T00:00:00-04:00',
    impact: 'Holiday' as const,
    forecast: '',
    previous: '',
  };

  it('preserves a holiday as its own signal rather than dropping it', () => {
    // A fourth value the vocabulary did not have. Dropping the row would lose the
    // fact that the market is shut — real context for thin volume.
    const r = normaliseFeedItem(base);
    expect(r).not.toBeNull();
    expect(r?.isHoliday).toBe(true);
    expect(r?.eventName).toBe('Bank Holiday');
  });

  it('files a holiday as LOW importance, not as a high-impact event', () => {
    // It is not an impact level at all; LOW keeps it out of event-risk warnings
    // while the isHoliday flag keeps the information.
    expect(normaliseFeedItem(base)?.importanceHint).toBe('LOW');
  });

  it('leaves a holiday with no numeric values', () => {
    const r = normaliseFeedItem(base);
    expect(r?.forecast).toBeNull();
    expect(r?.previous).toBeNull();
    expect(r?.actual).toBeNull();
  });

  it('does not mark ordinary releases as holidays', () => {
    const r = normaliseFeedItem({
      title: 'Non-Farm Employment Change',
      country: 'USD',
      date: '2026-09-04T08:30:00-04:00',
      impact: 'High',
      forecast: '213K',
      previous: '187K',
    });
    expect(r?.isHoliday).toBe(false);
    expect(r?.importanceHint).toBe('HIGH');
    expect(r?.forecast).toBe(213_000);
  });

  it('maps each feed impact to our vocabulary', () => {
    const at = (impact: 'High' | 'Medium' | 'Low' | 'Holiday') =>
      normaliseFeedItem({ ...base, impact })?.importanceHint;
    expect(at('High')).toBe('HIGH');
    expect(at('Medium')).toBe('MEDIUM');
    expect(at('Low')).toBe('LOW');
    expect(at('Holiday')).toBe('LOW');
  });

  it('drops an item whose timestamp cannot be trusted', () => {
    expect(normaliseFeedItem({ ...base, date: '2026-09-07 00:00:00' })).toBeNull();
  });

  it('records the currency and country from the feed field', () => {
    const r = normaliseFeedItem({ ...base, country: 'EUR' });
    expect(r?.currency).toBe('EUR');
    expect(r?.country).toBe('EUR');
  });
});

describe('easternOffsetMinutes — real DST, not a fixed offset', () => {
  it('returns -240 (EDT) in summer', () => {
    expect(easternOffsetMinutes(new Date('2026-07-15T12:00:00Z'))).toBe(-240);
  });

  it('returns -300 (EST) in winter', () => {
    expect(easternOffsetMinutes(new Date('2026-01-15T12:00:00Z'))).toBe(-300);
  });

  it('changes across the spring transition', () => {
    // US DST begins on the second Sunday in March.
    const before = easternOffsetMinutes(new Date('2026-03-01T12:00:00Z'));
    const after = easternOffsetMinutes(new Date('2026-04-01T12:00:00Z'));
    expect(before).toBe(-300);
    expect(after).toBe(-240);
  });

  it('changes across the autumn transition', () => {
    expect(easternOffsetMinutes(new Date('2026-10-15T12:00:00Z'))).toBe(-240);
    expect(easternOffsetMinutes(new Date('2026-12-01T12:00:00Z'))).toBe(-300);
  });
});

describe('easternDateTime — FRED dates plus a customary time', () => {
  it('places an 08:30 release correctly in summer', () => {
    expect(easternDateTime('2026-09-11', '08:30')?.toISOString()).toBe(
      '2026-09-11T12:30:00.000Z',
    );
  });

  it('places the same release an hour later in UTC in winter', () => {
    // The bug this prevents: a fixed -04:00 would put a December FOMC an hour early,
    // firing event-risk warnings at the wrong time for four months of the year.
    expect(easternDateTime('2026-12-10', '08:30')?.toISOString()).toBe(
      '2026-12-10T13:30:00.000Z',
    );
  });

  it('places an FOMC 14:00 decision correctly in both seasons', () => {
    expect(easternDateTime('2026-07-29', '14:00')?.toISOString()).toBe(
      '2026-07-29T18:00:00.000Z',
    );
    expect(easternDateTime('2026-12-16', '14:00')?.toISOString()).toBe(
      '2026-12-16T19:00:00.000Z',
    );
  });

  it('returns null for a malformed time', () => {
    expect(easternDateTime('2026-09-11', 'noon')).toBeNull();
    expect(easternDateTime('not-a-date', '08:30')).toBeNull();
  });
});

describe('tracked releases', () => {
  it('covers the releases that actually move gold', () => {
    const names = TRACKED_RELEASES.map((r) => r.name);
    expect(names).toContain('Consumer Price Index');
    expect(names).toContain('Employment Situation');
    expect(names).toContain('FOMC Press Release');
  });

  it('gives every tracked release a customary time', () => {
    // Without one, a FRED date has no hour and cannot produce an event-risk window.
    for (const r of TRACKED_RELEASES) {
      expect(r.customaryEasternTime).toMatch(/^\d{2}:\d{2}$/);
    }
  });

  it('excludes continuously-updated data products from calendar events', () => {
    // FRED emits a date every day for these, which would put a phantom FOMC meeting
    // on the calendar daily and fire event-risk warnings every single day.
    const byName = new Map(TRACKED_RELEASES.map((r) => [r.name, r.emitsCalendarEvents]));
    expect(byName.get('FOMC Press Release')).toBe(false);
    expect(byName.get('H.15 Selected Interest Rates')).toBe(false);
    expect(byName.get('H.10 Foreign Exchange Rates')).toBe(false);
    expect(byName.get('Consumer Price Index')).toBe(true);
    expect(byName.get('Employment Situation')).toBe(true);
  });

  it('has no duplicate release ids', () => {
    const ids = TRACKED_RELEASES.map((r) => r.releaseId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
