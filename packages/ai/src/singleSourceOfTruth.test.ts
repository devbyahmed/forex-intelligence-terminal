/**
 * One definition per rule.
 *
 * A prohibited-claim pattern set existed in two places: the canonical one in
 * `guards.ts`, and a re-typed copy in the daily-report test. They disagreed within
 * minutes — the copy flagged the disclaimer "they are not forecasts" on the noun form
 * of `forecast`, a false positive the canonical set had been specifically fixed to
 * avoid.
 *
 * **That was found by luck.** The duplicate happened to fire on our own text, loudly,
 * in a test run. A copy that merely *under*-matched would have failed silently: prose
 * checked against a weaker rule, passing, and nobody the wiser. The predictive guard is
 * the weakest enforcement in the system and the last thing between this product and an
 * implied forecast; a second, quieter copy of it is exactly the failure mode that
 * matters.
 *
 * So this scans the repository for pattern sets that look like the canonical one and
 * fails on any found outside it. Same principle as the raw-SQL audit and the
 * CHECK-constraint audit: having found one instance, establish whether there are
 * others, and make the answer a test rather than a memory.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findProhibitedClaims } from './guards.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** The one file allowed to define these patterns. */
const CANONICAL = 'packages/ai/src/guards.ts';

/**
 * Files that may legitimately *quote* a forbidden phrase without defining a rule.
 *
 * A corpus of adversarial sentences is not a second definition — it is input to the
 * canonical one, and it is the thing that keeps the canonical one honest.
 */
const ALLOWED_TO_QUOTE = new Set([
  'packages/ai/src/predictiveCorpus.test.ts',
  'packages/ai/src/guards.test.ts',
  'packages/ai/src/singleSourceOfTruth.test.ts',
]);

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.next', '.git', 'test-results']);

function sourceFiles(): readonly string[] {
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
      if (entry.endsWith('.ts') || entry.endsWith('.tsx')) out.push(full);
    }
  };
  walk(join(REPO_ROOT, 'packages'));
  walk(join(REPO_ROOT, 'apps'));
  return out;
}

/**
 * Words that only appear together in a prohibited-claim rule.
 *
 * Matching on *regex literals* containing forecast vocabulary, rather than on the words
 * themselves — prose mentioning "forecast" is fine and frequent; a regex alternation of
 * predictive verbs is a rule.
 */
const RULE_SHAPED = [
  /\/\\b\(\?:[^/]*\b(?:rally|rallies)\b[^/]*\)/,
  /\/\\b\(\?:[^/]*\bunlikely\b[^/]*\)/,
  /\/\\b\(\?:[^/]*\b(?:expects|anticipates|predicts)\b[^/]*\)/,
  /\/\\bprice\\s\+targets\?/,
  /\/\\bsets\?\\s\+up\\s\+for/,
];

describe('prohibited-claim patterns have exactly one definition', () => {
  it('scans a meaningful number of files', () => {
    // If the walk broke, the assertion below would pass by finding nothing.
    expect(sourceFiles().length).toBeGreaterThan(60);
  });

  it('finds no pattern set outside the canonical source', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles()) {
      const relativePath = relative(REPO_ROOT, file).replace(/\\/g, '/');
      if (relativePath === CANONICAL || ALLOWED_TO_QUOTE.has(relativePath)) continue;

      const source = readFileSync(file, 'utf8');
      for (const shape of RULE_SHAPED) {
        const match = shape.exec(source);
        if (match !== null) {
          offenders.push(`${relativePath} → ${match[0].slice(0, 70)}`);
          break;
        }
      }
    }

    /*
     * If this fails: import `findProhibitedClaims` from `@forex-agent/ai` instead of
     * re-typing the patterns. Any prose this project generates — report templates,
     * dashboard copy, email subjects — should be checked against the same definition
     * the model's output is, or the two definitions will disagree about what the rule
     * is and only one of them will be right.
     */
    expect(offenders).toEqual([]);
  });

  it('keeps the canonical set reachable to every package that needs it', () => {
    // The remedy has to be available, or the rule above just blocks people. The
    // worker imports this to check its own report templates.
    expect(typeof findProhibitedClaims).toBe('function');
    expect(findProhibitedClaims('Gold will likely rally.').length).toBeGreaterThan(0);
    expect(findProhibitedClaims('The reading is -14.6.')).toEqual([]);
  });

  it('detects a duplicate if one is introduced', () => {
    // Proof the scan is live rather than passing because its patterns match nothing.
    // This is the shape the report test had before it was corrected.
    const duplicate = String.raw`const FORBIDDEN = [/\b(?:expects|anticipates|predicts|forecasts)\b/i];`;
    expect(RULE_SHAPED.some((shape) => shape.test(duplicate))).toBe(true);
  });
});
