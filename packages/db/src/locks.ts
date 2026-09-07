/**
 * Postgres advisory locks.
 *
 * **Transaction-scoped only.** `pg_advisory_lock` is session-scoped, and Neon and
 * Supabase pool connections through PgBouncer in transaction mode — where a session
 * lock is released to the pool mid-hold and is therefore silently ineffective. A
 * lock that looks like it works but does not is worse than no lock, so the
 * session-scoped variant is not exposed by this module at all.
 */

import { sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import type { Transaction } from './client.js';

/**
 * Map an arbitrary lock name to the bigint key Postgres advisory locks require.
 * Truncating a SHA-256 to 63 bits keeps it positive and collision-resistant enough
 * for the handful of named locks this system uses.
 */
export function lockKey(name: string): bigint {
  const digest = createHash('sha256').update(name).digest();
  return digest.readBigUInt64BE(0) & 0x7fff_ffff_ffff_ffffn;
}

/**
 * Try to take the lock without waiting. Returns false if another transaction holds
 * it. Released automatically when the transaction ends, including on error — which
 * is precisely why the transaction-scoped variant is the safe one.
 */
export async function tryAdvisoryLock(tx: Transaction, name: string): Promise<boolean> {
  const key = lockKey(name);
  const rows = await tx.execute<{ locked: boolean }>(
    sql`select pg_try_advisory_xact_lock(${key}) as locked`,
  );
  const first = (rows as unknown as { rows?: { locked: boolean }[] }).rows?.[0]
    ?? (rows as unknown as { locked: boolean }[])[0];
  return first?.locked === true;
}

/**
 * Run `fn` while holding the named lock, or return `null` if it is already held.
 *
 * Non-blocking by design: a scheduled job whose previous run is still going should
 * be skipped, not queued. Queuing would let a slow job accumulate a backlog of
 * overlapping invocations until the database runs out of connections.
 */
export async function withAdvisoryLock<T>(
  tx: Transaction,
  name: string,
  fn: () => Promise<T>,
): Promise<T | null> {
  const acquired = await tryAdvisoryLock(tx, name);
  if (!acquired) return null;
  return fn();
}
