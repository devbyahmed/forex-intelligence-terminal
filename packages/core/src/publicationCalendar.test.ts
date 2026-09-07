/**
 * Publication-calendar freshness.
 *
 * Every scenario here is one of the twelve V1 series, with the calendar and the
 * publication time taken from the 2026-08-30 audit of FRED first-release dates
 * rather than invented. The dates are real: 2026-08-28 is a Friday, 2026-08-30 a
 * Sunday, 2026-08-31 a Monday.
 */

import { describe, expect, it } from 'vitest';
import {
  BUSINESS_DAYS,
  FactTimingError,
  assertValidPublicationDays,
  assessFreshness,
  assessFreshnessOnCalendar,
  publicationDaysElapsed,
  publishedTiming,
} from './factTiming.js';
import type { FreshnessThresholds } from './freshness.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The shipped `dailyMacro` thresholds, read in publication-day time. */
const DAILY: FreshnessThresholds = {
  liveMs: 24 * HOUR,
  recentMs: 72 * HOUR,
  staleBeyondMs: 7 * DAY,
  maxRetrievalAgeMs: 6 * HOUR,
};

/** The shipped `weeklyMacro` thresholds: one, two and four missed releases. */
const WEEKLY: FreshnessThresholds = {
  liveMs: 24 * HOUR,
  recentMs: 48 * HOUR,
  staleBeyondMs: 96 * HOUR,
  maxRetrievalAgeMs: 12 * HOUR,
};

/** The shipped `monthlyMacro` thresholds, in publication (business) days. */
const MONTHLY: FreshnessThresholds = {
  liveMs: 22 * DAY,
  recentMs: 30 * DAY,
  staleBeyondMs: 45 * DAY,
  maxRetrievalAgeMs: 24 * HOUR,
};

describe('publicationDaysElapsed', () => {
  it('does not advance across a weekend for a business-day source', () => {
    // Friday 20:16 UTC is when H.15 lands (15:16 US Central, observed).
    const friday = new Date('2026-08-28T20:16:00Z');
    const sunday = new Date('2026-08-30T12:00:00Z');
    // Only the tail of Friday counts; Saturday and Sunday contribute nothing.
    expect(publicationDaysElapsed(friday, sunday, BUSINESS_DAYS)).toBeCloseTo(3.73 / 24, 2);
  });

  it('counts wall-clock days when every day publishes', () => {
    const from = new Date('2026-08-28T00:00:00Z');
    const to = new Date('2026-08-31T00:00:00Z');
    expect(publicationDaysElapsed(from, to, [0, 1, 2, 3, 4, 5, 6])).toBeCloseTo(3, 6);
  });

  it('counts a full business week as five', () => {
    // Monday 00:00 to the following Monday 00:00 spans exactly five business days.
    const from = new Date('2026-08-24T00:00:00Z');
    const to = new Date('2026-08-31T00:00:00Z');
    expect(publicationDaysElapsed(from, to, BUSINESS_DAYS)).toBeCloseTo(5, 6);
  });

  it('counts one publication day per week for a single-weekday source', () => {
    // ICSA publishes Thursdays. Three weeks is three publication days, not 21.
    const from = new Date('2026-08-06T00:00:00Z'); // Thursday
    const to = new Date('2026-08-27T00:00:00Z'); // Thursday, three weeks later
    expect(publicationDaysElapsed(from, to, [4])).toBeCloseTo(3, 6);
  });

  it('is zero when the window is empty or inverted', () => {
    const t = new Date('2026-08-28T12:00:00Z');
    expect(publicationDaysElapsed(t, t, BUSINESS_DAYS)).toBe(0);
    expect(publicationDaysElapsed(t, new Date('2026-08-27T12:00:00Z'), BUSINESS_DAYS)).toBe(0);
  });

  it('rejects a calendar that can never publish', () => {
    // An empty calendar would freeze age at zero forever, making everything look
    // permanently LIVE — the failure mode is silent, so it must not be expressible.
    expect(() => assertValidPublicationDays([])).toThrow(FactTimingError);
    expect(() => assertValidPublicationDays([1, 1])).toThrow(FactTimingError);
    expect(() => assertValidPublicationDays([7])).toThrow(FactTimingError);
    expect(() => assertValidPublicationDays([-1])).toThrow(FactTimingError);
  });
});

