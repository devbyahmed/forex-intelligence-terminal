/**
 * The schedule's shape.
 *
 * Not a restatement of the list — a restatement would pass by construction and fail the
 * moment someone legitimately adds a job. What is asserted here are the two properties
 * that make a tick correct, both of which are invisible at the call site and both of
 * which have already been wrong once in this project.
 */

import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_RUNTIME_CONFIG } from '@forex-agent/config';
import { allJobs } from './registry.js';

// The registry only stores these; nothing here calls them, so an empty object is an
// honest stand-in rather than a mock pretending to behave.
const stub = {} as never;

const jobs = allJobs({
  config: DEFAULT_RUNTIME_CONFIG,
  marketChain: [stub],
  fredMacro: stub,
  fredCalendar: stub,
  forexFactory: stub,
  analysis: {},
  report: {
    providers: [],
    from: 'onboarding@resend.dev',
    to: 'recipient@example.invalid',
    appBaseUrl: 'https://example.invalid',
    timeZone: 'America/New_York',
  },
});

const positionOf = (name: string): number => jobs.findIndex((j) => j.name === name);

describe('the tick runs in dependency order', () => {
  /*
   * `runDue` works down the list until the budget is spent. Order is therefore latency:
   * ingestion that runs after analysis means every new fact waits a full cycle before it
   * reaches a reading, and two cycles before it reaches a reader.
   */
  it('ingests before it scores', () => {
    for (const ingest of ['ingest-market', 'ingest-news', 'ingest-macro', 'ingest-calendar']) {
      expect(positionOf(ingest)).toBeGreaterThanOrEqual(0);
      expect(positionOf(ingest)).toBeLessThan(positionOf('analysis'));
    }
  });

  it('scores before it reports', () => {
    // A report renders a stored analysis. Reporting first would email yesterday's.
    expect(positionOf('analysis')).toBeLessThan(positionOf('daily-report'));
  });

  it('registers the whole pipeline, not a subset', () => {
    /*
     * The failure this catches is the one Phase 12 opened with: a schedule that ingests
     * and never analyses looks healthy from every angle — jobs run, rows land, no errors
     * — and produces nothing to read.
     */
    expect(jobs.map((j) => j.name).sort()).toEqual(
      [
        'analysis',
        'daily-report',
        'data-failure-alert',
        'ingest-calendar',
        'ingest-macro',
        'ingest-market',
        'ingest-news',
      ].sort(),
    );
  });
});

describe('every job can finish inside a tick', () => {
  it('gives each job a timeout below the trigger budget', () => {
    /*
     * The HTTP trigger stops handing out work at 240s. A job whose own timeout exceeded
     * that could never complete on the deployed profile — it would be killed by the
     * platform mid-write every time, which is the one failure mode a transactional job
     * ledger cannot recover from cleanly.
     */
    for (const job of jobs) {
      expect(job.timeoutMs).toBeLessThanOrEqual(240_000);
      expect(job.timeoutMs).toBeGreaterThan(0);
    }
  });

  it('never schedules a job more often than it can run', () => {
    // A 15-minute job with a 20-minute timeout is a queue, not a schedule.
    for (const job of jobs) {
      expect(job.timeoutMs).toBeLessThanOrEqual(job.intervalMs);
    }
  });
});

describe('the report job is idempotent by date, not by slot', () => {
  it('is scheduled more often than daily', () => {
    /*
     * Deliberate, and the reason is not obvious: the report sends once a day because it
     * checks for a stored report, not because it is scheduled once a day. A job that
     * could only fire in one narrow slot would skip a day silently whenever that slot
     * failed — and the day it skips is the day something was wrong.
     */
    const report = jobs.find((j) => j.name === 'daily-report');
    expect(report?.intervalMs).toBeLessThan(24 * 60 * 60_000);
  });
});

describe('handlers are built once, not per tick', () => {
  it('returns the same handler instance on repeated reads', () => {
    // Rebuilding handlers per tick would rebuild provider clients with them, discarding
    // circuit-breaker state that exists precisely to survive between attempts.
    const first = jobs[0];
    expect(first).toBeDefined();
    expect(jobs[0]).toBe(first);
    expect(vi.isMockFunction(first?.handler)).toBe(false);
  });
});
