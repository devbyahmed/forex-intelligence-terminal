/**
 * UUIDv7 — time-ordered identifiers (RFC 9562).
 *
 * Random v4 keys scatter inserts across the whole index, which on append-heavy
 * tables (news articles, candles, job runs) turns every write into a random page
 * touch. v7 puts a millisecond timestamp in the high bits, so new rows land together
 * at the right edge of the index and stay cheap to insert and to range-scan by time.
 *
 * Generated in the application rather than by the database so that ids exist before
 * the insert — needed for the lineage writes in `analysis_statements`, where a
 * statement must reference its parents' ids within the same transaction.
 *
 * Layout:
 *   48 bits  unix timestamp in milliseconds
 *    4 bits  version (7)
 *   12 bits  sub-millisecond counter, for monotonicity within a millisecond
 *    2 bits  variant (0b10)
 *   62 bits  random
 */

import { randomFillSync } from 'node:crypto';

const HEX: readonly string[] = Array.from({ length: 256 }, (_, i) =>
  i.toString(16).padStart(2, '0'),
);

/** 12 bits: the number of ids we can order within a single millisecond. */
const COUNTER_MAX = 0xfff;

/**
 * A generator with its own monotonic state.
 *
 * The state matters — `lastMs` is what stops a backwards clock from minting ids that
 * sort before rows already written — but process-global mutable state is not
 * testable. Once anything in a process has generated an id at the real current time,
 * every later call with an earlier timestamp is clamped forward, so an assertion
 * about the encoded time depends on what ran before it and on what time of day it is.
 * That is exactly how the round-trip test below came to pass in the morning and fail
 * in the afternoon.
 *
 * Application code uses the shared `uuidv7` below and should keep doing so: one
 * monotonic sequence per process is the property that makes the ordering guarantee
 * hold. Tests that assert on the encoding create their own.
 */
export function createUuidv7Generator(): (now?: number) => string {
  let lastMs = -1;
  let counter = 0;
  const scratch = new Uint8Array(16);

  const generate = (now: number = Date.now()): string => {
    // Never let a backwards clock produce ids that sort before existing rows.
    const ms = now > lastMs ? now : lastMs;

    if (ms === lastMs) {
      counter += 1;
      if (counter > COUNTER_MAX) {
        // More than 4096 ids in one millisecond: spill into the next millisecond
        // rather than emit a duplicate counter.
        lastMs = ms + 1;
        counter = 0;
        return generate(lastMs);
      }
    } else {
      lastMs = ms;
      counter = 0;
    }

    randomFillSync(scratch);

    // 48-bit timestamp, big-endian.
    scratch[0] = (ms / 2 ** 40) & 0xff;
    scratch[1] = (ms / 2 ** 32) & 0xff;
    scratch[2] = (ms / 2 ** 24) & 0xff;
    scratch[3] = (ms / 2 ** 16) & 0xff;
    scratch[4] = (ms / 2 ** 8) & 0xff;
    scratch[5] = ms & 0xff;

    // Version 7 in the high nibble of byte 6, counter in the remaining 12 bits.
    scratch[6] = 0x70 | ((counter >>> 8) & 0x0f);
    scratch[7] = counter & 0xff;

    // Variant 0b10 in the top two bits of byte 8.
    scratch[8] = 0x80 | ((scratch[8] ?? 0) & 0x3f);

    let out = '';
    for (let i = 0; i < 16; i += 1) {
      if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
      out += HEX[scratch[i] ?? 0] ?? '00';
    }
    return out;
  };

  return generate;
}

/**
 * The process-wide generator.
 *
 * One sequence per process is what makes the monotonicity guarantee mean anything:
 * two generators in the same process could mint ids that interleave out of order.
 */
export const uuidv7 = createUuidv7Generator();

/** Recover the generation time. Useful for retention sweeps and for debugging. */
export function uuidv7Timestamp(id: string): Date {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return new Date(Number.parseInt(hex, 16));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (v: string): boolean => UUID_RE.test(v);

export function isUuidv7(v: string): boolean {
  return isUuid(v) && v[14] === '7' && ['8', '9', 'a', 'b'].includes((v[19] ?? '').toLowerCase());
}
