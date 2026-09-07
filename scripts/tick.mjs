/**
 * Run one complete tick locally, through the same composition production uses.
 *
 * Not a rehearsal of the deployed path — the deployed path itself, minus HTTP. The route
 * at `/api/jobs/tick` authenticates, then calls `handleHttpTrigger` with the jobs from
 * `buildTick()`. This script calls the same two functions with the same environment. If
 * this works and the deployment does not, the difference is the platform, not the code.
 *
 *   node scripts/tick.mjs             # run whatever is due
 *   node scripts/tick.mjs --force     # ignore the ledger; run every job now
 *
 * `--force` exists because "due" is a function of when jobs last ran, and a first local
 * run of a job that is scheduled hourly will usually find nothing due. It runs the same
 * handlers through the same runner; only the slot changes.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

for (const line of readFileSync(join(repoRoot, '.env'), 'utf8').split(/\r?\n/)) {
  if (line === '' || line.startsWith('#')) continue;
  const eq = line.indexOf('=');
  if (eq < 0) continue;
  process.env[line.slice(0, eq)] = line.slice(eq + 1).trim();
}

const { createDb } = await import('../packages/db/dist/index.js');
const { buildTick, runDue, handleHttpTrigger } = await import('../packages/worker/dist/index.js');

const force = process.argv.includes('--force');
const handle = createDb({ connectionString: process.env['DATABASE_URL'] });
const now = new Date();

const rule = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);

rule(`ONE TICK — ${now.toISOString()}${force ? '  [--force: ignoring the ledger]' : ''}`);

const { jobs } = buildTick();
console.log(`${String(jobs.length)} jobs registered, in dependency order:\n`);
for (const job of jobs) {
  console.log(
    `  ${job.name.padEnd(20)} every ${String(Math.round(job.intervalMs / 60_000)).padStart(3)} min` +
      `   timeout ${String(Math.round(job.timeoutMs / 1000)).padStart(3)}s`,
  );
}

let result;
if (force) {
  /*
   * A distinct slot per run, so the unique key does not reject the second invocation of
   * the day as an already-claimed duplicate. The jobs and the runner are unchanged —
   * this only moves the slot, it does not bypass the claim.
   */
  result = await runDue({
    db: handle.db,
    jobs: jobs.map((job) => ({ ...job, intervalMs: 1000 })),
    now,
    triggeredBy: 'local-force',
    budgetMs: 600_000,
  });
} else {
  // The deployed path exactly: the same handler the route calls, authenticated the same
  // way, so an authentication mistake shows up here rather than in production.
  const secret = process.env['JOB_TRIGGER_SECRET'] ?? '';
  const response = await handleHttpTrigger(
    { secret, now },
    {
      db: handle.db,
      jobs,
      expectedSecret: secret,
      budgetMs: 600_000,
      onPreflightFailure: (error) => {
        console.error('preflight failed:', error instanceof Error ? error.message : error);
      },
    },
  );
  if (response.status !== 200) {
    console.error(`\nHTTP ${String(response.status)}:`, response.body);
    await handle.close();
    process.exit(1);
  }
  result = response.body;
}

rule('WHAT RAN');
console.log(`triggered by ${result.triggeredBy}, started ${result.startedAt.toISOString()}\n`);

let failures = 0;
for (const run of result.runs) {
  if (run.status === 'FAILED' || run.status === 'TIMED_OUT') failures += 1;
  console.log(
    `  ${run.jobName.padEnd(20)} ${run.status.padEnd(16)} ` +
      `${String(run.durationMs).padStart(6)}ms  items=${String(run.itemsProcessed)}`,
  );
  if (run.error !== undefined) console.log(`      error: ${run.error}`);
}

if (result.runs.length === 0) {
  console.log('  (nothing was due — run with --force to exercise every job now)');
}

console.log(
  `\n${String(result.runs.length)} job(s) attempted, ${String(failures)} failed.`,
);

await handle.close();
process.exit(failures === 0 ? 0 : 1);
