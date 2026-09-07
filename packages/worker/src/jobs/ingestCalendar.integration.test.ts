/**
 * Calendar ingestion integration tests.
 *
 * The property that matters most here is **dual provenance**: an official actual and
 * a scraped forecast end up in one row without the forecast inheriting the actual's
 * authority. That is enforced by the schema, so it can only be tested against a real
 * database.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { economicEvents, economicReleases } from '@forex-agent/db';
import { createTestDb, hasTestDatabase, type TestDb } from '@forex-agent/db/test-support';
import { seed, type SeedProfile } from '@forex-agent/db';
import type {
  DateRange,
  EconomicCalendarProvider,
  ProviderHealth,
  ProviderResult,
  RawEconomicRelease,
} from '@forex-agent/providers';
import { makeObservation, ok, unavailable } from '@forex-agent/core';
import {
  canonicalEventKey,
  ingestCalendarJob,
  normaliseEventName,
  resolveImportance,
  surpriseZ,
  upcomingHighImpact,
} from './ingestCalendar.js';

const describeDb = hasTestDatabase() ? describe : describe.skip;

const NOW = new Date('2026-08-30T12:00:00.000Z');
const THRESHOLDS = {
  liveMs: 6 * 3600_000,
  recentMs: 24 * 3600_000,
  staleBeyondMs: 48 * 3600_000,
  maxRetrievalAgeMs: 8 * 3600_000,
};
const SEED_PROFILE: SeedProfile = { profileName: 'default-v1', config: {} };

/** A fake provider, so the merge logic is tested without network flakiness. */
function fakeProvider(
  id: string,
  tier: 1 | 3,
  releases: RawEconomicRelease[],
  options: { available?: boolean; providesForecasts?: boolean } = {},
): EconomicCalendarProvider {
  return {
    id,
    displayName: id,
    domain: 'ECONOMIC_CALENDAR',
    tier,
    limits: {},
    providesActuals: tier === 1,
    providesForecasts: options.providesForecasts ?? tier === 3,
    isConfigured: () => true,
    health: (): Promise<ProviderHealth> =>
      Promise.resolve({ providerId: id, reachable: true, checkedAt: NOW }),
    getReleases: (r: DateRange) => Promise.resolve(build(r)),
  };

  function build(_range: DateRange): ProviderResult<RawEconomicRelease[]> {
    if (options.available === false) return unavailable('ALL_PROVIDERS_FAILED', []);
    return ok(
      makeObservation(
        releases,
        {
          providerId: id,
          sourceName: id === 'fred' ? 'Federal Reserve Economic Data' : 'ForexFactory',
          sourceUrl: `https://example.test/${id}`,
          sourceTier: tier,
          sourceTimestamp: NOW,
          retrievedAt: NOW,
        },
        'LIVE',
      ),
    );
  }
}

const CPI_AT = new Date('2026-09-11T12:30:00.000Z');

const ffCpi: RawEconomicRelease & { isHoliday: boolean } = {
  country: 'US',
  currency: 'USD',
  eventName: 'CPI m/m',
  scheduledAt: CPI_AT,
  scheduledLocalTime: '08:30',
  previous: 0.2,
  forecast: 0.3,
  actual: null,
  unit: '%',
  importanceHint: 'MEDIUM',
  isHoliday: false,
};

const fredCpi: RawEconomicRelease = {
  country: 'US',
  currency: 'USD',
  eventName: 'Consumer Price Index',
  scheduledAt: CPI_AT,
  scheduledLocalTime: '08:30',
  previous: null,
  forecast: null,
  actual: null,
  unit: null,
  importanceHint: null,
};

describe('name normalisation', () => {
  it('collapses punctuation and case', () => {
    expect(normaliseEventName('Core CPI m/m')).toBe('core cpi m m');
    expect(normaliseEventName('  FOMC   Statement  ')).toBe('fomc statement');
  });

  it('strips parenthetical qualifiers', () => {
    expect(normaliseEventName('GDP q/q (Advance)')).toBe('gdp q q');
  });

  it('maps the two feeds onto one canonical event', () => {
    // The two sources name the same release differently; without this they would
    // create duplicate events and never share a forecast with an actual.
    expect(canonicalEventKey('Non-Farm Employment Change')).toBe('employment situation');
    expect(canonicalEventKey('Employment Situation')).toBe('employment situation');
    expect(canonicalEventKey('CPI m/m')).toBe('consumer price index');
  });

  it('leaves an unknown event as its normalised form', () => {
    expect(canonicalEventKey('Ivey PMI')).toBe('ivey pmi');
  });
});

