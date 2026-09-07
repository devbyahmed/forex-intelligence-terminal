/**
 * What an on-demand refresh costs, and whether it can be afforded.
 *
 * **A refresh spends a shared, finite, daily budget.** The free tiers this product
 * runs on are measured in hundreds of calls a day (LIMITS.md §6): Twelve Data allows
 * 800 credits, FRED throttles at ~120 requests a minute with no `Retry-After`. A
 * refresh button that quietly burns the allowance is not a convenience — it is a way
 * for a curious user at 10am to break the scheduled run at 4pm, and the failure lands
 * hours later on someone who did nothing.
 *
 * So the cost is computed **before** anything is spent, shown to the user, and refused
 * when the remaining budget will not cover it. Three properties follow, each chosen
 * against a plausible alternative:
 *
 * - **The estimate is derived from the same limits the gate enforces**, not written
 *   down separately. A cost display that drifts from the real cost is worse than none:
 *   it teaches people to trust a number that is wrong.
 * - **A refusal names the provider, the shortfall and when it resets.** "Try again
 *   later" tells the user nothing they can act on.
 * - **The scheduled run is protected by a reserve.** On-demand refresh may spend down
 *   to the reserve and no further, so the day's automated ingestion cannot be starved
 *   by interactive use. Without it the budget is first-come-first-served and the
 *   product's own pipeline loses.
 */


import { providerStatus, type Database } from '@forex-agent/db';

export interface ProviderCost {
  readonly providerId: string;
  /** What one refresh consumes, in the provider's own units. */
  readonly cost: number;
  readonly unit: 'credits' | 'requests';
  readonly usedToday: number;
  readonly dailyLimit: number | null;
  /** `dailyLimit − usedToday`, or null where the provider has no daily cap. */
  readonly remaining: number | null;
  /** Kept back for the scheduled pipeline. */
  readonly reserved: number;
  readonly resetsAt: Date | null;
  readonly affordable: boolean;
}

export interface RefreshBudget {
  readonly providers: readonly ProviderCost[];
  readonly affordable: boolean;
  /** Plain-language reason, when it is not. Empty when it is. */
  readonly refusal: string;
  /** One line for the button: what pressing it will spend. */
  readonly costSummary: string;
}

/**
 * How much of each provider's daily allowance is held back for scheduled ingestion.
 *
 * Expressed as a fraction rather than a count so it stays correct if a limit changes.
 * A third is roughly what the 15-minute consolidated tick needs over a remaining
 * half-day (LIMITS.md §4).
 */
export const SCHEDULED_RESERVE_FRACTION = 1 / 3;

/** What one on-demand refresh costs per provider, from the same limits the gate uses. */
export interface RefreshCostModel {
  readonly providerId: string;
  readonly cost: number;
  readonly unit: 'credits' | 'requests';
  readonly dailyLimit: number | null;
}

