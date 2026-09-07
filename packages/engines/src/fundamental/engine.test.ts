/**
 * The engine end to end.
 *
 * Fixtures are synthetic but shaped like the real series: DTWEXBGS around 121 index
 * points, DFII10 and DGS10 as percentages near 2 and 4.6, VIX in the teens. The point
 * is not to reproduce a real day — it is that every branch, including the ones that
 * only occur when providers are down, is reachable without waiting for an outage.
 */

import { describe, expect, it } from 'vitest';
import { FACTOR_IDS, type FactorId, type FreshnessStatus, type MacroSeriesId } from '@forex-agent/core';
import { runFundamentalEngine, type FundamentalEngineConfig, type FundamentalResult, type ScoredResult } from './engine.js';
import type { FundamentalInputs, MacroSeriesView, NewsAggregateView } from './inputs.js';
import { isScored } from './factor.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = new Date('2026-08-28T18:00:00Z');

const CONFIG: FundamentalEngineConfig = {
  factors: {
    F1: { weight: 0.18, enabled: true },
    F2: { weight: 0.18, enabled: true },
    F3: { weight: 0.1, enabled: true },
    F4: { weight: 0.15, enabled: true },
    F5: { weight: 0.09, enabled: true },
    F6: { weight: 0.1, enabled: true },
    F7: { weight: 0.1, enabled: true },
    F8: { weight: 0.1, enabled: true },
  },
  normalisation: { windowSize: 252, clampZ: 3, deadbandZ: 0.25, minObservations: 30 },
  inflationNetRule: { hedgeWeight: 0.4, rateChannelWeight: 0.6, inflationTargetPct: 2 },
  confidence: {
    thresholds: { high: 70, medium: 45 },
    insufficientCoverageFloor: 0.5,
    mediumCapCoverage: 0.65,
    weights: { coverage: 0.4, sourceQuality: 0.15, agreement: 0.3, freshness: 0.15 },
  },
  eventRisk: { warnWindowMs: 24 * HOUR, imminentWindowMs: 60 * MINUTE },
};

/**
 * A series with enough history to standardise, drifting by `drift` per step plus a
 * deterministic wobble so the variance is non-zero and the run is reproducible.
 */
function series(
  seriesId: MacroSeriesId,
  base: number,
  drift: number,
  options: { freshness?: FreshnessStatus; points?: number } = {},
): MacroSeriesView {
  const count = options.points ?? 120;
  const points = Array.from({ length: count }, (_, i) => ({
    period: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
    value: base + drift * i + Math.sin(i / 3) * Math.abs(base) * 0.004,
    factId: `${seriesId}-${String(i)}`,
  }));
  return {
    seriesId,
    points,
    freshness: options.freshness ?? 'LIVE',
    sourceTier: 1,
    displayName: seriesId,
  };
}

/**
 * A series that is unremarkable for most of its history and then moves sharply.
 *
 * A constant drift is useless for testing sign conventions: a steadily rising series
 * has a *constant* 5-day change, so standardising that change against its own history
 * gives a z near zero however fast the series is rising. Signals are measured against
 * what the series normally does, and "rising at exactly the usual rate" is normal.
 */
function shock(
  seriesId: MacroSeriesId,
  base: number,
  shockPct: number,
  options: { freshness?: FreshnessStatus; points?: number } = {},
): MacroSeriesView {
  const count = options.points ?? 120;
  const shockFrom = count - 20;
  const points = Array.from({ length: count }, (_, i) => {
    const wobble = Math.sin(i / 3) * Math.abs(base) * 0.002;
    const moved = i < shockFrom ? 0 : ((i - shockFrom) / 20) * base * shockPct;
    return {
      period: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      value: base + wobble + moved,
      factId: `${seriesId}-${String(i)}`,
    };
  });
  return {
    seriesId,
    points,
    freshness: options.freshness ?? 'LIVE',
    sourceTier: 1,
    displayName: seriesId,
  };
}

/**
 * The surprises a normal run has.
 *
 * Without these F5 sits at 0.5 input completeness and F6 at 0.75, which is correct
 * behaviour — partial evidence earns partial weight — but it means "normal run"
 * coverage would be 0.83 rather than 0.90, and the fixture would be quietly testing a
 * degraded day.
 */
