import { describe, expect, it } from 'vitest';
import {
  FactTimingError,
  assessFreshness,
  liveTiming,
  needsLagDisclosure,
  publicationLagDays,
  publishedTiming,
} from './factTiming.js';

const NOW = new Date('2026-08-30T12:00:00.000Z');
const DAY = 86_400_000;

const MONTHLY = { liveMs: 7 * DAY, recentMs: 40 * DAY, staleBeyondMs: 60 * DAY, maxRetrievalAgeMs: DAY };
const DAILY = { liveMs: DAY, recentMs: 3 * DAY, staleBeyondMs: 7 * DAY, maxRetrievalAgeMs: 6 * 3600_000 };

describe('assessFreshness — the three real bugs it prevents', () => {
  it('treats a monthly statistic as current when recently published', () => {
    // Bug 2 verbatim: July CPI, published mid-August, read on 30 August. Measuring
    // from the observation period made it look two months stale and marked it
    // UNAVAILABLE, silently dropping the inflation factor.
    const timing = publishedTiming({
      publishedAt: new Date('2026-08-12T12:30:00Z'),
      describesPeriod: '2026-07-01',
      retrievedAt: NOW,
    });
    expect(assessFreshness(timing, MONTHLY, NOW).status).toBe('RECENT');
  });

  it('would have been UNAVAILABLE if measured from the period instead', () => {
    // The contrast that makes the point: same fact, wrong timestamp.
    const wrong = { knownAt: new Date('2026-07-01T00:00:00Z'), retrievedAt: NOW };
    expect(assessFreshness(wrong, MONTHLY, NOW).status).toBe('UNAVAILABLE');
  });

  it('still reports a genuinely old publication as stale', () => {
    // The helper must not make everything look fresh — a figure nobody has
    // republished in three months is stale, and that is the honest answer.
    const timing = publishedTiming({
      publishedAt: new Date('2026-05-01T12:30:00Z'),
      describesPeriod: '2026-04-01',
      retrievedAt: NOW,
    });
    expect(assessFreshness(timing, MONTHLY, NOW).status).toBe('UNAVAILABLE');
  });

  it('rejects a datetime passed as describesPeriod', () => {
    // Exactly the confusion the type exists to prevent, caught loudly.
    expect(() =>
      assessFreshness(
        { knownAt: NOW, describesPeriod: '2026-07-01T00:00:00Z', retrievedAt: NOW },
        MONTHLY,
        NOW,
      ),
    ).toThrow(FactTimingError);
  });

  it('names the right field in the error', () => {
    try {
      assessFreshness({ knownAt: NOW, describesPeriod: 'July 2026', retrievedAt: NOW }, MONTHLY, NOW);
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('knownAt');
    }
  });
});

describe('assessFreshness — boundaries and skew', () => {
  it('classifies each band', () => {
    const at = (ageMs: number) =>
      assessFreshness(liveTiming(new Date(NOW.getTime() - ageMs), NOW), DAILY, NOW).status;
    expect(at(0)).toBe('LIVE');
    expect(at(DAY)).toBe('LIVE');
    expect(at(DAY + 1)).toBe('RECENT');
    expect(at(3 * DAY)).toBe('RECENT');
    expect(at(3 * DAY + 1)).toBe('STALE');
    expect(at(7 * DAY)).toBe('STALE');
    expect(at(7 * DAY + 1)).toBe('UNAVAILABLE');
  });

  it('flags verification as overdue independently of status', () => {
    const r = assessFreshness(
      { knownAt: new Date(NOW.getTime() - 1000), retrievedAt: new Date(NOW.getTime() - 12 * 3600_000) },
      DAILY,
      NOW,
    );
    expect(r.status).toBe('LIVE');
    expect(r.verificationOverdue).toBe(true);
  });

  it('rejects a far-future publication', () => {
    const r = assessFreshness(liveTiming(new Date(NOW.getTime() + 10 * 3600_000), NOW), DAILY, NOW);
    expect(r.status).toBe('UNAVAILABLE');
  });

  it('tolerates small clock skew', () => {
    const r = assessFreshness(liveTiming(new Date(NOW.getTime() + 30_000), NOW), DAILY, NOW);
    expect(r.status).toBe('LIVE');
    expect(r.sourceAgeMs).toBe(0);
  });
});

describe('publicationLagDays — the H.10 disclosure', () => {
  it('measures how far behind a source runs', () => {
    // Bug 1: the dollar index describes a day nine days before it was published.
    const timing = publishedTiming({
      publishedAt: new Date('2026-08-30T00:00:00Z'),
      describesPeriod: '2026-08-21',
      retrievedAt: NOW,
    });
    expect(publicationLagDays(timing)).toBe(9);
  });

  it('is null when there is no separate period', () => {
    expect(publicationLagDays(liveTiming(NOW, NOW))).toBeNull();
  });

  it('requires disclosure for a lagging series', () => {
    // A freshness chip alone is misleading here: RECENT on a nine-day-old dollar
    // index is technically true and practically wrong.
    const lagging = publishedTiming({
      publishedAt: new Date('2026-08-30T00:00:00Z'),
      describesPeriod: '2026-08-21',
      retrievedAt: NOW,
    });
    expect(needsLagDisclosure(lagging)).toBe(true);
  });

  it('does not require disclosure for a same-day publication', () => {
    const prompt = publishedTiming({
      publishedAt: new Date('2026-08-30T00:00:00Z'),
      describesPeriod: '2026-08-30',
      retrievedAt: NOW,
    });
    expect(needsLagDisclosure(prompt)).toBe(false);
  });

  it('does not require disclosure for a one-business-day lag', () => {
    const yields = publishedTiming({
      publishedAt: new Date('2026-08-28T00:00:00Z'),
      describesPeriod: '2026-08-27',
      retrievedAt: NOW,
    });
    expect(needsLagDisclosure(yields)).toBe(false);
  });
});