describe('assessFreshnessOnCalendar — the weekend distortion', () => {
  const dgs10 = publishedTiming({
    publishedAt: new Date('2026-08-28T20:16:00Z'), // Friday release
    describesPeriod: '2026-08-27',
    retrievedAt: new Date('2026-08-30T11:00:00Z'),
  });

  it('is the case that motivated the column: LIVE on Sunday, not RECENT', () => {
    const sunday = new Date('2026-08-30T12:00:00Z');

    // Wall clock: 39.7 hours old, so the Friday yield reads RECENT and takes a
    // 0.85 confidence multiplier for no reason a market participant would accept.
    expect(assessFreshness(dgs10, DAILY, sunday).status).toBe('RECENT');

    // Publication calendar: nothing was due, so nothing is late.
    const r = assessFreshnessOnCalendar(dgs10, DAILY, sunday, BUSINESS_DAYS);
    expect(r.status).toBe('LIVE');
    expect(r.calendarAdjusted).toBe(true);
  });

  it('reports the wall-clock age alongside, so the chip stays explainable', () => {
    const sunday = new Date('2026-08-30T12:00:00Z');
    const r = assessFreshnessOnCalendar(dgs10, DAILY, sunday, BUSINESS_DAYS);
    // The honest age is still 39.7 hours; only the status is calendar-relative.
    expect(r.sourceAgeMs).toBeCloseTo(39.73 * HOUR, -5);
    expect(r.effectiveAgeMs).toBeLessThan(4 * HOUR);
  });

  it('still degrades once a release is genuinely missed', () => {
    // Monday 21:00 UTC — the 20:16 release did not arrive.
    const mondayEvening = new Date('2026-08-31T21:00:00Z');
    const r = assessFreshnessOnCalendar(dgs10, DAILY, mondayEvening, BUSINESS_DAYS);
    expect(r.publicationDaysElapsed).toBeGreaterThan(1);
    expect(r.status).toBe('RECENT');
  });

  it('reaches STALE after a week of missed business-day releases', () => {
    const weekLater = new Date('2026-09-08T12:00:00Z');
    const r = assessFreshnessOnCalendar(dgs10, DAILY, weekLater, BUSINESS_DAYS);
    expect(r.status).toBe('STALE');
  });

  it('does not rescue a fact dated in the future', () => {
    // Clock skew or a provider bug must not be laundered into freshness by a
    // calendar that happens to skip the intervening days.
    const skewed = publishedTiming({
      publishedAt: new Date('2026-09-10T00:00:00Z'),
      describesPeriod: '2026-09-09',
      retrievedAt: new Date('2026-08-30T11:00:00Z'),
    });
    const r = assessFreshnessOnCalendar(
      skewed,
      DAILY,
      new Date('2026-08-30T12:00:00Z'),
      BUSINESS_DAYS,
    );
    expect(r.status).toBe('UNAVAILABLE');
    expect(r.calendarAdjusted).toBe(false);
  });

  it('keeps verificationOverdue on the wall clock', () => {
    // Whether our worker has run is a fact about us, not about the publisher's
    // calendar. A worker that died on Friday is just as dead on Sunday.
    const sunday = new Date('2026-08-30T23:00:00Z');
    const r = assessFreshnessOnCalendar(dgs10, DAILY, sunday, BUSINESS_DAYS);
    expect(r.status).toBe('LIVE');
    expect(r.verificationOverdue).toBe(true);
  });
});

describe('assessFreshnessOnCalendar — DTWEXBGS, weekly publication of a daily series', () => {
  // Observed: released in a Monday batch 75 times in 80, median lag 5 days.
  const timing = publishedTiming({
    publishedAt: new Date('2026-08-24T20:16:00Z'), // Monday
    describesPeriod: '2026-08-21', // Friday — the 3-day lag F1 must disclose
    retrievedAt: new Date('2026-08-30T11:00:00Z'),
  });

  it('stays LIVE all week, because no release is due until Monday', () => {
    for (const day of ['2026-08-26', '2026-08-28', '2026-08-30']) {
      const r = assessFreshnessOnCalendar(timing, WEEKLY, new Date(`${day}T12:00:00Z`), [1]);
      expect(r.status).toBe('LIVE');
    }
  });

  it('degrades the evening the Monday release fails to arrive', () => {
    const r = assessFreshnessOnCalendar(timing, WEEKLY, new Date('2026-08-31T21:00:00Z'), [1]);
    expect(r.status).toBe('RECENT');
  });

  it('would have been read as seven WEEKS live under wall-clock weekly thresholds', () => {
    // This is why the weekly thresholds had to change with the calendar. The old
    // liveMs of 7 days, read in publication time where one day is one week, would
    // have kept a seven-week-old dollar index LIVE.
    const sevenWeeks = new Date('2026-10-12T12:00:00Z');
    const oldWallClockWeekly: FreshnessThresholds = {
      liveMs: 7 * DAY,
      recentMs: 14 * DAY,
      staleBeyondMs: 30 * DAY,
      maxRetrievalAgeMs: 12 * HOUR,
    };
    expect(
      assessFreshnessOnCalendar(timing, oldWallClockWeekly, sevenWeeks, [1]).status,
    ).toBe('LIVE');
    // The shipped thresholds call it what it is.
    expect(assessFreshnessOnCalendar(timing, WEEKLY, sevenWeeks, [1]).status).toBe('UNAVAILABLE');
  });

  it('does not abstain under normal conditions — F1 must produce a value', () => {
    // PRD_V1 §8.5.2a. F1 carries weight 0.18; it went STALE at half weight for two
    // phases because of a cadence mismatch, and UNAVAILABLE here would zero it.
    const normalReadTimes = [
      '2026-08-24T21:00:00Z', // minutes after the release
      '2026-08-27T09:00:00Z', // midweek
      '2026-08-30T18:00:00Z', // Sunday, before the next Monday batch
      '2026-08-31T14:00:00Z', // Monday morning, release not yet out
    ];
    for (const t of normalReadTimes) {
      const r = assessFreshnessOnCalendar(timing, WEEKLY, new Date(t), [1]);
      expect(r.status).toBe('LIVE');
    }
  });
});

