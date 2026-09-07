import { describe, expect, it } from 'vitest';
import {
  FRESHNESS_WEIGHT,
  FreshnessThresholdError,
  assertValidThresholds,
  computeFreshness,
  isUsable,
  worstFreshness,
  type FreshnessThresholds,
} from './freshness.js';

const MIN = 60_000;
const HOUR = 60 * MIN;

/** Spot-quote thresholds from PRD_V1.md 9.4. */
const spot: FreshnessThresholds = {
  liveMs: 10 * MIN,
  recentMs: 30 * MIN,
  staleBeyondMs: 2 * HOUR,
  maxRetrievalAgeMs: 30 * MIN,
};

const now = new Date('2026-08-30T12:00:00.000Z');
const ago = (ms: number): Date => new Date(now.getTime() - ms);

const at = (sourceAgeMs: number, retrievalAgeMs = sourceAgeMs): ReturnType<typeof computeFreshness> =>
  computeFreshness({
    sourceTimestamp: ago(sourceAgeMs),
    retrievedAt: ago(retrievalAgeMs),
    thresholds: spot,
    now,
  });

describe('computeFreshness', () => {
  it('classifies a brand-new fact as LIVE', () => {
    expect(at(0).status).toBe('LIVE');
  });

  // Boundaries are where off-by-one bugs live, so each is pinned explicitly.
  it('treats the LIVE boundary as inclusive', () => {
    expect(at(10 * MIN).status).toBe('LIVE');
    expect(at(10 * MIN + 1).status).toBe('RECENT');
  });

  it('treats the RECENT boundary as inclusive', () => {
    expect(at(30 * MIN).status).toBe('RECENT');
    expect(at(30 * MIN + 1).status).toBe('STALE');
  });

  it('treats the STALE boundary as inclusive, then gives up entirely', () => {
    expect(at(2 * HOUR).status).toBe('STALE');
    expect(at(2 * HOUR + 1).status).toBe('UNAVAILABLE');
  });

  it('reports source age and retrieval age separately', () => {
    // A monthly figure published 15 days ago but re-checked a minute ago: the fact
    // is old, our knowledge of it is current. Both numbers must survive.
    const r = computeFreshness({
      sourceTimestamp: ago(15 * 24 * HOUR),
      retrievedAt: ago(MIN),
      thresholds: spot,
      now,
    });
    expect(r.sourceAgeMs).toBe(15 * 24 * HOUR);
    expect(r.retrievalAgeMs).toBe(MIN);
  });

  it('flags verification as overdue when we have not re-checked in time', () => {
    // Freshness is driven by source age, so a fact can be LIVE while our last
    // successful check is stale. That is a real state and must be visible.
    const r = computeFreshness({
      sourceTimestamp: ago(MIN),
      retrievedAt: ago(45 * MIN),
      thresholds: spot,
      now,
    });
    expect(r.status).toBe('LIVE');
    expect(r.verificationOverdue).toBe(true);
  });

  it('does not flag verification as overdue within tolerance', () => {
    expect(at(MIN, 5 * MIN).verificationOverdue).toBe(false);
  });

  it('tolerates small clock skew by clamping age to zero', () => {
    const r = computeFreshness({
      sourceTimestamp: new Date(now.getTime() + 30_000),
      retrievedAt: now,
      thresholds: spot,
      now,
    });
    expect(r.status).toBe('LIVE');
    expect(r.sourceAgeMs).toBe(0);
  });

  it('rejects a far-future timestamp rather than treating it as permanently fresh', () => {
    // Without this, one bad provider timestamp would pin a value to LIVE forever.
    const r = computeFreshness({
      sourceTimestamp: new Date(now.getTime() + 10 * HOUR),
      retrievedAt: now,
      thresholds: spot,
      now,
    });
    expect(r.status).toBe('UNAVAILABLE');
  });
});

describe('assertValidThresholds', () => {
  it('rejects non-monotonic thresholds', () => {
    expect(() =>
      assertValidThresholds({
        liveMs: 30 * MIN,
        recentMs: 10 * MIN,
        staleBeyondMs: 2 * HOUR,
        maxRetrievalAgeMs: MIN,
      }),
    ).toThrow(FreshnessThresholdError);
  });

  it('rejects non-positive thresholds', () => {
    expect(() =>
      assertValidThresholds({ ...spot, liveMs: 0 }),
    ).toThrow(FreshnessThresholdError);
  });

  it('accepts the shipped defaults', () => {
    expect(() => assertValidThresholds(spot)).not.toThrow();
  });
});

describe('worstFreshness', () => {
  it('returns the oldest status among its arguments', () => {
    expect(worstFreshness('LIVE', 'RECENT', 'STALE')).toBe('STALE');
    expect(worstFreshness('LIVE', 'RECENT')).toBe('RECENT');
    expect(worstFreshness('STALE', 'UNAVAILABLE')).toBe('UNAVAILABLE');
  });

  it('returns its only argument unchanged', () => {
    expect(worstFreshness('RECENT')).toBe('RECENT');
  });
});

describe('freshness weighting', () => {
  it('gives UNAVAILABLE zero weight so a missing factor abstains', () => {
    // This single value is what makes abstention work: an unavailable factor
    // contributes no weight, so it cannot masquerade as a neutral reading.
    expect(FRESHNESS_WEIGHT.UNAVAILABLE).toBe(0);
  });

  it('degrades monotonically', () => {
    expect(FRESHNESS_WEIGHT.LIVE).toBeGreaterThan(FRESHNESS_WEIGHT.RECENT);
    expect(FRESHNESS_WEIGHT.RECENT).toBeGreaterThan(FRESHNESS_WEIGHT.STALE);
    expect(FRESHNESS_WEIGHT.STALE).toBeGreaterThan(FRESHNESS_WEIGHT.UNAVAILABLE);
  });

  it('treats everything but UNAVAILABLE as usable', () => {
    expect(isUsable('STALE')).toBe(true);
    expect(isUsable('UNAVAILABLE')).toBe(false);
  });
});
