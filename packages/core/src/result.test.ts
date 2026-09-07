import { describe, expect, it } from 'vitest';
import {
  hasValue,
  mapResult,
  matchResult,
  observationOrNull,
  ok,
  stale,
  unavailable,
  valueOrNull,
  type AttemptLog,
} from './result.js';
import { isDisqualified, makeObservation, mapObservation, withQualityFlags } from './observation.js';
import type { Provenance } from './observation.js';

const provenance: Provenance = {
  providerId: 'fred',
  sourceName: 'Federal Reserve Economic Data',
  sourceUrl: 'https://fred.stlouisfed.org/series/DGS10',
  sourceTier: 1,
  sourceTimestamp: new Date('2026-08-29T13:00:00.000Z'),
  retrievedAt: new Date('2026-08-30T11:00:00.000Z'),
};

const obs = makeObservation(4.21, provenance, 'RECENT');

const attempt: AttemptLog = {
  providerId: 'twelvedata',
  startedAt: new Date('2026-08-30T11:00:00.000Z'),
  durationMs: 812,
  outcome: 'FAILURE',
  errorCode: 'HTTP_429',
  httpStatus: 429,
};

describe('ProviderResult', () => {
  it('exposes a value for OK and STALE', () => {
    expect(valueOrNull(ok(obs))).toBe(4.21);
    expect(valueOrNull(stale(obs, 'ALL_PROVIDERS_FAILED'))).toBe(4.21);
  });

  it('exposes null rather than a substitute value for UNAVAILABLE', () => {
    // The absence of an `unwrapOr(default)` helper is deliberate: supplying a
    // fallback number is exactly the fabrication this type exists to prevent.
    const r = unavailable<number>('ALL_PROVIDERS_FAILED', [attempt]);
    expect(valueOrNull(r)).toBeNull();
    expect(observationOrNull(r)).toBeNull();
    expect(hasValue(r)).toBe(false);
  });

  it('retains the attempt history on failure so it stays explainable', () => {
    const r = unavailable<number>('ALL_PROVIDERS_FAILED', [attempt]);
    expect(r.status).toBe('UNAVAILABLE');
    if (r.status === 'UNAVAILABLE') {
      expect(r.attempted).toHaveLength(1);
      expect(r.attempted[0]?.providerId).toBe('twelvedata');
    }
  });

  it('preserves provenance through a map', () => {
    const mapped = mapResult(ok(obs), (v) => v * 100);
    expect(valueOrNull(mapped)).toBeCloseTo(421);
    expect(observationOrNull(mapped)?.provenance.providerId).toBe('fred');
    expect(observationOrNull(mapped)?.provenance.sourceTier).toBe(1);
  });

  it('preserves the stale reason through a map', () => {
    const mapped = mapResult(stale(obs, 'CIRCUIT_OPEN', [attempt]), (v) => v + 1);
    expect(mapped.status).toBe('STALE');
    if (mapped.status === 'STALE') {
      expect(mapped.reason).toBe('CIRCUIT_OPEN');
      expect(mapped.attempted).toHaveLength(1);
    }
  });

  it('leaves an unavailable result untouched when mapped', () => {
    const r = unavailable<number>('NOT_CONFIGURED');
    const mapped = mapResult(r, (v) => v * 2);
    expect(mapped.status).toBe('UNAVAILABLE');
  });

  it('forces every branch to be handled when matching', () => {
    const render = (r: ReturnType<typeof ok<number>>): string =>
      matchResult(r, {
        ok: (o) => String(o.value),
        stale: (o, reason) => `${String(o.value)} (stale: ${reason})`,
        unavailable: (reason) => `unavailable: ${reason}`,
      });

    expect(render(ok(obs))).toBe('4.21');
    expect(render(stale(obs, 'RATE_LIMITED'))).toBe('4.21 (stale: RATE_LIMITED)');
    expect(render(unavailable('NO_CACHED_VALUE'))).toBe('unavailable: NO_CACHED_VALUE');
  });
});

describe('Observation', () => {
  it('carries full provenance', () => {
    expect(obs.provenance.sourceTimestamp.toISOString()).toBe('2026-08-29T13:00:00.000Z');
    expect(obs.provenance.retrievedAt.toISOString()).toBe('2026-08-30T11:00:00.000Z');
    expect(obs.provenance.sourceUrl).toContain('fred.stlouisfed.org');
  });

  it('preserves provenance when the value is mapped', () => {
    const pct = mapObservation(obs, (v) => `${v.toFixed(2)}%`);
    expect(pct.value).toBe('4.21%');
    expect(pct.provenance).toEqual(obs.provenance);
    expect(pct.freshness).toBe('RECENT');
  });

  it('merges quality flags without duplicating them', () => {
    const flagged = withQualityFlags(withQualityFlags(obs, 'REVISED'), 'REVISED', 'ANOMALY');
    expect(flagged.qualityFlags).toHaveLength(2);
    expect(flagged.qualityFlags).toContain('REVISED');
    expect(flagged.qualityFlags).toContain('ANOMALY');
  });

  it('disqualifies impossible values from scoring but keeps them stored', () => {
    const bad = withQualityFlags(obs, 'IMPOSSIBLE_VALUE');
    expect(isDisqualified(bad)).toBe(true);
    expect(bad.value).toBe(4.21); // still present, still auditable
  });

  it('does not disqualify a merely revised or anomalous value', () => {
    // A revision is normal for macro data; it must not silently drop out of scoring.
    expect(isDisqualified(withQualityFlags(obs, 'REVISED'))).toBe(false);
    expect(isDisqualified(withQualityFlags(obs, 'ANOMALY'))).toBe(false);
  });
});
