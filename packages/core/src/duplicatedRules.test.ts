/**
 * One definition per rule — for constant tables, not just regex sets.
 *
 * Three duplicated-rule defects have now been found in this codebase, each in a
 * different shape:
 *
 *  1. **A regex rule set.** The prohibited-claim patterns existed in `guards.ts` and
 *     again, re-typed, in a report test. They disagreed within minutes.
 *  2. **A number in prose.** ARCHITECTURE.md claimed "27 CHECK constraints"; the schema
 *     had drifted to 33.
 *  3. **A constant table.** `TIER_WEIGHT` was defined in `core/vocab.ts`,
 *     `engines/fundamental/factor.ts` and privately in `engines/news/aggregate.ts` —
 *     three identical copies.
 *
 * The third is the most dangerous of the three, because identical copies pass every
 * test. They agree until someone reweights tier 3, updates two of them, and the news
 * aggregate goes on scoring by the old table with nothing to notice: no type error, no
 * failing test, no visible symptom — just two parts of the product disagreeing about how
 * much a Tier 3 source is worth.
 *
 * So this scans for value-map literals defined in more than one place. It is the
 * companion to `singleSourceOfTruth.test.ts`, which does the same for pattern sets.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TIER_WEIGHT } from './vocab.js';
import { FRESHNESS_WEIGHT } from './freshness.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.next', '.git', 'test-results']);

function sourceFiles(includeTests: boolean): readonly string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP_DIRECTORIES.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith('.ts') && !entry.endsWith('.tsx')) continue;
      if (!includeTests && entry.endsWith('.test.ts')) continue;
      out.push(full);
    }
  };
  walk(join(REPO_ROOT, 'packages'));
  walk(join(REPO_ROOT, 'apps'));
  return out;
}

const relativePath = (file: string): string => relative(REPO_ROOT, file).replace(/\\/g, '/');

/**
 * Files that define a rule, keyed by the rule's name.
 *
 * A **definition** is an assignment of an object or array literal to a named constant.
 * An import, a re-export or a use is not a definition — the point is to find second
 * copies, not second references.
 */
function definitionsOf(name: string, files: readonly string[]): readonly string[] {
  const definition = new RegExp(
    // `const NAME ... = {` or `= [`, allowing a type annotation between.
    String.raw`\bconst\s+${name}\b[^=\n]*=\s*[{[]`,
  );
  const reExport = new RegExp(String.raw`export\s*\{[^}]*\b${name}\b[^}]*\}\s*from`);

  return files
    .filter((file) => {
      const source = readFileSync(file, 'utf8');
      // A re-export names the constant but does not define it.
      if (reExport.test(source)) return false;
      return definition.test(source);
    })
    .map(relativePath);
}

describe('rule tables have exactly one definition', () => {
  const production = sourceFiles(false);

  it('scans a meaningful number of files', () => {
    expect(production.length).toBeGreaterThan(50);
  });

  /*
   * Each entry is a rule whose value carries product meaning: change it and readings
   * change. A second copy is a silent disagreement waiting for a one-sided edit.
   */
  const RULES: readonly { readonly name: string; readonly canonical: string }[] = [
    { name: 'TIER_WEIGHT', canonical: 'packages/core/src/vocab.ts' },
    { name: 'FRESHNESS_WEIGHT', canonical: 'packages/core/src/freshness.ts' },
    { name: 'DEFAULT_FACTOR_CONFIG', canonical: 'packages/config/src/runtime.ts' },
    { name: 'DEFAULT_NORMALISATION', canonical: 'packages/config/src/runtime.ts' },
    { name: 'DEFAULT_CONFIDENCE', canonical: 'packages/config/src/runtime.ts' },
    { name: 'DEFAULT_FRESHNESS', canonical: 'packages/config/src/runtime.ts' },
    { name: 'DEFAULT_INFLATION_NET_RULE', canonical: 'packages/config/src/runtime.ts' },
    { name: 'DEFAULT_LOOKBACK_DAYS', canonical: 'packages/worker/src/jobs/ingestMacro.ts' },
    { name: 'OBSERVATIONS_PER_YEAR', canonical: 'packages/engines/src/fundamental/viability.ts' },
    { name: 'FACTOR_REQUIREMENTS', canonical: 'packages/engines/src/fundamental/viability.ts' },
    { name: 'ATTRIBUTION_OF', canonical: 'packages/engines/src/fundamental/factor.ts' },
    { name: 'V1_REFRESH_COST', canonical: 'packages/worker/src/analysis/refreshBudget.ts' },
  ];

  for (const rule of RULES) {
    it(`${rule.name} is defined only in ${rule.canonical}`, () => {
      const definitions = definitionsOf(rule.name, production);

      /*
       * If this fails, import the constant instead of redefining it. Identical copies
       * are the dangerous case, not the divergent ones: they pass every test until a
       * one-sided edit, and then two parts of the product disagree with no symptom.
       */
      expect(definitions).toEqual([rule.canonical]);
    });
  }

  it('detects a duplicate if one is introduced', () => {
    // Proof the scan is live rather than passing because its pattern matches nothing.
    // This is the exact shape the news aggregate had before it was corrected.
    const duplicate = 'const TIER_WEIGHT: Readonly<Record<SourceTier, number>> = { 1: 1.0 };';
    expect(new RegExp(String.raw`\bconst\s+TIER_WEIGHT\b[^=\n]*=\s*[{[]`).test(duplicate)).toBe(
      true,
    );
  });

  it('does not count a re-export as a definition', () => {
    // `factor.ts` re-exports TIER_WEIGHT so its callers keep their import path. That is
    // one definition with two names, not two definitions.
    const reExport = "export { TIER_WEIGHT } from '@forex-agent/core';";
    expect(/export\s*\{[^}]*\bTIER_WEIGHT\b[^}]*\}\s*from/.test(reExport)).toBe(true);
  });
});

describe('the values themselves', () => {
  it('keeps tier weights ordered by credibility', () => {
    // A property rather than a restatement: asserting the literal numbers here would
    // create the fourth copy this file exists to prevent.
    expect(TIER_WEIGHT[1]).toBeGreaterThan(TIER_WEIGHT[2]);
    expect(TIER_WEIGHT[2]).toBeGreaterThan(TIER_WEIGHT[3]);
    expect(TIER_WEIGHT[3]).toBeGreaterThan(TIER_WEIGHT[4]);
    expect(TIER_WEIGHT[1]).toBe(1);
  });

  it('keeps freshness weights ordered, with UNAVAILABLE at zero', () => {
    // Zero is what makes an unavailable input abstain rather than vote.
    expect(FRESHNESS_WEIGHT.LIVE).toBeGreaterThan(FRESHNESS_WEIGHT.RECENT);
    expect(FRESHNESS_WEIGHT.RECENT).toBeGreaterThan(FRESHNESS_WEIGHT.STALE);
    expect(FRESHNESS_WEIGHT.STALE).toBeGreaterThan(FRESHNESS_WEIGHT.UNAVAILABLE);
    expect(FRESHNESS_WEIGHT.UNAVAILABLE).toBe(0);
  });
});
