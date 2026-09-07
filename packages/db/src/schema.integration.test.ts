/**
 * Schema integration tests against real Postgres.
 *
 * These exist because the invariants they check are enforced by the *database*, not
 * by application code. A unit test with a fake would prove nothing: the whole point
 * of putting Amendment A2 into CHECK constraints and a trigger is that no code path,
 * present or future, can write a conclusion without its evidence. The only way to
 * know that holds is to ask Postgres to reject it.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { uuidv7 } from '@forex-agent/core';
import { fredProvenance, provenanceColumns } from '@forex-agent/testing';
import {
  createTestDb,
  expectConstraintViolation,
  expectTriggerRejection,
  extractRows,
  hasTestDatabase,
  type TestDb,
} from './test-support.js';
import {
  aiGenerations,
  analyses,
  analysisStatements,
  assets,
  configProfiles,
  economicEvents,
  economicReleases,
  fundamentalFactors,
  jobRuns,
  macroObservations,
  eventImportanceRules,
  macroSeries,
  marketCandles,

  marketQuotes,
  newsSources,
  users,
} from './schema/index.js';
import { seed, type SeedProfile } from './seed.js';
import { lockKey, tryAdvisoryLock } from './locks.js';

const SEED_PROFILE: SeedProfile = {
  profileName: 'default-v1',
  config: { profileName: 'default-v1' },
};

// Integration tests need a real Postgres. Skipping keeps `pnpm test` usable before
// one is installed; CI always provides it, so coverage is never quietly lost.
const describeDb = hasTestDatabase() ? describe : describe.skip;

describeDb('schema (real Postgres)', () => {
  let handle: TestDb;
  let assetId: string;
  let configProfileId: string;

  beforeAll(async () => {
    handle = await createTestDb();
  }, 60_000);

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await handle.truncateAll();
    const result = await seed(handle.db, SEED_PROFILE);
    configProfileId = result.configProfileId;
    const [gold] = await handle.db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.symbol, 'XAUUSD'))
      .limit(1);
    assetId = gold!.id;
  });

  const newAnalysis = async (overrides: Record<string, unknown> = {}): Promise<string> => {
    const [row] = await handle.db
      .insert(analyses)
      .values({
        assetId,
        mode: 'FUNDAMENTAL',
        status: 'COMPLETE',
        configProfileId,
        fundamentalScore: 42,
        fundamentalBias: 'BULLISH',
        confidence: 'MEDIUM',
        coverage: 0.8,
        ...overrides,
      })
      .returning({ id: analyses.id });
    return row!.id;
  };

  // ── Seed ────────────────────────────────────────────────────────────────

  describe('seed', () => {
    it('is idempotent', async () => {
      await seed(handle.db, SEED_PROFILE);
      await seed(handle.db, SEED_PROFILE);
      const rows = await handle.db.select({ id: assets.id }).from(assets);
      expect(rows).toHaveLength(8);
    });

    it('activates only XAUUSD', async () => {
      const active = await handle.db
        .select({ symbol: assets.symbol })
        .from(assets)
        .where(eq(assets.isActive, true));
      expect(active.map((a) => a.symbol)).toEqual(['XAUUSD']);
    });

    it('does not reactivate an asset that was deliberately deactivated', async () => {
      // Activation is an operational decision; re-running the seed must not undo it.
      await handle.db.update(assets).set({ isActive: false }).where(eq(assets.symbol, 'XAUUSD'));
      await seed(handle.db, SEED_PROFILE);
      const [gold] = await handle.db
        .select({ isActive: assets.isActive })
        .from(assets)
        .where(eq(assets.symbol, 'XAUUSD'));
      expect(gold!.isActive).toBe(false);
    });

    it('seeds only feeds verified reachable', async () => {
      // Two feeds from the original design (BLS 403, Treasury 404) were removed
      // after empirical verification rather than left to fail silently.
      const feeds = await handle.db.select({ url: newsSources.feedUrl }).from(newsSources);
      expect(feeds).toHaveLength(12);
      expect(feeds.map((f) => f.url).join(' ')).not.toContain('bls.gov');
      expect(feeds.map((f) => f.url).join(' ')).not.toContain('treasury.gov');
    });

    it('seeds only HTTPS feeds — no plaintext transport in the news chain', async () => {
      // A structural guard rather than a name blacklist. GDELT was rejected because
      // its HTTPS endpoint is broken and only http:// works; 'we need more volume' is
      // not a reason to weaken provenance. Asserting the scheme covers GDELT and any
      // future source nobody has thought of yet.
      const feeds = await handle.db.select({ url: newsSources.feedUrl }).from(newsSources);
      for (const f of feeds) {
        expect(f.url.startsWith('https://')).toBe(true);
      }
    });

    it('excludes GDELT specifically', async () => {
      // Named explicitly as well, so the rejection is visible to anyone reading the
      // tests rather than only inferable from the scheme check.
      const feeds = await handle.db.select({ url: newsSources.feedUrl }).from(newsSources);
      expect(feeds.map((f) => f.url).join(' ')).not.toContain('gdelt');
    });

    it('deactivates a feed removed from the seed', async () => {
      // Upserting alone left removed feeds active and failing forever — observed
      // with BLS and Treasury, which kept appearing as ingestion failures after
      // being dropped from the list.
      await handle.db.insert(newsSources).values({
        name: 'Retired Feed',
        feedUrl: 'https://retired.example.com/rss',
        tier: 3,
        isActive: true,
      });
      await seed(handle.db, SEED_PROFILE);
      const [retired] = await handle.db
        .select({ isActive: newsSources.isActive })
        .from(newsSources)
        .where(eq(newsSources.feedUrl, 'https://retired.example.com/rss'));
      expect(retired?.isActive).toBe(false);

      // Seeded feeds stay active.
      const active = await handle.db
        .select({ url: newsSources.feedUrl })
        .from(newsSources)
        .where(eq(newsSources.isActive, true));
      expect(active).toHaveLength(12);
    });

    it('propagates a cadence change to an existing series', async () => {
      // cadence selects the freshness thresholds, so a stale value is not cosmetic.
      // DTWEXBGS was reclassified DAILY -> WEEKLY after the H.10 family was measured
      // publishing ~9 days in arrears, but the upsert only refreshed name/role/unit,
      // so the database kept DAILY and F1 went on being scored STALE at half weight.
      await handle.db
        .update(macroSeries)
        .set({ cadence: 'DAILY' })
        .where(eq(macroSeries.seriesId, 'DTWEXBGS'));
      await seed(handle.db, SEED_PROFILE);
      const [row] = await handle.db
        .select({ cadence: macroSeries.cadence })
        .from(macroSeries)
        .where(eq(macroSeries.seriesId, 'DTWEXBGS'));
      expect(row?.cadence).toBe('WEEKLY');
    });

    it('reactivates a series that returns to the seed', async () => {
      await handle.db
        .update(macroSeries)
        .set({ isActive: false })
        .where(eq(macroSeries.seriesId, 'DGS10'));
      await seed(handle.db, SEED_PROFILE);
      const [row] = await handle.db
        .select({ isActive: macroSeries.isActive })
        .from(macroSeries)
        .where(eq(macroSeries.seriesId, 'DGS10'));
      expect(row?.isActive).toBe(true);
    });

    it('deactivates a macro series removed from the seed', async () => {
      // macro_observations cascades from these, so a removed series must be
      // deactivated rather than deleted — deleting one would erase the history
      // behind every factor that ever used it.
      await handle.db.insert(macroSeries).values({
        seriesId: 'RETIRED', provider: 'fred', name: 'Retired', role: 'x',
        unit: 'index', cadence: 'DAILY', isActive: true,
      });
      await seed(handle.db, SEED_PROFILE);
      const [row] = await handle.db
        .select({ isActive: macroSeries.isActive })
        .from(macroSeries)
        .where(eq(macroSeries.seriesId, 'RETIRED'));
      expect(row?.isActive).toBe(false);
      // The row survives, so its observations keep their foreign key.
      expect(row).toBeDefined();
    });

    it('deletes an importance rule removed from the seed', async () => {
      // Nothing references these — the rule is applied at ingest and its *result*
      // stored. A leftover rule is an orphaned decision, silently classifying
      // releases by a policy already retired, so it is deleted rather than hidden.
      await handle.db.insert(eventImportanceRules).values({
        country: 'ZZ', eventPattern: 'retired pattern', importance: 'HIGH',
      });
      await seed(handle.db, SEED_PROFILE);
      const rows = await handle.db
        .select({ p: eventImportanceRules.eventPattern })
        .from(eventImportanceRules)
        .where(eq(eventImportanceRules.country, 'ZZ'));
      expect(rows).toHaveLength(0);
    });

    it('keeps seeded importance rules after reconciliation', async () => {
      await seed(handle.db, SEED_PROFILE);
      const rows = await handle.db.select().from(eventImportanceRules);
      expect(rows.length).toBeGreaterThan(15);
    });

    it('seeds all twelve macro series', async () => {
      const rows = await handle.db.select({ id: macroSeries.id }).from(macroSeries);
      expect(rows).toHaveLength(12);
    });

    it('creates exactly one active config profile', async () => {
      const active = await handle.db
        .select({ id: configProfiles.id })
        .from(configProfiles)
        .where(eq(configProfiles.isActive, true));
      expect(active).toHaveLength(1);
    });

    it('refuses a second active config profile', async () => {
      // Two active profiles would make "which weights produced this score" ambiguous.
      await expectConstraintViolation(
        () =>
          handle.db
            .insert(configProfiles)
            .values({ name: 'another', isActive: true, config: {} }),
        'config_profiles_single_active_idx',
      );
    });
  });

  // ── Amendment A2: the three-layer model ─────────────────────────────────

  describe('Amendment A2 — analysis_statements', () => {
    it('accepts a well-formed FACT → INTERPRETATION → AI_ASSESSMENT chain', async () => {
      const analysisId = await newAnalysis();
      const p = fredProvenance();

      const [fact] = await handle.db
        .insert(analysisStatements)
        .values({
          analysisId,
          layer: 'FACT',
          ordinal: 1,
          body: 'The 10-year real yield was 1.92% on 2026-08-29.',
          factTable: 'macro_observations',
          factId: uuidv7(),
          ...provenanceColumns(p),
          freshness: 'RECENT',
        })
        .returning({ id: analysisStatements.id });

      const [interpretation] = await handle.db
        .insert(analysisStatements)
        .values({
          analysisId,
          layer: 'INTERPRETATION',
          ordinal: 1,
          body: 'A falling real yield reduces the opportunity cost of holding gold.',
          derivedFrom: [fact!.id],
        })
        .returning({ id: analysisStatements.id });

      const [gen] = await handle.db
        .insert(aiGenerations)
        .values({
          analysisId,
          providerId: 'gemini',
          model: 'gemini-3.7-flash',
          promptName: 'fundamental_analysis',
          promptVersion: 'v1',
          outcome: 'VALID',
        })
        .returning({ id: aiGenerations.id });

      await expect(
        handle.db.insert(analysisStatements).values({
          analysisId,
          layer: 'AI_ASSESSMENT',
          ordinal: 1,
          body: 'Current conditions are supportive for gold.',
          derivedFrom: [interpretation!.id],
          aiGenerationId: gen!.id,
        }),
      ).resolves.toBeDefined();
    });

    it('rejects a FACT with no provenance', async () => {
      // The core guarantee: an unattributed fact is indistinguishable from an
      // invented one, so the database refuses to store it.
      const analysisId = await newAnalysis();
      await expectConstraintViolation(
        () =>
          handle.db.insert(analysisStatements).values({
            analysisId,
            layer: 'FACT',
            ordinal: 1,
            body: 'The dollar weakened.',
          }),
        'fact_requires_provenance',
      );
    });

    it('rejects a FACT missing only its source timestamp', async () => {
      const analysisId = await newAnalysis();
      const p = fredProvenance();
      await expectConstraintViolation(
        () =>
          handle.db.insert(analysisStatements).values({
            analysisId,
            layer: 'FACT',
            ordinal: 1,
            body: 'Partial provenance.',
            factTable: 'macro_observations',
            factId: uuidv7(),
            sourceProvider: p.providerId,
            sourceName: p.sourceName,
            sourceTier: p.sourceTier,
            retrievedAt: p.retrievedAt,
            freshness: 'RECENT',
          }),
        'fact_requires_provenance',
      );
    });

    // A FACT must never claim derivation: a fact is observed, not reasoned to.
    //
    // Two mechanisms enforce this, and the BEFORE trigger always fires first, so the
    // `fact_has_no_derivation` CHECK is unreachable in practice — deliberately kept
    // as defence in depth in case the trigger is ever dropped. These two cases cover
    // both ways a FACT could try to claim a parent.
    it('rejects a FACT deriving from a nonexistent statement', async () => {
      const analysisId = await newAnalysis();
      await expectTriggerRejection(
        () =>
          handle.db.insert(analysisStatements).values({
            analysisId,
            layer: 'FACT',
            ordinal: 1,
            body: 'A fact is observed, not reasoned to.',
            factTable: 'macro_observations',
            factId: uuidv7(),
            ...provenanceColumns(),
            freshness: 'LIVE',
            derivedFrom: [uuidv7()],
          }),
        'does not exist',
      );
    });

    it('rejects a FACT deriving from another real FACT', async () => {
      const analysisId = await newAnalysis();
      const [existing] = await handle.db
        .insert(analysisStatements)
        .values({
          analysisId,
          layer: 'FACT',
          ordinal: 1,
          body: 'An existing fact.',
          factTable: 'macro_observations',
          factId: uuidv7(),
          ...provenanceColumns(),
          freshness: 'LIVE',
        })
        .returning({ id: analysisStatements.id });

      // Nothing sits below FACT, so no parent can satisfy the descent rule.
      await expectTriggerRejection(
        () =>
          handle.db.insert(analysisStatements).values({
            analysisId,
            layer: 'FACT',
            ordinal: 2,
            body: 'A fact claiming to rest on another fact.',
            factTable: 'macro_observations',
            factId: uuidv7(),
            ...provenanceColumns(),
            freshness: 'LIVE',
            derivedFrom: [existing!.id],
          }),
        'must descend',
      );
    });

    it('rejects an INTERPRETATION with no lineage', async () => {
      const analysisId = await newAnalysis();
      await expectConstraintViolation(
        () =>
          handle.db.insert(analysisStatements).values({
            analysisId,
            layer: 'INTERPRETATION',
            ordinal: 1,
            body: 'An assertion from nowhere.',
          }),
        'derived_requires_parents',
      );
    });

    it('rejects an AI_ASSESSMENT with no generation id', async () => {
      const analysisId = await newAnalysis();
      const [fact] = await handle.db
        .insert(analysisStatements)
        .values({
          analysisId,
          layer: 'FACT',
          ordinal: 1,
          body: 'A fact.',
          factTable: 'macro_observations',
          factId: uuidv7(),
          ...provenanceColumns(),
          freshness: 'LIVE',
        })
        .returning({ id: analysisStatements.id });

      await expectConstraintViolation(
        () =>
          handle.db.insert(analysisStatements).values({
            analysisId,
            layer: 'AI_ASSESSMENT',
            ordinal: 1,
            body: 'Unattributable model output.',
            derivedFrom: [fact!.id],
          }),
        'ai_requires_generation',
      );
    });

    it('rejects a non-AI statement that claims a generation id', async () => {
      // Equally important in reverse: deterministic prose must not be attributable
      // to the model, or the layer labels stop meaning anything.
      const analysisId = await newAnalysis();
      const [fact] = await handle.db
        .insert(analysisStatements)
        .values({
          analysisId,
          layer: 'FACT',
          ordinal: 1,
          body: 'A fact.',
          factTable: 'macro_observations',
          factId: uuidv7(),
          ...provenanceColumns(),
          freshness: 'LIVE',
        })
        .returning({ id: analysisStatements.id });

      const [gen] = await handle.db
        .insert(aiGenerations)
        .values({
          analysisId,
          providerId: 'gemini',
          model: 'gemini-3.7-flash',
          promptName: 'fundamental_analysis',
          promptVersion: 'v1',
          outcome: 'VALID',
        })
        .returning({ id: aiGenerations.id });

      await expectConstraintViolation(
        () =>
          handle.db.insert(analysisStatements).values({
            analysisId,
            layer: 'INTERPRETATION',
            ordinal: 2,
            body: 'Deterministic prose wrongly credited to the model.',
            derivedFrom: [fact!.id],
            aiGenerationId: gen!.id,
          }),
        'non_ai_has_no_generation',
      );
    });

    // ── The lineage trigger: what CHECK constraints cannot see ────────────

    it('rejects lineage pointing at a statement that does not exist', async () => {
      const analysisId = await newAnalysis();
      await expectTriggerRejection(
        () =>
          handle.db.insert(analysisStatements).values({
            analysisId,
            layer: 'INTERPRETATION',
            ordinal: 1,
            body: 'Derived from nothing real.',
            derivedFrom: [uuidv7()],
          }),
        'does not exist',
      );
    });

    it('rejects lineage crossing into another analysis', async () => {
      // Citing another analysis's evidence would let a conclusion rest on facts the
      // reader is never shown.
      const analysisA = await newAnalysis();
      const analysisB = await newAnalysis();

      const [factInA] = await handle.db
        .insert(analysisStatements)
        .values({
          analysisId: analysisA,
          layer: 'FACT',
          ordinal: 1,
          body: 'Belongs to analysis A.',
          factTable: 'macro_observations',
          factId: uuidv7(),
          ...provenanceColumns(),
          freshness: 'LIVE',
        })
        .returning({ id: analysisStatements.id });

      await expectTriggerRejection(
        () =>
          handle.db.insert(analysisStatements).values({
            analysisId: analysisB,
            layer: 'INTERPRETATION',
            ordinal: 1,
            body: 'Reaching into another analysis.',
            derivedFrom: [factInA!.id],
          }),
        'crosses analyses',
      );
    });

    it('rejects lineage that does not descend a layer', async () => {
      const analysisId = await newAnalysis();
      const [fact] = await handle.db
        .insert(analysisStatements)
        .values({
          analysisId,
          layer: 'FACT',
          ordinal: 1,
          body: 'A fact.',
          factTable: 'macro_observations',
          factId: uuidv7(),
          ...provenanceColumns(),
          freshness: 'LIVE',
        })
        .returning({ id: analysisStatements.id });

      const [interpretation] = await handle.db
        .insert(analysisStatements)
        .values({
          analysisId,
          layer: 'INTERPRETATION',
          ordinal: 1,
          body: 'First interpretation.',
          derivedFrom: [fact!.id],
        })
        .returning({ id: analysisStatements.id });

      // Sibling-to-sibling would allow a cycle and let a chain never reach a fact.
      await expectTriggerRejection(
        () =>
          handle.db.insert(analysisStatements).values({
            analysisId,
            layer: 'INTERPRETATION',
            ordinal: 2,
            body: 'Derived from a sibling.',
            derivedFrom: [interpretation!.id],
          }),
        'must descend',
      );
    });

    it('rejects an INTERPRETATION derived from an AI_ASSESSMENT', async () => {
      const analysisId = await newAnalysis();
      const [fact] = await handle.db
        .insert(analysisStatements)
        .values({
          analysisId,
          layer: 'FACT',
          ordinal: 1,
          body: 'A fact.',
          factTable: 'macro_observations',
          factId: uuidv7(),
          ...provenanceColumns(),
          freshness: 'LIVE',
        })
        .returning({ id: analysisStatements.id });
      const [gen] = await handle.db
        .insert(aiGenerations)
        .values({
          analysisId,
          providerId: 'gemini',
          model: 'gemini-3.7-flash',
          promptName: 'fundamental_analysis',
          promptVersion: 'v1',
          outcome: 'VALID',
        })
        .returning({ id: aiGenerations.id });
      const [assessment] = await handle.db
        .insert(analysisStatements)
        .values({
          analysisId,
          layer: 'AI_ASSESSMENT',
          ordinal: 1,
          body: 'Model output.',
          derivedFrom: [fact!.id],
          aiGenerationId: gen!.id,
        })
        .returning({ id: analysisStatements.id });

      // Otherwise deterministic reasoning could be built on model output while
      // still being labelled as non-AI.
      await expectTriggerRejection(
        () =>
          handle.db.insert(analysisStatements).values({
            analysisId,
            layer: 'INTERPRETATION',
            ordinal: 2,
            body: 'Laundering an AI claim into an interpretation.',
            derivedFrom: [assessment!.id],
          }),
        'must descend',
      );
    });
  });

  // ── Abstention and scoring integrity ────────────────────────────────────

  describe('scoring integrity', () => {
    it('rejects a score on an INSUFFICIENT_DATA analysis', async () => {
      await expectConstraintViolation(
        () =>
          handle.db.insert(analyses).values({
            assetId,
            mode: 'FUNDAMENTAL',
            status: 'INSUFFICIENT_DATA',
            configProfileId,
            fundamentalScore: 55,
          }),
        'analyses_insufficient_has_no_score',
      );
    });

    it('accepts an INSUFFICIENT_DATA analysis with no score', async () => {
      await expect(
        handle.db.insert(analyses).values({
          assetId,
          mode: 'FUNDAMENTAL',
          status: 'INSUFFICIENT_DATA',
          configProfileId,
          coverage: 0.3,
        }),
      ).resolves.toBeDefined();
    });

    it('rejects a score outside the signed range', async () => {
      await expectConstraintViolation(
        () =>
          handle.db.insert(analyses).values({
            assetId,
            mode: 'FUNDAMENTAL',
            status: 'COMPLETE',
            configProfileId,
            fundamentalScore: 150,
          }),
        'analyses_fundamental_score_range',
      );
    });

    it('rejects an abstaining factor that still carries weight', async () => {
      // This is the constraint that makes abstention real: a factor with no data
      // must not be able to move the total.
      const analysisId = await newAnalysis();
      await expectConstraintViolation(
        () =>
          handle.db.insert(fundamentalFactors).values({
            analysisId,
            factorId: 'F2',
            factorName: 'Real 10-year yield',
            direction: 'NEUTRAL',
            score: null,
            weight: 0.18,
            effectiveWeight: 0.18,
            confidence: 0,
            freshness: 'UNAVAILABLE',
            explanation: 'DFII10 unavailable.',
            factRefs: [],
            abstainedReason: 'DFII10 UNAVAILABLE',
          }),
        'fundamental_factors_abstain_coherent',
      );
    });

    it('accepts a correctly abstaining factor', async () => {
      const analysisId = await newAnalysis();
      await expect(
        handle.db.insert(fundamentalFactors).values({
          analysisId,
          factorId: 'F2',
          factorName: 'Real 10-year yield',
          direction: 'NEUTRAL',
          score: null,
          weight: 0.18,
          effectiveWeight: 0,
          confidence: 0,
          freshness: 'UNAVAILABLE',
          explanation: 'DFII10 unavailable; factor abstained.',
          factRefs: [],
          abstainedReason: 'DFII10 UNAVAILABLE',
        }),
      ).resolves.toBeDefined();
    });

    it('rejects a scored factor that also claims to have abstained', async () => {
      const analysisId = await newAnalysis();
      await expectConstraintViolation(
        () =>
          handle.db.insert(fundamentalFactors).values({
            analysisId,
            factorId: 'F1',
            factorName: 'US dollar strength',
            direction: 'BULLISH',
            score: 30,
            weight: 0.18,
            effectiveWeight: 0.18,
            confidence: 1,
            freshness: 'LIVE',
            explanation: 'Contradictory.',
            factRefs: [],
            abstainedReason: 'but also abstained',
          }),
        'fundamental_factors_abstain_coherent',
      );
    });
  });

  // ── Provenance contract on fact tables ──────────────────────────────────

  describe('provenance contract', () => {
    it('rejects a quote with an out-of-range source tier', async () => {
      await expectConstraintViolation(
        () =>
          handle.db.insert(marketQuotes).values({
            assetId,
            price: '4529.90',
            instrumentKind: 'FUTURES_PROXY',
            ...provenanceColumns(fredProvenance({ sourceTier: 9 as 1 })),
            freshness: 'LIVE',
          }),
        'market_quotes_source_tier_valid',
      );
    });

    it('rejects a non-positive price', async () => {
      await expectConstraintViolation(
        () =>
          handle.db.insert(marketQuotes).values({
            assetId,
            price: '0',
            instrumentKind: 'SPOT',
            ...provenanceColumns(),
            freshness: 'LIVE',
          }),
        'market_quotes_price_positive',
      );
    });

    it('rejects a fact retrieved long before its source published it', async () => {
      // Impossible ordering means a bad provider timestamp or a broken ingester;
      // either way the value must not enter the store unnoticed.
      await expectConstraintViolation(
        () =>
          handle.db.insert(marketQuotes).values({
            assetId,
            price: '4529.90',
            instrumentKind: 'SPOT',
            ...provenanceColumns(
              fredProvenance({
                sourceTimestamp: new Date('2026-08-30T12:00:00Z'),
                retrievedAt: new Date('2026-08-30T06:00:00Z'),
              }),
            ),
            freshness: 'LIVE',
          }),
        'market_quotes_retrieved_after_source',
      );
    });

    it('rejects an incoherent candle', async () => {
      await expectConstraintViolation(
        () =>
          handle.db.insert(marketCandles).values({
            assetId,
            timeframe: '1d',
            openTime: new Date('2026-08-29T00:00:00Z'),
            open: '4500',
            high: '4400', // below the low
            low: '4450',
            close: '4470',
            instrumentKind: 'FUTURES_PROXY',
            ...provenanceColumns(),
            freshness: 'RECENT',
          }),
        'market_candles_ohlc_coherent',
      );
    });

    it('keeps the same bar from two providers, provenanced separately', async () => {
      const base = {
        assetId,
        timeframe: '1d' as const,
        openTime: new Date('2026-08-29T00:00:00Z'),
        open: '4500',
        high: '4550',
        low: '4480',
        close: '4520',
        instrumentKind: 'FUTURES_PROXY',
        freshness: 'RECENT' as const,
      };
      await handle.db.insert(marketCandles).values({
        ...base,
        ...provenanceColumns(fredProvenance({ providerId: 'yahoo-finance', sourceTier: 3 })),
      });
      await handle.db.insert(marketCandles).values({
        ...base,
        ...provenanceColumns(fredProvenance({ providerId: 'nasdaq-data-link', sourceTier: 2 })),
      });
      const rows = await handle.db.select({ id: marketCandles.id }).from(marketCandles);
      expect(rows).toHaveLength(2);
    });

    it('rejects a forecast value without its own provenance', async () => {
      // A consensus forecast is Tier 3; rendering it beside a Tier 1 actual without
      // saying so would misrepresent it as official.
      const [event] = await handle.db
        .insert(economicEvents)
        .values({
          country: 'US',
          currency: 'USD',
          name: 'CPI m/m',
          normalisedName: 'cpi m/m',
          importance: 'HIGH',
        })
        .returning({ id: economicEvents.id });

      await expectConstraintViolation(
        () =>
          handle.db.insert(economicReleases).values({
            eventId: event!.id,
            scheduledAt: new Date('2026-09-10T12:30:00Z'),
            forecastValue: '0.3',
            ...provenanceColumns(),
            freshness: 'RECENT',
          }),
        'economic_releases_forecast_provenanced',
      );
    });

    it('stores macro revisions as separate vintages rather than overwriting', async () => {
      const [series] = await handle.db
        .select({ id: macroSeries.id })
        .from(macroSeries)
        .where(eq(macroSeries.seriesId, 'PAYEMS'))
        .limit(1);

      const common = {
        seriesRowId: series!.id,
        observationDate: '2026-07-01',
        ...provenanceColumns(),
        freshness: 'RECENT' as const,
      };
      await handle.db
        .insert(macroObservations)
        .values({ ...common, value: '159000', vintage: new Date('2026-08-01T12:30:00Z') });
      await handle.db
        .insert(macroObservations)
        .values({ ...common, value: '158200', vintage: new Date('2026-09-05T12:30:00Z') });

      const rows = await handle.db
        .select({ value: macroObservations.value })
        .from(macroObservations);
      // Both survive: overwriting would make an older analysis cite a number that
      // no longer exists.
      expect(rows).toHaveLength(2);
    });
  });

  // ── Job ledger ──────────────────────────────────────────────────────────

  describe('job ledger', () => {
    it('refuses two runs claiming the same slot', async () => {
      // The idempotency guarantee behind the ledger-driven runner: two triggers
      // firing for one slot cannot both execute it.
      const slot = new Date('2026-08-30T12:00:00Z');
      await handle.db
        .insert(jobRuns)
        .values({ jobName: 'ingest.tick', scheduledFor: slot, status: 'SUCCEEDED' });

      await expectConstraintViolation(
        () =>
          handle.db
            .insert(jobRuns)
            .values({ jobName: 'ingest.tick', scheduledFor: slot, status: 'RUNNING' }),
        'job_runs_name_slot_idx',
      );
    });

    it('allows the same job in a different slot', async () => {
      await handle.db.insert(jobRuns).values({
        jobName: 'ingest.tick',
        scheduledFor: new Date('2026-08-30T12:00:00Z'),
        status: 'SUCCEEDED',
      });
      await expect(
        handle.db.insert(jobRuns).values({
          jobName: 'ingest.tick',
          scheduledFor: new Date('2026-08-30T12:15:00Z'),
          status: 'SUCCEEDED',
        }),
      ).resolves.toBeDefined();
    });

    it('rejects a run that finished before it started', async () => {
      await expectConstraintViolation(
        () =>
          handle.db.insert(jobRuns).values({
            jobName: 'ingest.tick',
            scheduledFor: new Date('2026-08-30T12:00:00Z'),
            status: 'SUCCEEDED',
            startedAt: new Date('2026-08-30T12:00:10Z'),
            finishedAt: new Date('2026-08-30T12:00:05Z'),
          }),
        'job_runs_finished_after_started',
      );
    });
  });

  // ── Advisory locks ──────────────────────────────────────────────────────

  describe('advisory locks', () => {
    it('grants the lock inside a transaction', async () => {
      const acquired = await handle.db.transaction((tx) => tryAdvisoryLock(tx, 'job:ingest.tick'));
      expect(acquired).toBe(true);
    });

    it('releases the lock when the transaction ends', async () => {
      // Transaction scope is the whole reason for choosing this variant: it must
      // survive PgBouncer, and it must not leak when a job throws.
      await handle.db.transaction((tx) => tryAdvisoryLock(tx, 'job:ingest.tick'));
      const again = await handle.db.transaction((tx) => tryAdvisoryLock(tx, 'job:ingest.tick'));
      expect(again).toBe(true);
    });

    it('releases the lock even when the transaction fails', async () => {
      await handle.db
        .transaction(async (tx) => {
          await tryAdvisoryLock(tx, 'job:ingest.tick');
          throw new Error('job failed');
        })
        .catch(() => undefined);

      const acquired = await handle.db.transaction((tx) => tryAdvisoryLock(tx, 'job:ingest.tick'));
      expect(acquired).toBe(true);
    });

    it('derives a stable positive key from a lock name', () => {
      const key = lockKey('job:ingest.tick');
      expect(key).toBe(lockKey('job:ingest.tick'));
      expect(key).toBeGreaterThan(0n);
      expect(key).toBeLessThanOrEqual(0x7fff_ffff_ffff_ffffn);
      expect(key).not.toBe(lockKey('job:report.daily'));
    });
  });

  // ── Identity ────────────────────────────────────────────────────────────

  describe('users', () => {
    it('treats email uniqueness case-insensitively', async () => {
      // Allowing Sam@example.invalid beside sam@example.invalid would let an attacker register a
      // near-duplicate of a real account.
      await handle.db
        .insert(users)
        .values({ email: 'ahmed@example.com', passwordHash: 'x' });
      await expectConstraintViolation(
        () =>
          handle.db.insert(users).values({ email: 'Ahmed@Example.com', passwordHash: 'y' }),
        'users_email_lower_idx',
      );
    });
  });

  // ── Migration hygiene ───────────────────────────────────────────────────

  describe('migrations', () => {
    it('installs the lineage trigger', async () => {
      const rows = extractRows<{ tgname: string }>(
        await handle.db.execute(sql`
          SELECT tgname FROM pg_trigger WHERE tgname = 'analysis_statements_lineage_check'
        `),
      );
      expect(rows).toHaveLength(1);
    });

    it('maintains updated_at automatically', async () => {
      const analysisId = await newAnalysis();
      const [before] = await handle.db
        .select({ updatedAt: analyses.updatedAt })
        .from(analyses)
        .where(eq(analyses.id, analysisId));

      await handle.db
        .update(analyses)
        .set({ confidence: 'HIGH' })
        .where(eq(analyses.id, analysisId));

      const [after] = await handle.db
        .select({ updatedAt: analyses.updatedAt })
        .from(analyses)
        .where(eq(analyses.id, analysisId));

      expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(before!.updatedAt.getTime());
    });
  });
});