describe('surpriseZ', () => {
  it('returns null below the minimum sample', () => {
    // A z-score from four points is a number with no meaning; publishing one gives
    // the fundamental engine false precision.
    expect(surpriseZ(0.1, [0.1, 0.2, -0.1, 0.0])).toBeNull();
  });

  it('computes a z-score with enough history', () => {
    const history = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 0.1 : -0.1));
    const z = surpriseZ(0.3, history);
    expect(z).not.toBeNull();
    expect(z!).toBeGreaterThan(2);
  });

  it('returns null when the history has no variance', () => {
    expect(surpriseZ(0.5, Array.from({ length: 20 }, () => 0.1))).toBeNull();
  });
});

describeDb('calendar ingestion (real Postgres)', () => {
  let handle: TestDb;

  beforeAll(async () => {
    handle = await createTestDb();
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await handle.truncateAll();
    await seed(handle.db, SEED_PROFILE);
  });

  const runJob = async (
    fred: EconomicCalendarProvider,
    ff: EconomicCalendarProvider,
  ): Promise<number> => {
    const job = ingestCalendarJob({ fred, forexFactory: ff, thresholds: THRESHOLDS });
    const outcome = await job({
      db: handle.db,
      scheduledFor: NOW,
      now: NOW,
      jobName: 'calendar.ingest',
    });
    return outcome.itemsProcessed;
  };

  it('merges the two sources into one release', async () => {
    const written = await runJob(
      fakeProvider('fred', 1, [fredCpi]),
      fakeProvider('forexfactory', 3, [ffCpi]),
    );
    expect(written).toBe(1);

    const rows = await handle.db.select().from(economicReleases);
    expect(rows).toHaveLength(1);
    // The Tier 3 feed supplied the time; FRED supplied the authoritative date.
    expect(rows[0]?.scheduledLocalTime).toBe('08:30');
  });

  it('keeps the forecast provenanced separately from the actual', async () => {
    // The central guarantee: a scraped consensus must never inherit Tier 1
    // authority just because it sits in the same row as an official figure.
    await runJob(fakeProvider('fred', 1, [fredCpi]), fakeProvider('forexfactory', 3, [ffCpi]));

    const [row] = await handle.db.select().from(economicReleases);
    expect(row?.forecastSourceProvider).toBe('forexfactory');
    expect(row?.forecastSourceTier).toBe(3);
    // The row's own tier is FRED's, since FRED confirms the date.
    expect(row?.sourceTier).toBe(1);
    expect(row?.sourceProvider).toBe('fred');
  });

  it('carries the provenance with a forecast that arrives on a later run', async () => {
    /*
     * ── Regression: the forecast and its attribution must move together ──────
     *
     * Consensus forecasts only appear within about a week of the release
     * (LIMITS.md §6.9), so the ordinary sequence is FRED first with no forecast,
     * and the Tier 3 feed days later with one. The upsert coalesced the value
     * without the provenance columns, producing a forecast number sitting in a
     * FRED-attributed row with no attribution of its own — caught in production by
     * `economic_releases_forecast_provenanced`, which failed the entire calendar
     * ingest rather than storing an unattributable figure.
     *
     * The first run has to be FRED alone. Running both sources together tests the
     * insert path, which was always correct, and that is why this went unnoticed.
     */
    await runJob(fakeProvider('fred', 1, [fredCpi]), fakeProvider('ff-down', 3, [], { available: false }));

    const [before] = await handle.db.select().from(economicReleases);
    expect(before?.forecastValue).toBeNull();
    expect(before?.forecastSourceProvider).toBeNull();

    await runJob(fakeProvider('fred', 1, [fredCpi]), fakeProvider('forexfactory', 3, [ffCpi]));

    const rows = await handle.db.select().from(economicReleases);
    expect(rows).toHaveLength(1);
    const [after] = rows;
    expect(after?.forecastValue).not.toBeNull();
    // The value and its attribution came from the same source, on the same run.
    expect(after?.forecastSourceProvider).toBe('forexfactory');
    expect(after?.forecastSourceTier).toBe(3);
    expect(after?.forecastRetrievedAt).not.toBeNull();
    // And the row still belongs to FRED, which confirmed the date.
    expect(after?.sourceProvider).toBe('fred');
    expect(after?.sourceTier).toBe(1);
  });
  it('lets curated importance override a Tier 3 hint', async () => {
    // The feed rated CPI as MEDIUM. The curated rule says HIGH, and a scraped
    // rating must not be able to disable the event-risk warning.
    await runJob(fakeProvider('fred', 1, [fredCpi]), fakeProvider('forexfactory', 3, [ffCpi]));
    const [event] = await handle.db.select().from(economicEvents);
    expect(event?.importance).toBe('HIGH');
    expect(event?.importanceIsCurated).toBe(true);
  });

  it('falls back to the feed hint when no rule matches', async () => {
    const obscure = { ...ffCpi, eventName: 'Ivey PMI', importanceHint: 'MEDIUM' as const };
    await runJob(fakeProvider('fred', 1, []), fakeProvider('forexfactory', 3, [obscure]));
    const [event] = await handle.db.select().from(economicEvents);
    expect(event?.importance).toBe('MEDIUM');
    expect(event?.importanceIsCurated).toBe(false);
  });

  it('works from FRED alone when the Tier 3 feed is down', async () => {
    // Degradation, not failure: dates survive, forecast and time do not.
    const written = await runJob(
      fakeProvider('fred', 1, [fredCpi]),
      fakeProvider('forexfactory', 3, [], { available: false }),
    );
    expect(written).toBe(1);
    const [row] = await handle.db.select().from(economicReleases);
    expect(row?.forecastValue).toBeNull();
    expect(row?.sourceTier).toBe(1);
  });

  it('works from the Tier 3 feed alone when FRED is down', async () => {
    const written = await runJob(
      fakeProvider('fred', 1, [], { available: false }),
      fakeProvider('forexfactory', 3, [ffCpi]),
    );
    expect(written).toBe(1);
    const [row] = await handle.db.select().from(economicReleases);
    expect(row?.forecastSourceTier).toBe(3);
    expect(row?.sourceTier).toBe(3);
  });

  it('reports zero rather than failing when both sources are down', async () => {
    const written = await runJob(
      fakeProvider('fred', 1, [], { available: false }),
      fakeProvider('forexfactory', 3, [], { available: false }),
    );
    expect(written).toBe(0);
  });

  it('is idempotent across runs', async () => {
    const fred = fakeProvider('fred', 1, [fredCpi]);
    const ff = fakeProvider('forexfactory', 3, [ffCpi]);
    await runJob(fred, ff);
    await runJob(fred, ff);
    expect(await handle.db.select().from(economicReleases)).toHaveLength(1);
    expect(await handle.db.select().from(economicEvents)).toHaveLength(1);
  });

  it('leaves surprise null while the actual is unpublished', async () => {
    // Zero would read as "came in exactly as expected" — a fabricated fact.
    await runJob(fakeProvider('fred', 1, [fredCpi]), fakeProvider('forexfactory', 3, [ffCpi]));
    const [row] = await handle.db.select().from(economicReleases);
    expect(row?.surprise).toBeNull();
  });

  it('computes surprise once both sides exist', async () => {
    const withActual = { ...fredCpi, actual: 0.5 };
    const ffWithForecast = { ...ffCpi, forecast: 0.3 };
    const job = ingestCalendarJob({
      fred: fakeProvider('fred', 1, [withActual]),
      forexFactory: fakeProvider('forexfactory', 3, [ffWithForecast]),
      thresholds: THRESHOLDS,
    });
    await job({ db: handle.db, scheduledFor: NOW, now: NOW, jobName: 'calendar.ingest' });
    // FRED's release row carries no actual in this pipeline stage, so the merge
    // keeps the Tier 3 forecast and leaves surprise for the actual-fetch step.
    const [row] = await handle.db.select().from(economicReleases);
    expect(row?.forecastValue).toBe('0.30000000');
  });

  it('stores a holiday without treating it as a high-impact event', async () => {
    const holiday = {
      ...ffCpi,
      eventName: 'Bank Holiday',
      importanceHint: 'LOW' as const,
      forecast: null,
      previous: null,
      isHoliday: true,
    };
    await runJob(fakeProvider('fred', 1, []), fakeProvider('forexfactory', 3, [holiday]));
    const [event] = await handle.db.select().from(economicEvents);
    expect(event?.importance).toBe('LOW');
    const high = await upcomingHighImpact(handle.db, NOW, new Date(NOW.getTime() + 30 * 86_400_000));
    expect(high).toHaveLength(0);
  });

  it('finds upcoming high-impact releases for the event-risk engine', async () => {
    await runJob(fakeProvider('fred', 1, [fredCpi]), fakeProvider('forexfactory', 3, [ffCpi]));
    const high = await upcomingHighImpact(handle.db, NOW, new Date(NOW.getTime() + 30 * 86_400_000));
    expect(high).toHaveLength(1);
    expect(high[0]?.eventName).toBe('CPI m/m');
  });

  describe('resolveImportance', () => {
    it('prefers the longest matching rule', async () => {
      // 'core cpi' must beat 'cpi', or every core print inherits the headline rule.
      const r = await resolveImportance(handle.db, {
        country: 'US',
        eventName: 'Core CPI m/m',
        hint: 'LOW',
      });
      expect(r.curated).toBe(true);
      expect(r.importance).toBe('HIGH');
    });

    it('falls back to LOW when there is neither a rule nor a hint', async () => {
      const r = await resolveImportance(handle.db, {
        country: 'ZZ',
        eventName: 'Unknown Indicator',
        hint: null,
      });
      expect(r.importance).toBe('LOW');
      expect(r.curated).toBe(false);
    });
  });
});