const SURPRISES = {
  CPI: {
    eventName: 'Consumer Price Index',
    country: 'US',
    surprise: 0.1,
    surpriseZ: 0.4,
    releasedAt: new Date('2026-08-12T12:30:00Z'),
    freshness: 'LIVE' as FreshnessStatus,
    sourceTier: 1 as const,
    factId: 'cpi-release',
  },
  NFP: {
    eventName: 'Nonfarm Payrolls',
    country: 'US',
    surprise: 12_000,
    surpriseZ: 0.3,
    releasedAt: new Date('2026-08-07T12:30:00Z'),
    freshness: 'LIVE' as FreshnessStatus,
    sourceTier: 1 as const,
    factId: 'nfp-release',
  },
};

const DARK_NEWS: NewsAggregateView = {
  kind: 'INSUFFICIENT_VOLUME',
  reason: 'INSUFFICIENT_NEWS_VOLUME',
  explanation:
    'Only 6 relevant article(s) with sentiment signal in the last 48h; 10 are required.',
  articleCount: 6,
  sourceCount: 3,
  requiredArticles: 10,
  requiredSources: 2,
};

function inputs(overrides: Partial<FundamentalInputs> = {}): FundamentalInputs {
  return {
    series: {
      DTWEXBGS: series('DTWEXBGS', 121, 0.02),
      DFII10: series('DFII10', 2.1, 0.002),
      DGS10: series('DGS10', 4.6, 0.002),
      DGS2: series('DGS2', 3.9, 0.001),
      DFF: series('DFF', 3.6, 0.0005),
      CPILFESL: series('CPILFESL', 320, 0.25),
      CPIAUCSL: series('CPIAUCSL', 315, 0.25),
      PAYEMS: series('PAYEMS', 158_000, 120),
      UNRATE: series('UNRATE', 4.1, 0.002),
      ICSA: series('ICSA', 225_000, 300),
      VIXCLS: series('VIXCLS', 15, 0.01),
      BAMLH0A0HYM2: series('BAMLH0A0HYM2', 2.7, 0.001),
    },
    surprises: SURPRISES,
    news: DARK_NEWS,
    upcomingReleases: [],
    degradedProviders: [],
    structuralGaps: [],
    ...overrides,
  };
}

const run = (i: FundamentalInputs = inputs()): FundamentalResult =>
  runFundamentalEngine(i, CONFIG, NOW);

function expectScored(r: FundamentalResult): ScoredResult {
  if (r.status !== 'SCORED') throw new Error(`expected SCORED, got: ${r.reason}`);
  return r;
}

/** Drop a series entirely, as if the provider never returned it. */
function without(...ids: MacroSeriesId[]): FundamentalInputs {
  const base = inputs();
  const drop = new Set<string>(ids);
  const series = Object.fromEntries(
    Object.entries(base.series).filter(([id]) => !drop.has(id)),
  ) as FundamentalInputs['series'];
  return { ...base, series };
}

/** Mark a series UNAVAILABLE, as if it were far past its publication schedule. */
function unavailable(...ids: MacroSeriesId[]): FundamentalInputs {
  const base = inputs();
  const series = { ...base.series };
  for (const id of ids) {
    const existing = series[id];
    if (existing !== undefined) series[id] = { ...existing, freshness: 'UNAVAILABLE' };
  }
  return { ...base, series };
}

