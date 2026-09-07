import { describe, expect, it } from 'vitest';
import { createUuidv7Generator, isUuid, isUuidv7, uuidv7, uuidv7Timestamp } from './ids.js';

describe('uuidv7', () => {
  it('produces a well-formed v7 uuid', () => {
    const id = uuidv7();
    expect(isUuid(id)).toBe(true);
    expect(isUuidv7(id)).toBe(true);
  });

  // These use a private generator. The shared `uuidv7` carries process-wide
  // monotonic state, so once anything has minted an id at the real current time,
  // every later call with an earlier timestamp is clamped forward — correct
  // behaviour, but it makes an assertion about the encoded time depend on what ran
  // before it and on the time of day. This test previously passed before noon UTC
  // and failed after it.
  it('encodes the generation time recoverably', () => {
    const gen = createUuidv7Generator();
    const now = Date.UTC(2026, 7, 30, 12, 0, 0);
    expect(uuidv7Timestamp(gen(now)).getTime()).toBe(now);
  });

  it('sorts lexicographically in time order', () => {
    // This is the entire reason for using v7 over v4: string ordering must match
    // insertion order, so index writes stay at the right edge.
    const gen = createUuidv7Generator();
    const early = gen(Date.UTC(2026, 0, 1));
    const mid = gen(Date.UTC(2026, 5, 1));
    const late = gen(Date.UTC(2026, 11, 1));
    expect([late, early, mid].sort()).toEqual([early, mid, late]);
    // Ordering must come from the encoded timestamps, not from the counter — with
    // one shared generator these three would all clamp to the same millisecond and
    // the test would pass for the wrong reason.
    expect(uuidv7Timestamp(early).getTime()).toBe(Date.UTC(2026, 0, 1));
    expect(uuidv7Timestamp(late).getTime()).toBe(Date.UTC(2026, 11, 1));
  });

  it('clamps a backwards clock rather than minting an id that sorts too early', () => {
    // The property the shared generator exists to guarantee.
    const gen = createUuidv7Generator();
    const forward = gen(Date.UTC(2026, 5, 1));
    const backwards = gen(Date.UTC(2026, 0, 1));
    expect(backwards > forward).toBe(true);
    expect(uuidv7Timestamp(backwards).getTime()).toBe(Date.UTC(2026, 5, 1));
  });

  it('stays ordered within a single millisecond', () => {
    const now = Date.now();
    const ids = Array.from({ length: 500 }, () => uuidv7(now));
    expect([...ids].sort()).toEqual(ids);
  });

  it('never repeats across a large burst', () => {
    const ids = new Set(Array.from({ length: 20_000 }, () => uuidv7()));
    expect(ids.size).toBe(20_000);
  });

  it('does not emit ids that sort backwards when the clock goes backwards', () => {
    // NTP correction or a VM snapshot can move the clock back. Ids must not then
    // sort before rows already written.
    const first = uuidv7(Date.UTC(2026, 7, 30, 12, 0, 0));
    const afterRewind = uuidv7(Date.UTC(2026, 7, 30, 11, 0, 0));
    expect(afterRewind > first).toBe(true);
  });

  it('spills into the next millisecond rather than exhausting the counter', () => {
    // 12 counter bits allow 4096 ids per ms; asking for more must stay unique
    // and ordered rather than wrapping.
    const now = Date.now() + 100_000;
    const ids = Array.from({ length: 5000 }, () => uuidv7(now));
    expect(new Set(ids).size).toBe(5000);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('isUuidv7', () => {
  it('rejects a v4 uuid', () => {
    expect(isUuidv7('f47ac10b-58cc-4372-a567-0e02b2c3d479')).toBe(false);
  });

  it('rejects malformed input', () => {
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuidv7('')).toBe(false);
  });
});