export async function estimateRefreshBudget(
  db: Database,
  model: readonly RefreshCostModel[],
): Promise<RefreshBudget> {
  // Typed builder rather than raw SQL. A sibling query in `systemStatus.ts` hand-wrote
  // a column that does not exist and shipped a 500 to the dashboard; raw SQL against a
  // schema the types already describe buys nothing and costs that.
  const statusRows = await db
    .select({
      providerId: providerStatus.providerId,
      quotaUsedToday: providerStatus.quotaUsedToday,
      quotaLimitDaily: providerStatus.quotaLimitDaily,
      quotaResetAt: providerStatus.quotaResetAt,
    })
    .from(providerStatus);
  const byProvider = new Map(statusRows.map((r) => [r.providerId, r]));

  const providers: ProviderCost[] = model.map((m) => {
    const row = byProvider.get(m.providerId);
    const usedToday = row?.quotaUsedToday ?? 0;
    /*
     * A stored NULL means "this provider has no daily cap" and is authoritative. A
     * missing row means "we have not called this provider today" and says nothing
     * about its limit, so the declared one applies.
     *
     * Collapsing the two with `??` reads the same and is wrong: it would resurrect a
     * cap the provider does not have, and refuse refreshes against a limit that
     * exists only in our model.
     */
    const dailyLimit = row === undefined ? m.dailyLimit : row.quotaLimitDaily;
    const reserved = dailyLimit === null ? 0 : Math.ceil(dailyLimit * SCHEDULED_RESERVE_FRACTION);
    const remaining = dailyLimit === null ? null : dailyLimit - usedToday;

    // Spendable is what is left *above the reserve*, never the raw remainder.
    const spendable = remaining === null ? null : remaining - reserved;
    const resetsAt = row?.quotaResetAt ?? null;

    return {
      providerId: m.providerId,
      cost: m.cost,
      unit: m.unit,
      usedToday,
      dailyLimit,
      remaining,
      reserved,
      resetsAt,
      affordable: spendable === null || spendable >= m.cost,
    };
  });

  const blocked = providers.filter((p) => !p.affordable);

  return {
    providers,
    affordable: blocked.length === 0,
    refusal: blocked.length === 0 ? '' : describeRefusal(blocked),
    costSummary: describeCost(providers),
  };
}

/**
 * The refusal, phrased so a user can act on it.
 *
 * Names the provider, what is left, what is held back and when it resets. "Try again
 * later" would be shorter and would tell them nothing — they cannot know whether later
 * means ten minutes or tomorrow.
 */
function describeRefusal(blocked: readonly ProviderCost[]): string {
  return blocked
    .map((p) => {
      const remaining = p.remaining ?? 0;
      const spendable = Math.max(0, remaining - p.reserved);
      const when =
        p.resetsAt === null
          ? 'at the next daily reset'
          : `at ${p.resetsAt.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
      return (
        `${p.providerId} has ${String(spendable)} of its ${String(p.dailyLimit ?? 0)} daily ` +
        `${p.unit} available for on-demand use (${String(p.reserved)} are held back for the ` +
        `scheduled run, ${String(p.usedToday)} already spent today), and this refresh needs ` +
        `${String(p.cost)}. The allowance resets ${when}.`
      );
    })
    .join(' ');
}

/** What pressing the button will spend, shown before it is pressed. */
function describeCost(providers: readonly ProviderCost[]): string {
  const parts = providers
    .filter((p) => p.cost > 0)
    // Singularised: "1 requests" reads as a bug in a sentence whose whole job is to be
    // trusted about a number.
    .map((p) => `${String(p.cost)} ${p.cost === 1 ? p.unit.replace(/s$/, '') : p.unit} from ${p.providerId}`);
  if (parts.length === 0) return 'This refresh makes no provider calls.';
  if (parts.length === 1) return `Refreshing costs ${parts[0] ?? ''}.`;
  const last = parts[parts.length - 1] ?? '';
  return `Refreshing costs ${parts.slice(0, -1).join(', ')} and ${last}.`;
}

/**
 * The V1 cost model.
 *
 * A refresh re-ingests macro, calendar and news, then re-runs the analysis. The counts
 * are what those jobs actually issue: one FRED request per active series plus one for
 * release dates, one ForexFactory fetch, one conditional GET per news feed, and one
 * Twelve Data credit for the spot quote.
 *
 * Kept beside the jobs it describes rather than in configuration, because a cost model
 * that can be edited without editing the job is a cost model that will one day be
 * wrong in a way nobody notices.
 */
export const V1_REFRESH_COST: readonly RefreshCostModel[] = [
  { providerId: 'fred', cost: 13, unit: 'requests', dailyLimit: null },
  { providerId: 'forexfactory', cost: 1, unit: 'requests', dailyLimit: null },
  { providerId: 'twelvedata', cost: 1, unit: 'credits', dailyLimit: 800 },
];
