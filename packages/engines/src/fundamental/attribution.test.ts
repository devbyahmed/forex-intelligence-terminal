/**
 * Limitation attribution: whose fault is the gap?
 *
 * Three categories, and the whole point is that they are not interchangeable:
 *
 * - `WORLD` — information. The market was quiet, a release has not happened yet.
 * - `CONFIGURATION` — a defect. We never fetched enough history for the factor to exist.
 * - `STRUCTURAL` — a permanent consequence of the free-tier decision. The data is
 *   published; it is simply not reachable from here.
 *
 * A user reading "Inflation: neutral" is entitled to know whether that means inflation
 * is genuinely balanced, or that half the factor was never measured. The percentage
 * alone cannot carry that difference, so it is carried in words.
 */

import { describe, expect, it } from 'vitest';
import {
  ABSTENTION_REASONS,
  ATTRIBUTION_OF,
  LIMITATION_ATTRIBUTIONS,
  isScored,
  type FactorOutcome,
} from './factor.js';
import { computeAllFactors, type FactorComputeConfig } from './factors.js';
import {
  RELEASE_SURPRISE_GAP,
  type FundamentalInputs,
  type MacroSeriesView,
  type NewsAggregateView,
} from './inputs.js';
import type { FactorId, MacroSeriesId } from '@forex-agent/core';

const CONFIG: FactorComputeConfig = {
  factors: Object.fromEntries(
    (['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'] as const).map((id) => [
      id,
      { weight: 0.125, enabled: true },
    ]),
  ) as FactorComputeConfig['factors'],
  normalisation: { windowSize: 252, clampZ: 3, deadbandZ: 0.25, minObservations: 30 },
  inflationNetRule: { hedgeWeight: 0.4, rateChannelWeight: 0.6, inflationTargetPct: 2 },
};

const BASE: Readonly<Record<string, number>> = {
  DTWEXBGS: 121,
  DFII10: 2.1,
  DGS10: 4.6,
  DGS2: 3.9,
  DFF: 3.6,
  CPILFESL: 320,
  CPIAUCSL: 315,
  PAYEMS: 158_000,
  UNRATE: 4.1,
  ICSA: 225_000,
  VIXCLS: 15,
  BAMLH0A0HYM2: 2.7,
};

function seriesOf(seriesId: MacroSeriesId, base: number, count = 200): MacroSeriesView {
  return {
    seriesId,
    points: Array.from({ length: count }, (_, i) => ({
      period: new Date(Date.UTC(2000, 0, 1) + i * 86_400_000).toISOString().slice(0, 10),
      value: base + Math.sin(i / 2.7) * Math.abs(base) * 0.02 + i * Math.abs(base) * 0.0004,
      factId: `${seriesId}-${String(i)}`,
    })),
    freshness: 'LIVE',
    sourceTier: 1,
    displayName: seriesId,
  };
}

const NEWS_DARK: NewsAggregateView = {
  kind: 'INSUFFICIENT_VOLUME',
  reason: 'INSUFFICIENT_NEWS_VOLUME',
  explanation:
    'Only 6 relevant article(s) with sentiment signal in the last 48h; 10 are required.',
  articleCount: 6,
  sourceCount: 3,
  requiredArticles: 10,
  requiredSources: 2,
};

function inputs(over: Partial<FundamentalInputs> = {}): FundamentalInputs {
  const series: Partial<Record<MacroSeriesId, MacroSeriesView>> = {};
  for (const [id, base] of Object.entries(BASE) as [MacroSeriesId, number][]) {
    series[id] = seriesOf(id, base);
  }
  return {
    series,
    surprises: {},
    news: NEWS_DARK,
    upcomingReleases: [],
    degradedProviders: [],
    structuralGaps: [],
    ...over,
  };
}

const factorOf = (i: FundamentalInputs, id: FactorId): FactorOutcome => {
  const f = computeAllFactors(i, CONFIG).find((x) => x.factorId === id);
  if (f === undefined) throw new Error(`${id} missing`);
  return f;
};

describe('every abstention reason has an attribution', () => {
  it('maps all of them, so no reason can be silently uncategorised', () => {
    for (const reason of ABSTENTION_REASONS) {
      expect(LIMITATION_ATTRIBUTIONS).toContain(ATTRIBUTION_OF[reason]);
    }
    expect(Object.keys(ATTRIBUTION_OF).sort()).toEqual([...ABSTENTION_REASONS].sort());
  });

  it('attributes our own failures to CONFIGURATION', () => {
    // These two are the ones that should never reach a user as an abstention: the
    // viability check fails the boot on the first, and the second is an operator
    // decision rather than a fact about the market.
    expect(ATTRIBUTION_OF.INSUFFICIENT_HISTORY).toBe('CONFIGURATION');
    expect(ATTRIBUTION_OF.DISABLED).toBe('CONFIGURATION');
  });

  it('attributes genuine data absences to WORLD', () => {
    expect(ATTRIBUTION_OF.BELOW_VOLUME_THRESHOLD).toBe('WORLD');
    expect(ATTRIBUTION_OF.INPUT_UNAVAILABLE).toBe('WORLD');
    expect(ATTRIBUTION_OF.NO_VARIANCE).toBe('WORLD');
  });
});

