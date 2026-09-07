/**
 * The refresh budget.
 *
 * A refresh spends a shared daily allowance measured in hundreds of calls. The failure
 * this guards against is specific and nasty: a curious user pressing refresh at 10am
 * burns the day's quota, and the scheduled run fails at 4pm — hours later, on someone
 * who did nothing, with an error that points at the wrong cause.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, hasTestDatabase, type TestDb } from '@forex-agent/db/test-support';
import {
  SCHEDULED_RESERVE_FRACTION,
  V1_REFRESH_COST,
  estimateRefreshBudget,
  type RefreshCostModel,
} from './refreshBudget.js';

const describeIfDb = hasTestDatabase() ? describe : describe.skip;

const MODEL: readonly RefreshCostModel[] = [
  { providerId: 'twelvedata', cost: 10, unit: 'credits', dailyLimit: 800 },
];

describeIfDb('refresh budget (real Postgres)', () => {
  let handle: TestDb;

  beforeAll(async () => {
    handle = await createTestDb();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await handle.db.execute(sql`DELETE FROM provider_status`);
  });

  const setUsage = async (used: number, limit: number | null): Promise<void> => {
    await handle.db.execute(sql`
      INSERT INTO provider_status (provider_id, domain, tier, quota_used_today, quota_limit_daily, quota_reset_at)
      VALUES ('twelvedata', 'MARKET_DATA', 2, ${used}, ${limit}, now() + interval '6 hours')
    `);
  };

  it('reports the cost before anything is spent', async () => {
    await setUsage(0, 800);
    const budget = await estimateRefreshBudget(handle.db, MODEL);
    expect(budget.costSummary).toBe('Refreshing costs 10 credits from twelvedata.');
    expect(budget.affordable).toBe(true);
  });

  it('holds back a reserve for the scheduled run', async () => {
    // Without this the budget is first-come-first-served and the product's own
    // pipeline loses to interactive use.
    await setUsage(0, 800);
    const budget = await estimateRefreshBudget(handle.db, MODEL);
    const provider = budget.providers[0];
    expect(provider?.reserved).toBe(Math.ceil(800 * SCHEDULED_RESERVE_FRACTION));
    expect(provider?.remaining).toBe(800);
  });

  it('refuses once spending would eat into the reserve', async () => {
    // 800 limit, 267 reserved, so 533 spendable. Using 530 leaves 3 — under the 10
    // this refresh costs, even though 270 raw credits remain.
    await setUsage(530, 800);
    const budget = await estimateRefreshBudget(handle.db, MODEL);
    expect(budget.affordable).toBe(false);
    expect(budget.providers[0]?.remaining).toBe(270);
  });

  it('allows spending right up to the reserve boundary', async () => {
    await setUsage(523, 800);
    const budget = await estimateRefreshBudget(handle.db, MODEL);
    // 800 − 523 = 277 remaining, minus 267 reserved = 10 spendable, cost is 10.
    expect(budget.affordable).toBe(true);
  });

  it('names the provider, the shortfall and the reset time in a refusal', async () => {
    // "Try again later" tells a user nothing they can act on — they cannot know
    // whether later means ten minutes or tomorrow.
    await setUsage(795, 800);
    const budget = await estimateRefreshBudget(handle.db, MODEL);

    expect(budget.affordable).toBe(false);
    expect(budget.refusal).toContain('twelvedata');
    expect(budget.refusal).toContain('held back for the scheduled run');
    expect(budget.refusal).toContain('795 already spent today');
    expect(budget.refusal).toContain('needs 10');
    expect(budget.refusal).toMatch(/resets at \d{4}-\d{2}-\d{2}/);
  });

  it('treats an uncapped provider as always affordable', async () => {
    // FRED has a per-minute ceiling but no daily cap. Inventing one would refuse
    // refreshes for a limit that does not exist.
    await setUsage(10_000, null);
    const budget = await estimateRefreshBudget(handle.db, MODEL);
    expect(budget.providers[0]?.dailyLimit).toBeNull();
    expect(budget.affordable).toBe(true);
  });

  it('treats an unseen provider as unused rather than unavailable', async () => {
    // A provider with no status row has made no calls today. Defaulting to "blocked"
    // would make the first refresh after a reset impossible.
    const budget = await estimateRefreshBudget(handle.db, MODEL);
    expect(budget.providers[0]?.usedToday).toBe(0);
    expect(budget.affordable).toBe(true);
  });

  it('blocks when any single provider cannot afford it', async () => {
    // Partial refreshes are worse than none: they produce an analysis built on a mix
    // of fresh and stale inputs, with nothing on screen saying which is which.
    await setUsage(795, 800);
    const budget = await estimateRefreshBudget(handle.db, [
      ...MODEL,
      { providerId: 'fred', cost: 13, unit: 'requests', dailyLimit: null },
    ]);
    expect(budget.affordable).toBe(false);
    expect(budget.providers).toHaveLength(2);
  });
});

describe('the shipped cost model', () => {
  it('charges for every provider a refresh actually calls', () => {
    const ids = V1_REFRESH_COST.map((c) => c.providerId).sort();
    expect(ids).toEqual(['forexfactory', 'fred', 'twelvedata']);
  });

  it('charges FRED once per active series plus the release-dates call', () => {
    // Twelve series plus one. A cost model that understates is worse than none: it
    // teaches people to trust a number that is wrong.
    expect(V1_REFRESH_COST.find((c) => c.providerId === 'fred')?.cost).toBe(13);
  });

  it('records Twelve Data as the only provider with a daily cap', () => {
    // 800 credits/day on the Basic plan, measured 2026-08-30 (LIMITS.md §6.1).
    const capped = V1_REFRESH_COST.filter((c) => c.dailyLimit !== null);
    expect(capped).toHaveLength(1);
    expect(capped[0]?.providerId).toBe('twelvedata');
    expect(capped[0]?.dailyLimit).toBe(800);
  });
});
