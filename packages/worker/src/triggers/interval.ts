/**
 * Interval trigger — a long-lived process ticking itself.
 *
 * Used locally and on the always-on VM profile. It holds no schedule state: every
 * tick simply calls `runDue`, so restarting the process changes nothing about what
 * runs next.
 */

import type { Database } from '@forex-agent/db';
import { runDue, type JobDefinition, type RunDueResult } from '../runner.js';
import { assertWorkerPreflight } from '../preflight.js';

export interface IntervalTriggerOptions {
  readonly db: Database;
  readonly jobs: readonly JobDefinition[];
  /** How often to check for due work. Not the job cadence — jobs define their own. */
  readonly tickMs?: number;
  readonly onTick?: (result: RunDueResult) => void;
  readonly onError?: (error: unknown) => void;
}

export interface RunningTrigger {
  stop(): void;
}

export function startIntervalTrigger(options: IntervalTriggerOptions): RunningTrigger {
  const tickMs = options.tickMs ?? 60_000;
  let stopped = false;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    // A slow tick must not overlap the next one; the advisory lock would catch it,
    // but not starting is cheaper than starting and being refused.
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      // Fails closed: a database that disagrees with the seed does not get ingested
      // into. Cached on success, so this is a handful of selects every six hours
      // rather than on every tick.
      await assertWorkerPreflight(options.db);
      const result = await runDue({
        db: options.db,
        jobs: options.jobs,
        now: new Date(),
        triggeredBy: 'interval',
      });
      options.onTick?.(result);
    } catch (e) {
      // A failing tick must never kill the loop — the next one may well succeed.
      options.onError?.(e);
    } finally {
      inFlight = false;
    }
  };

  void tick();
  const handle = setInterval(() => void tick(), tickMs);

  return {
    stop() {
      stopped = true;
      clearInterval(handle);
    },
  };
}