describe('a normal run', () => {
  it('produces a score on the signed scale with a display score and a band', () => {
    const r = expectScored(run());
    expect(r.signedScore).toBeGreaterThanOrEqual(-100);
    expect(r.signedScore).toBeLessThanOrEqual(100);
    expect(r.displayScore).toBe(Math.round((r.signedScore + 100) / 2));
    expect(r.band).not.toBe('');
  });

  it('scores seven factors and leaves F8 dark', () => {
    // F8's abstention is the measured state of the news pipeline, not a fixture
    // convenience — 3 gold-relevant articles a day against a floor of 10.
    const r = run();
    const scored = r.factors.filter(isScored).map((f) => f.factorId);
    expect(scored).toHaveLength(7);
    expect(scored).not.toContain('F8');
    expect(r.abstained.map((a) => a.factorId)).toEqual(['F8']);
    expect(r.abstained[0]?.reason).toBe('BELOW_VOLUME_THRESHOLD');
  });

  it('reports coverage of 0.9, not 1.0, with F8 dark', () => {
    // F8 carries 0.10, so a run without it cannot honestly claim full coverage.
    expect(run().coverage).toBeCloseTo(0.9, 6);
  });

  it('still publishes a score with F8 dark, because 0.9 clears the floor', () => {
    expect(run().status).toBe('SCORED');
  });

  it('gives every factor an explanation containing real numbers', () => {
    for (const f of run().factors) {
      expect(f.explanation.length).toBeGreaterThan(20);
      expect(f.explanation).toMatch(/\d/);
    }
  });

  it('never claims a factor predicts anything', () => {
    // Amendment A3. The explanations describe what a series has done and what the
    // factor currently reads; nothing about what will happen.
    const forbidden = /\b(will|expect(ed|s)? to|forecast|predict|should (rise|fall)|target price)\b/i;
    for (const f of run().factors) {
      expect(f.explanation).not.toMatch(forbidden);
    }
  });

  it('never states a unit it does not mean', () => {
    // Caught on the first real-data run: the dollar index level of 118.06 rendered as
    // "+118.06%" because the unit was inferred from the key name. Not a rounding
    // slip — a false statement about a number the user is asked to trust.
    const f1 = run().factors.find((f) => f.factorId === 'F1');
    expect(f1?.explanation).toMatch(/level \+?[\d.]+ index/);
    expect(f1?.explanation).not.toMatch(/level \+?[\d.]+%/);
  });

  it('quotes percentage changes as percentages and yields as points', () => {
    const f1 = run().factors.find((f) => f.factorId === 'F1');
    expect(f1?.explanation).toMatch(/change 5d [+-][\d.]+%/);
    const f2 = run().factors.find((f) => f.factorId === 'F2');
    expect(f2?.explanation).toMatch(/level [+-]?[\d.]+pp/);
  });

  it('records the fact rows each factor consumed', () => {
    for (const f of run().factors.filter(isScored)) {
      expect(f.factRefs.length).toBeGreaterThan(0);
      for (const ref of f.factRefs) {
        expect(ref.id).not.toBe('');
        expect(ref.table).not.toBe('');
      }
    }
  });

  it('is deterministic — the same inputs give the same result', () => {
    const a = run();
    const b = run();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('takes its clock from the argument, not from the ambient one', () => {
    const later = runFundamentalEngine(inputs(), CONFIG, new Date('2027-01-01T00:00:00Z'));
    expect(later.computedAt.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });
});

describe('factor sign conventions', () => {
  // Getting a sign backwards inverts the product while every test about structure
  // still passes, so each one is pinned against a rising and a falling series.
  const scoreOf = (i: FundamentalInputs, id: FactorId): number => {
    const f = runFundamentalEngine(i, CONFIG, NOW).factors.find((x) => x.factorId === id);
    if (f === undefined || !isScored(f)) throw new Error(`${id} did not score`);
    return f.score;
  };

  it('F1: a strengthening dollar is bearish for gold', () => {
    const rising = { ...inputs(), series: { ...inputs().series, DTWEXBGS: shock('DTWEXBGS', 121, 0.04) } };
    const falling = { ...inputs(), series: { ...inputs().series, DTWEXBGS: shock('DTWEXBGS', 121, -0.04) } };
    expect(scoreOf(rising, 'F1')).toBeLessThan(0);
    expect(scoreOf(falling, 'F1')).toBeGreaterThan(0);
  });

  it('F2: a rising real yield is bearish for gold', () => {
    const rising = { ...inputs(), series: { ...inputs().series, DFII10: shock('DFII10', 2.1, 0.3) } };
    const falling = { ...inputs(), series: { ...inputs().series, DFII10: shock('DFII10', 2.1, -0.3) } };
    expect(scoreOf(rising, 'F2')).toBeLessThan(0);
    expect(scoreOf(falling, 'F2')).toBeGreaterThan(0);
  });

  it('F3: a rising nominal yield is bearish for gold', () => {
    const rising = { ...inputs(), series: { ...inputs().series, DGS10: shock('DGS10', 4.6, 0.2) } };
    const falling = { ...inputs(), series: { ...inputs().series, DGS10: shock('DGS10', 4.6, -0.2) } };
    expect(scoreOf(rising, 'F3')).toBeLessThan(0);
    expect(scoreOf(falling, 'F3')).toBeGreaterThan(0);
  });

  it('F7: rising volatility is bullish for gold', () => {
    const risingVol = {
      ...inputs(),
      series: {
        ...inputs().series,
        VIXCLS: shock('VIXCLS', 15, 0.6),
        BAMLH0A0HYM2: shock('BAMLH0A0HYM2', 2.7, 0.3),
      },
    };
    const fallingVol = {
      ...inputs(),
      series: {
        ...inputs().series,
        VIXCLS: shock('VIXCLS', 15, -0.3),
        BAMLH0A0HYM2: shock('BAMLH0A0HYM2', 2.7, -0.2),
      },
    };
    expect(scoreOf(risingVol, 'F7')).toBeGreaterThan(0);
    expect(scoreOf(fallingVol, 'F7')).toBeLessThan(0);
  });

  it('F6: rising jobless claims are bullish for gold', () => {
    // Weakening labour market supports gold. The opposite sign here would invert one
    // of the two factors the product leans on most in a downturn.
    const risingClaims = { ...inputs(), series: { ...inputs().series, ICSA: shock('ICSA', 225_000, 0.25) } };
    expect(scoreOf(risingClaims, 'F6')).toBeGreaterThan(0);
  });
});

describe('a factor abstains when its input is unavailable', () => {
  it('abstains rather than scoring UNAVAILABLE data at reduced weight', () => {
    // UNAVAILABLE means "too old to be evidence of anything current". Scoring it at
    // half weight would still let it move the number.
    const r = run(unavailable('DTWEXBGS'));
    const f1 = r.factors.find((f) => f.factorId === 'F1');
    expect(f1?.kind).toBe('ABSTAINED');
    expect(r.abstained.find((a) => a.factorId === 'F1')?.reason).toBe('INPUT_UNAVAILABLE');
  });

  it('abstains when the series was never fetched at all', () => {
    const r = run(without('DFII10'));
    expect(r.factors.find((f) => f.factorId === 'F2')?.kind).toBe('ABSTAINED');
    expect(r.abstained.find((a) => a.factorId === 'F2')?.reason).toBe('INPUT_MISSING');
  });

  it('abstains when there is too little history to standardise', () => {
    const short = inputs();
    const r = run({
      ...short,
      series: { ...short.series, DGS10: series('DGS10', 4.6, 0.002, { points: 10 }) },
    });
    expect(r.factors.find((f) => f.factorId === 'F3')?.kind).toBe('ABSTAINED');
    expect(r.abstained.find((a) => a.factorId === 'F3')?.reason).toBe('INSUFFICIENT_HISTORY');
  });

  it('removes exactly that factor’s weight from coverage', () => {
    // F1 is 0.18 and F8 is already dark at 0.10.
    expect(run(unavailable('DTWEXBGS')).coverage).toBeCloseTo(0.72, 6);
  });

  it('keeps scoring a factor whose optional input is missing, at lower completeness', () => {
    // F4 reads DGS2 and, optionally, the DGS2−DFF spread. Losing DFF must degrade F4
    // rather than silence it: partial evidence is still evidence.
    const r = run(unavailable('DFF'));
    const f4 = r.factors.find((f) => f.factorId === 'F4');
    expect(f4?.kind).toBe('SCORED');
    if (f4 !== undefined && isScored(f4)) {
      expect(f4.inputCompleteness).toBeCloseTo(0.5, 6);
      expect(f4.confidence).toBeLessThan(1);
    }
  });

  it('degrades but does not silence a STALE factor', () => {
    const stale = inputs();
    const r = run({
      ...stale,
      series: { ...stale.series, DFII10: series('DFII10', 2.1, 0.002, { freshness: 'STALE' }) },
    });
    const f2 = r.factors.find((f) => f.factorId === 'F2');
    expect(f2?.kind).toBe('SCORED');
    if (f2 !== undefined && isScored(f2)) expect(f2.confidence).toBeCloseTo(0.5, 6);
  });
});

describe('the insufficiency path', () => {
  it('publishes nothing when too many factors are dark', () => {
    // F1 0.18, F2 0.18, F4 0.15 and F8 0.10 gone: coverage 0.39.
    const r = run(unavailable('DTWEXBGS', 'DFII10', 'DGS2'));
    expect(r.status).toBe('INSUFFICIENT_DATA');
    expect(r.coverage).toBeLessThan(0.5);
  });

  it('has no score to render, not a null one', () => {
    const r = run(unavailable('DTWEXBGS', 'DFII10', 'DGS2'));
    expect(r).not.toHaveProperty('signedScore');
    expect(r).not.toHaveProperty('displayScore');
    expect(r).not.toHaveProperty('confidence');
  });

  it('does not call the AI', () => {
    // A model asked to comment on an absent score writes prose that reads exactly
    // like a finding. The flag is on the result rather than left to the caller.
    expect(run(unavailable('DTWEXBGS', 'DFII10', 'DGS2')).aiEligible).toBe(false);
    expect(run().aiEligible).toBe(true);
  });

  it('explains itself as a statement about our data, not about the market', () => {
    const r = run(unavailable('DTWEXBGS', 'DFII10', 'DGS2'));
    if (r.status !== 'INSUFFICIENT_DATA') throw new Error('expected INSUFFICIENT_DATA');
    expect(r.reason).toContain('No score is published');
    expect(r.reason).toContain('39%');
    expect(r.reason).toContain('F1');
    // Not a claim about conditions being unclear — we have no standing to say that.
    expect(r.reason).not.toMatch(/market|conditions are|unclear|uncertain outlook/i);
  });

  it('still warns about an imminent release when it cannot score', () => {
    // The moment conditions are worst is not the moment to go quiet.
    const base = unavailable('DTWEXBGS', 'DFII10', 'DGS2');
    const r = run({
      ...base,
      upcomingReleases: [
        {
          eventName: 'CPI',
          country: 'US',
          scheduledAt: new Date(NOW.getTime() + 30 * MINUTE),
          importance: 'HIGH',
          factId: 'evt-1',
        },
      ],
    });
    expect(r.status).toBe('INSUFFICIENT_DATA');
    expect(r.eventRisk.imminent).toBe(true);
    expect(r.eventRisk.warnings[0]?.caution).toContain('CPI');
  });

  it('reports INSUFFICIENT_DATA, not a crash, when every provider is down', () => {
    const r = runFundamentalEngine(
      { series: {}, surprises: {}, news: DARK_NEWS, upcomingReleases: [], degradedProviders: [], structuralGaps: [] },
      CONFIG,
      NOW,
    );
    expect(r.status).toBe('INSUFFICIENT_DATA');
    expect(r.coverage).toBe(0);
    expect(r.factors).toHaveLength(8);
    expect(r.abstained).toHaveLength(8);
  });
});

describe('confidence on a real run', () => {
  it('caps at MEDIUM when a high-impact release is imminent', () => {
    const withEvent = {
      ...inputs(),
      upcomingReleases: [
        {
          eventName: 'Nonfarm Payrolls',
          country: 'US',
          scheduledAt: new Date(NOW.getTime() + 20 * MINUTE),
          importance: 'HIGH' as const,
          factId: 'evt-2',
        },
      ],
    };
    const r = expectScored(run(withEvent));
    expect(r.confidence.level).toBe('MEDIUM');
    expect(r.confidence.caps.join(' ')).toContain('high-impact release');
  });

  it('does not cap for a release that is merely on the horizon', () => {
    const withEvent = {
      ...inputs(),
      upcomingReleases: [
        {
          eventName: 'Nonfarm Payrolls',
          country: 'US',
          scheduledAt: new Date(NOW.getTime() + 8 * HOUR),
          importance: 'HIGH' as const,
          factId: 'evt-3',
        },
      ],
    };
    const r = expectScored(run(withEvent));
    expect(r.eventRisk.warnings).toHaveLength(1);
    expect(r.eventRisk.imminent).toBe(false);
    expect(r.confidence.caps).toEqual([]);
  });

  it('ignores a release that has already happened', () => {
    // It is part of the current reading, not a risk to it.
    const past = {
      ...inputs(),
      upcomingReleases: [
        {
          eventName: 'CPI',
          country: 'US',
          scheduledAt: new Date(NOW.getTime() - 30 * MINUTE),
          importance: 'HIGH' as const,
          factId: 'evt-4',
        },
      ],
    };
    expect(expectScored(run(past)).eventRisk.warnings).toEqual([]);
  });

  it('penalises a degraded provider chain', () => {
    const degraded = { ...inputs(), degradedProviders: ['twelvedata', 'forexfactory'] };
    expect(expectScored(run(degraded)).confidence.value).toBeLessThan(
      expectScored(run()).confidence.value,
    );
  });
});

describe('configuration is honoured rather than hard-coded', () => {
  it('abstains a factor disabled in the profile', () => {
    const config: FundamentalEngineConfig = {
      ...CONFIG,
      factors: { ...CONFIG.factors, F7: { weight: 0.1, enabled: false } },
    };
    const r = runFundamentalEngine(inputs(), config, NOW);
    expect(r.factors.find((f) => f.factorId === 'F7')?.kind).toBe('ABSTAINED');
    expect(r.abstained.find((a) => a.factorId === 'F7')?.reason).toBe('DISABLED');
  });

  it('raises the insufficiency floor when the profile says so', () => {
    // Coverage 0.9 publishes under the default floor and must not under a 0.95 floor.
    expect(run().status).toBe('SCORED');
    const strict: FundamentalEngineConfig = {
      ...CONFIG,
      confidence: { ...CONFIG.confidence, insufficientCoverageFloor: 0.95 },
    };
    expect(runFundamentalEngine(inputs(), strict, NOW).status).toBe('INSUFFICIENT_DATA');
  });

  it('produces every factor id exactly once', () => {
    expect(run().factors.map((f) => f.factorId).sort()).toEqual([...FACTOR_IDS].sort());
  });
});
