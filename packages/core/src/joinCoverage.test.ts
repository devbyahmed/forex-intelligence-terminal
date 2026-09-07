import { describe, expect, it } from 'vitest';
import {
  JoinCoverageError,
  assertCoverage,
  assertVocabularyOverlap,
  measureCoverage,
} from './joinCoverage.js';

/** The real failure, reproduced: rules keyed 'US' against rows keyed 'USD'. */
const CURATED_RULE_COUNTRIES = ['US', 'EU', 'GB', 'JP'];
const FEED_ROW_COUNTRIES = ['USD', 'EUR', 'GBP', 'JPY', 'AUD'];

describe('the importance-rules failure this exists to catch', () => {
  it('detects zero vocabulary overlap between the two sides', () => {
    // 143 releases were ingested with zero curated matches and nothing reported a
    // problem. This turns that into a loud failure before a row is processed.
    expect(() =>
      assertVocabularyOverlap({
        name: 'importance rules ↔ feed countries',
        left: CURATED_RULE_COUNTRIES,
        right: FEED_ROW_COUNTRIES,
      }),
    ).toThrow(JoinCoverageError);
  });

  it('passes once the vocabularies are reconciled', () => {
    const normalised = ['US', 'EU', 'GB', 'JP', 'AU'];
    expect(() =>
      assertVocabularyOverlap({
        name: 'importance rules ↔ normalised countries',
        left: CURATED_RULE_COUNTRIES,
        right: normalised,
      }),
    ).not.toThrow();
  });

  it('detects the second instance: substring rules against a different naming', () => {
    // 'cpi' is not a substring of 'Consumer Price Index', so the fix for the first
    // bug still matched nothing.
    const rules = ['cpi', 'nonfarm payrolls'];
    const fredNames = ['consumer price index', 'employment situation'];
    expect(() =>
      assertCoverage({
        name: 'importance patterns ↔ FRED release names',
        candidates: fredNames,
        matched: (name) => rules.some((r) => name.includes(r)),
        describe: (name) => name,
      }),
    ).toThrow(JoinCoverageError);
  });
});

describe('measureCoverage', () => {
  it('reports a healthy join', () => {
    const r = measureCoverage({
      name: 'test',
      candidates: ['a', 'b', 'c'],
      matched: (v) => v !== 'c',
      describe: (v) => v,
    });
    expect(r.healthy).toBe(true);
    expect(r.matched).toBe(2);
    expect(r.matchRate).toBeCloseTo(2 / 3);
  });

  it('reports unmatched examples so diagnosis is immediate', () => {
    const r = measureCoverage({
      name: 'test',
      candidates: ['consumer price index', 'employment situation'],
      matched: () => false,
      describe: (v) => v,
    });
    expect(r.sampleUnmatched).toContain('consumer price index');
  });

  it('caps the sample so a big failure does not flood a log', () => {
    const r = measureCoverage({
      name: 'test',
      candidates: Array.from({ length: 500 }, (_, i) => `item-${String(i)}`),
      matched: () => false,
      describe: (v) => v,
    });
    expect(r.sampleUnmatched).toHaveLength(5);
  });

  it('treats an empty input as suspicious by default', () => {
    // An empty candidate set usually means the upstream fetch failed, not that the
    // world was quiet.
    const r = measureCoverage({ name: 'test', candidates: [], matched: () => true, describe: String });
    expect(r.healthy).toBe(false);
    expect(r.reason).toContain('no candidates');
  });

  it('allows an empty input when that is genuinely expected', () => {
    const r = measureCoverage({
      name: 'test',
      candidates: [],
      matched: () => true,
      describe: String,
      expectation: { allowEmptyInput: true },
    });
    expect(r.healthy).toBe(true);
  });

  it('enforces a minimum match rate', () => {
    const r = measureCoverage({
      name: 'test',
      candidates: ['a', 'b', 'c', 'd'],
      matched: (v) => v === 'a',
      describe: (v) => v,
      expectation: { minMatchRate: 0.5 },
    });
    expect(r.healthy).toBe(false);
    expect(r.reason).toContain('50%');
  });

  it('enforces a minimum match count independently of rate', () => {
    const r = measureCoverage({
      name: 'test',
      candidates: Array.from({ length: 100 }, (_, i) => String(i)),
      matched: (v) => v === '1',
      describe: (v) => v,
      expectation: { minMatches: 5 },
    });
    expect(r.healthy).toBe(false);
    expect(r.reason).toContain('at least 5');
  });

  it('defaults to requiring at least one match', () => {
    const r = measureCoverage({ name: 'test', candidates: ['a'], matched: () => false, describe: (v) => v });
    expect(r.healthy).toBe(false);
  });
});

describe('JoinCoverageError', () => {
  it('names the join and shows the numbers', () => {
    try {
      assertCoverage({
        name: 'news asset tagging',
        candidates: ['article one', 'article two'],
        matched: () => false,
        describe: (v) => v,
      });
      expect.unreachable();
    } catch (e) {
      const message = (e as Error).message;
      expect(message).toContain('news asset tagging');
      expect(message).toContain('0 of 2');
      expect(message).toContain('article one');
    }
  });

  it('carries the structured report for programmatic handling', () => {
    try {
      assertCoverage({ name: 'x', candidates: ['a'], matched: () => false, describe: (v) => v });
      expect.unreachable();
    } catch (e) {
      expect((e as JoinCoverageError).report.matched).toBe(0);
    }
  });
});