describe('an abstaining factor carries its attribution', () => {
  it('marks F8 as WORLD — the market simply did not produce the articles', () => {
    const f8 = factorOf(inputs(), 'F8');
    expect(f8.kind).toBe('ABSTAINED');
    if (f8.kind === 'ABSTAINED') {
      expect(f8.attribution).toBe('WORLD');
      expect(f8.reason).toBe('BELOW_VOLUME_THRESHOLD');
    }
  });

  it('marks a short-history abstention as CONFIGURATION — a bug report, not a reading', () => {
    // "F8 abstained: 6 articles against a 10 floor" is the world telling the user
    // something true. "F5 abstained: insufficient history" is us telling them the
    // pipeline is broken, and the UI must be able to tell those apart.
    const short = inputs({
      series: { ...inputs().series, CPILFESL: seriesOf('CPILFESL', 320, 20) },
    });
    const f5 = factorOf(short, 'F5');
    expect(f5.kind).toBe('ABSTAINED');
    if (f5.kind === 'ABSTAINED') {
      expect(f5.reason).toBe('INSUFFICIENT_HISTORY');
      expect(f5.attribution).toBe('CONFIGURATION');
    }
  });
});

describe('a partly-measured factor says which part is missing', () => {
  const withGap = inputs({ structuralGaps: [RELEASE_SURPRISE_GAP] });

  it('marks F5 STRUCTURAL when the surprise history is declared unobtainable', () => {
    const f5 = factorOf(withGap, 'F5');
    expect(isScored(f5)).toBe(true);
    if (!isScored(f5)) return;

    expect(f5.limitations).toHaveLength(1);
    expect(f5.limitations[0]?.attribution).toBe('STRUCTURAL');
  });

  it('names the missing channel rather than reporting a percentage', () => {
    // The whole point. 0.5 completeness tells the user how much weight was lost; it
    // does not tell them the missing half pushes the OTHER WAY.
    const f5 = factorOf(withGap, 'F5');
    if (!isScored(f5)) throw new Error('F5 should score');

    const limitation = f5.limitations[0];
    expect(limitation?.missing).toContain('rate channel');
    expect(limitation?.missing).toContain('works against gold');
    expect(limitation?.reason).toContain('free source');
  });

  it('gives the limitation an end date rather than leaving it open', () => {
    // A limitation with a resolution reads as a known constraint. The same limitation
    // without one reads as a permanent unknown, and users discount accordingly.
    const f5 = factorOf(withGap, 'F5');
    if (!isScored(f5)) throw new Error('F5 should score');
    expect(f5.limitations[0]?.resolution).toContain('twelve months');
  });

  it('puts the disclosure in the explanation, where the score is read', () => {
    const f5 = factorOf(withGap, 'F5');
    if (!isScored(f5)) throw new Error('F5 should score');
    expect(f5.explanation).toContain('This reading excludes');
    expect(f5.explanation).toContain('rate channel');
    expect(f5.explanation).toContain('twelve months');
  });

  it('discloses F6 the same way', () => {
    const f6 = factorOf(withGap, 'F6');
    if (!isScored(f6)) throw new Error('F6 should score');
    expect(f6.limitations[0]?.attribution).toBe('STRUCTURAL');
    expect(f6.limitations[0]?.missing).toContain('payrolls surprise');
    expect(f6.explanation).toContain('This reading excludes');
  });

  it('falls back to WORLD when no structural gap is declared', () => {
    // Over-claiming permanence would tell a user a gap will never close when the
    // pipeline has simply not caught up yet. The weaker claim is the honest default.
    const f5 = factorOf(inputs(), 'F5');
    if (!isScored(f5)) throw new Error('F5 should score');
    expect(f5.limitations[0]?.attribution).toBe('WORLD');
    expect(f5.limitations[0]?.resolution).toBeNull();
  });

  it('reports no limitation at all once the surprise resolves', () => {
    // The disclosure must disappear by itself when the data arrives — a hardcoded
    // caveat would outlive the constraint it describes.
    const withSurprise = inputs({
      structuralGaps: [RELEASE_SURPRISE_GAP],
      surprises: {
        CPI: {
          eventName: 'Consumer Price Index',
          country: 'US',
          surprise: 0.1,
          surpriseZ: 0.4,
          releasedAt: new Date('2026-08-12T12:30:00Z'),
          freshness: 'LIVE',
          sourceTier: 1,
          factId: 'cpi-1',
        },
      },
    });
    const f5 = factorOf(withSurprise, 'F5');
    if (!isScored(f5)) throw new Error('F5 should score');
    expect(f5.limitations).toEqual([]);
    expect(f5.explanation).not.toContain('This reading excludes');
    expect(f5.inputCompleteness).toBe(1);
  });

  it('leaves a fully-measured factor with no limitations', () => {
    const f2 = factorOf(withGap, 'F2');
    if (!isScored(f2)) throw new Error('F2 should score');
    expect(f2.limitations).toEqual([]);
    expect(f2.explanation).not.toContain('This reading excludes');
  });
});
