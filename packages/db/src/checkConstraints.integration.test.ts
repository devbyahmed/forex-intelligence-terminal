/**
 * CHECK-constraint soundness: the NULL-versus-FALSE trap.
 *
 * A Postgres CHECK constraint rejects a row only when its expression evaluates to
 * **FALSE**. An expression that evaluates to **NULL** passes. So a guard written with
 * a function that returns NULL for the very input it was meant to forbid does not
 * merely fail to help — it silently permits exactly what it forbids, while reading
 * like protection.
 *
 * This happened here. `macro_series_publication_days_valid` was first written as
 * `array_length(expected_publication_days, 1) >= 1` to reject an empty calendar. But
 * `array_length('{}', 1)` is NULL, not 0, so the predicate was NULL and Postgres
 * accepted the empty array. An empty publication calendar makes
 * `publicationDaysElapsed` find no day to count, freezing a series' age at zero: it
 * would have read `LIVE` for ever, at full confidence weight, however long the data
 * had been missing. The one failure mode the constraint existed to prevent was the
 * one it let through.
 *
 * The tests below assert the *predicates themselves*, not just row rejection. Two of
 * the three constraints audited are shadowed at runtime by the lineage trigger, which
 * fires first — so a row-level test would pass whether the CHECK were sound or not,
 * and would prove nothing about the constraint. Asserting `FALSE` rather than
 * `NOT TRUE` is the whole point: `NOT TRUE` is satisfied by NULL.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb, hasTestDatabase, type TestDb } from './test-support.js';

const describeIfDb = hasTestDatabase() ? describe : describe.skip;

interface CheckConstraint {
  readonly t: string;
  readonly name: string;
  readonly def: string;
}

describeIfDb('CHECK constraint soundness', () => {
  let handle: TestDb;

  beforeAll(async () => {
    handle = await createTestDb();
  });

  afterAll(async () => {
    await handle.close();
  });

  it('demonstrates the trap: array_length is NULL on an empty array, cardinality is 0', async () => {
    // The single fact behind the bug, pinned so nobody re-derives it the hard way.
    const [row] = (
      await handle.db.execute(sql`
        SELECT array_length('{}'::smallint[], 1)        AS al,
               (array_length('{}'::smallint[], 1) >= 1) AS al_predicate,
               cardinality('{}'::smallint[])            AS card,
               (cardinality('{}'::smallint[]) >= 1)     AS card_predicate
      `)
    ).rows as { al: number | null; al_predicate: boolean | null; card: number; card_predicate: boolean }[];

    expect(row?.al).toBeNull();
    // NULL, not false — which is why the constraint passed.
    expect(row?.al_predicate).toBeNull();
    expect(row?.card).toBe(0);
    expect(row?.card_predicate).toBe(false);
  });

  it('rejects an empty publication calendar with FALSE, not NULL', async () => {
    const [row] = (
      await handle.db.execute(sql`
        SELECT (cardinality('{}'::smallint[]) >= 1
                AND '{}'::smallint[] <@ ARRAY[0,1,2,3,4,5,6]::smallint[]) AS verdict
      `)
    ).rows as { verdict: boolean | null }[];

    // `toBe(false)` deliberately, not `toBeFalsy()`: NULL is falsy in JS but passes
    // in Postgres, so a loose assertion here would reproduce the original bug.
    expect(row?.verdict).toBe(false);
  });

  it('rejects an out-of-range weekday with FALSE, not NULL', async () => {
    const [row] = (
      await handle.db.execute(sql`
        SELECT (cardinality('{9}'::smallint[]) >= 1
                AND '{9}'::smallint[] <@ ARRAY[0,1,2,3,4,5,6]::smallint[]) AS verdict
      `)
    ).rows as { verdict: boolean | null }[];

    expect(row?.verdict).toBe(false);
  });

  it('rejects an empty derivation for a derived statement with FALSE, not NULL', async () => {
    // `derived_requires_parents` is shadowed by the lineage trigger at runtime, so
    // this asserts the predicate directly. Amendment A2 depends on it: an
    // INTERPRETATION with no parents is a conclusion without evidence.
    const [row] = (
      await handle.db.execute(sql`SELECT (cardinality('{}'::uuid[]) >= 1) AS verdict`)
    ).rows as { verdict: boolean | null }[];

    expect(row?.verdict).toBe(false);
  });

  it('has no CHECK constraint relying on a function that returns NULL for valid input', async () => {
    // The audit, kept as a test so it re-runs rather than being a one-off. Every
    // function permitted here has been checked by hand against its NULL behaviour;
    // adding a new one is meant to fail this and force the same review.
    const REVIEWED_SAFE = new Set([
      // NULL only when its argument is NULL, and every array column is NOT NULL
      // (asserted separately below). Returns 0 — not NULL — for an empty array.
      'cardinality',
    ]);
    const NOT_FUNCTIONS = new Set([
      'check', 'and', 'or', 'not', 'in', 'between', 'is', 'null',
      'integer', 'double', 'precision', 'smallint', 'numeric', 'text',
      'timestamp', 'interval', 'array',
    ]);

    const constraints = (
      await handle.db.execute(sql`
        SELECT rel.relname AS t, con.conname AS name, pg_get_constraintdef(con.oid) AS def
        FROM pg_constraint con
        JOIN pg_class rel ON rel.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = rel.relnamespace
        WHERE con.contype = 'c' AND n.nspname = 'public'
      `)
    ).rows as unknown as CheckConstraint[];

    const unreviewed: string[] = [];
    for (const c of constraints) {
      const fns = [...c.def.matchAll(/\b([a-z_]+)\s*\(/g)]
        .map((m) => m[1] ?? '')
        .filter((f) => f !== '' && !NOT_FUNCTIONS.has(f) && !REVIEWED_SAFE.has(f));
      for (const f of new Set(fns)) unreviewed.push(`${c.t}.${c.name} uses ${f}()`);
    }

    // If this fails, the new function needs the same review `array_length` did NOT
    // get: what does it return for empty, zero-length or boundary input, and does
    // that make the predicate NULL rather than FALSE?
    expect(unreviewed).toEqual([]);
  });

  it('has every array column NOT NULL, which is what makes cardinality safe', async () => {
    // `cardinality(NULL)` is NULL. The three cardinality-based constraints are sound
    // only because no array column can hold NULL; making one nullable would reopen
    // the trap without touching any constraint.
    const nullableArrays = (
      await handle.db.execute(sql`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND data_type = 'ARRAY' AND is_nullable = 'YES'
      `)
    ).rows as { table_name: string; column_name: string }[];

    expect(nullableArrays.map((c) => `${c.table_name}.${c.column_name}`)).toEqual([]);
  });
});