describe('assessFreshnessOnCalendar — ICSA, genuinely weekly on Thursdays', () => {
  // Observed: Thursday 48 of 51, week-ending-Saturday observations, 7-day gaps.
  const timing = publishedTiming({
    publishedAt: new Date('2026-08-27T12:34:00Z'), // Thursday
    describesPeriod: '2026-08-22', // the week ending Saturday
    retrievedAt: new Date('2026-08-30T11:00:00Z'),
  });

  it('is LIVE through the following week', () => {
    const r = assessFreshnessOnCalendar(timing, WEEKLY, new Date('2026-09-02T12:00:00Z'), [4]);
    expect(r.status).toBe('LIVE');
  });

  // The ladder below is the whole point of the weekly thresholds: one missed
  // release is a delay, two is a problem, four is no longer evidence of anything.
  it('reads RECENT after one missed Thursday', () => {
    const r = assessFreshnessOnCalendar(timing, WEEKLY, new Date('2026-09-03T20:00:00Z'), [4]);
    expect(r.publicationDaysElapsed).toBeCloseTo(1.31, 1);
    expect(r.status).toBe('RECENT');
  });

  it('reads STALE after two missed Thursdays', () => {
    const r = assessFreshnessOnCalendar(timing, WEEKLY, new Date('2026-09-10T20:00:00Z'), [4]);
    expect(r.publicationDaysElapsed).toBeCloseTo(2.31, 1);
    expect(r.status).toBe('STALE');
  });

  it('reads UNAVAILABLE after four missed Thursdays', () => {
    const r = assessFreshnessOnCalendar(timing, WEEKLY, new Date('2026-10-01T20:00:00Z'), [4]);
    expect(r.status).toBe('UNAVAILABLE');
  });
});

describe('assessFreshnessOnCalendar — monthly series stay current between prints', () => {
  // July CPI, first published Wednesday 12 August (median lag 43 days, observed).
  const cpi = publishedTiming({
    publishedAt: new Date('2026-08-12T12:30:00Z'),
    describesPeriod: '2026-07-01',
    retrievedAt: new Date('2026-08-30T11:00:00Z'),
  });

  it('is LIVE, not stale, because it is the current CPI', () => {
    // The mistake this replaces measured age from the observation period, making a
    // perfectly current print look two months old.
    const r = assessFreshnessOnCalendar(cpi, MONTHLY, new Date('2026-08-30T12:00:00Z'), BUSINESS_DAYS);
    expect(r.publicationDaysElapsed).toBeCloseTo(12.5, 0);
    expect(r.status).toBe('LIVE');
  });

  it('stays LIVE right up to the next scheduled print', () => {
    // Prints run ~21 business days apart; August CPI is due around 10 September.
    const r = assessFreshnessOnCalendar(cpi, MONTHLY, new Date('2026-09-10T12:00:00Z'), BUSINESS_DAYS);
    expect(r.status).toBe('LIVE');
  });

  it('degrades once a print has actually been missed', () => {
    // ~27 business days after the July print, with no August print: a week overdue.
    const r = assessFreshnessOnCalendar(cpi, MONTHLY, new Date('2026-09-18T12:00:00Z'), BUSINESS_DAYS);
    expect(r.publicationDaysElapsed).toBeCloseTo(27, 0);
    expect(r.status).toBe('RECENT');
  });

  it('reads STALE two weeks past a missed print', () => {
    const r = assessFreshnessOnCalendar(cpi, MONTHLY, new Date('2026-09-25T12:00:00Z'), BUSINESS_DAYS);
    expect(r.status).toBe('STALE');
  });

  it('becomes UNAVAILABLE after two missed prints', () => {
    const r = assessFreshnessOnCalendar(cpi, MONTHLY, new Date('2026-10-30T12:00:00Z'), BUSINESS_DAYS);
    expect(r.status).toBe('UNAVAILABLE');
  });
});
