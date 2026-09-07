/**
 * Event risk (PRD_V1 §8.7, master §47).
 *
 * A reading can be entirely correct and about to be invalidated. Ten minutes before a
 * CPI print, everything the engine knows is true and almost worthless — not because
 * the data is stale, but because the thing it describes is about to change. That is a
 * statement about the world rather than about our data, which is why it caps
 * confidence separately from coverage and freshness instead of being folded into them.
 */

import type { Importance } from '@forex-agent/core';
import type { UpcomingReleaseView } from './inputs.js';

export interface EventRiskConfig {
  /** Releases inside this window are surfaced as a warning. */
  readonly warnWindowMs: number;
  /** Releases inside this window are "imminent" and cap confidence at MEDIUM. */
  readonly imminentWindowMs: number;
  /** Only these importance levels count. HIGH by default. */
  readonly importanceLevels?: readonly Importance[];
}

export interface EventRiskWarning {
  readonly eventName: string;
  readonly country: string;
  readonly scheduledAt: Date;
  readonly importance: Importance;
  readonly minutesUntil: number;
  readonly imminent: boolean;
  readonly factId: string;
  /** The standard caution, rendered on the dashboard and in the email. */
  readonly caution: string;
}

export interface EventRiskResult {
  /** Ordered soonest first. */
  readonly warnings: readonly EventRiskWarning[];
  /** True when any HIGH-impact release is inside the imminent window. */
  readonly imminent: boolean;
}

const DEFAULT_LEVELS: readonly Importance[] = ['HIGH'];

export function assessEventRisk(
  upcoming: readonly UpcomingReleaseView[],
  now: Date,
  config: EventRiskConfig,
): EventRiskResult {
  const levels = new Set(config.importanceLevels ?? DEFAULT_LEVELS);

  const warnings = upcoming
    .filter((r) => levels.has(r.importance))
    .map((r) => ({ r, deltaMs: r.scheduledAt.getTime() - now.getTime() }))
    // Strictly future. A release that has already happened is not a risk to the
    // current reading — it is part of it, and warning about it would tell the user to
    // discount data that already includes the event.
    .filter(({ deltaMs }) => deltaMs > 0 && deltaMs <= config.warnWindowMs)
    .sort((a, b) => a.deltaMs - b.deltaMs)
    .map(({ r, deltaMs }): EventRiskWarning => {
      const minutesUntil = Math.round(deltaMs / 60_000);
      const imminent = deltaMs <= config.imminentWindowMs;
      return {
        eventName: r.eventName,
        country: r.country,
        scheduledAt: r.scheduledAt,
        importance: r.importance,
        minutesUntil,
        imminent,
        factId: r.factId,
        caution: caution(r.eventName, r.country, minutesUntil, imminent),
      };
    });

  return { warnings, imminent: warnings.some((w) => w.imminent) };
}

/**
 * The standard caution.
 *
 * Says the reading *may be invalidated*, not what the release will show or which way
 * the price will move. Amendment A3: no unmeasured predictive claims, and a
 * forthcoming release is exactly where that temptation is strongest.
 */
function caution(
  eventName: string,
  country: string,
  minutesUntil: number,
  imminent: boolean,
): string {
  const when =
    minutesUntil < 60
      ? `in ${String(minutesUntil)} minutes`
      : `in about ${String(Math.round(minutesUntil / 60))} hours`;
  const emphasis = imminent
    ? 'The current reading may be invalidated by it, and confidence is capped accordingly.'
    : 'The current reading may be invalidated by it.';
  return `${country} ${eventName} is scheduled ${when}. ${emphasis}`;
}
