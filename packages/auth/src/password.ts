/**
 * Password hashing (master PRD §3, §53).
 *
 * Argon2id, using `@node-rs/argon2` — a Rust implementation shipping prebuilt
 * binaries. The pure-JS alternatives are far too slow to run at safe parameters, and
 * `node-argon2` needs a native toolchain, which fails on a stock Windows machine and
 * complicates serverless bundling.
 */

import { hash as argon2Hash, verify as argon2Verify, type Options } from '@node-rs/argon2';
import { timingSafeEqual } from 'node:crypto';

/**
 * OWASP Password Storage Cheat Sheet lists five configurations of equivalent
 * strength, trading memory against iterations:
 *
 *   m=47104 (46 MiB) t=1 p=1     ← chosen
 *   m=19456 (19 MiB) t=2 p=1
 *   m=12288 (12 MiB) t=3 p=1
 *   m=9216  (9 MiB)  t=4 p=1
 *   m=7168  (7 MiB)  t=5 p=1
 *
 * We take the high-memory, single-pass option rather than the more commonly quoted
 * 19 MiB / t=2 baseline, for two reasons specific to this deployment:
 *
 *  1. **Memory is the attacker's bottleneck.** Argon2's resistance to GPU and ASIC
 *     cracking comes from memory hardness, not from iteration count. At equivalent
 *     defender cost, 46 MiB is the harder target to parallelise.
 *  2. **The primary target bills CPU, not memory.** Vercel functions are provisioned
 *     at 2 GB regardless, and charge for active CPU time. Spending RAM we have
 *     already paid for to buy back CPU time is strictly better here, and it lowers
 *     login latency on a cold start.
 *
 * Parameters are stored inside the hash string, so raising them later is safe:
 * `needsRehash` detects an out-of-date hash and the login path upgrades it.
 */
export interface Argon2Params {
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

export const ARGON2_PARAMS: Argon2Params = {
  memoryCost: 47_104,
  timeCost: 1,
  parallelism: 1,
};

/**
 * `Algorithm` is exported as a `const enum`, which `verbatimModuleSyntax` cannot
 * import. The numeric value is stable and specified by the Argon2 RFC:
 * 0 = Argon2d, 1 = Argon2i, 2 = Argon2id.
 */
const ALGORITHM_ARGON2ID = 2;

const OPTIONS: Options = {
  algorithm: ALGORITHM_ARGON2ID,
  memoryCost: ARGON2_PARAMS.memoryCost,
  timeCost: ARGON2_PARAMS.timeCost,
  parallelism: ARGON2_PARAMS.parallelism,
};

/**
 * Argon2 has no practical input limit, but an unbounded password is a cheap denial
 * of service: hashing a 10 MB string is expensive and the user gains nothing past a
 * few dozen characters of entropy.
 */
export const MAX_PASSWORD_BYTES = 1024;
export const MIN_PASSWORD_LENGTH = 12;

export class PasswordPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PasswordPolicyError';
  }
}

export function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters.`,
    );
  }
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
    throw new PasswordPolicyError(
      `Password must be at most ${String(MAX_PASSWORD_BYTES)} bytes.`,
    );
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordAcceptable(password);
  return argon2Hash(password, OPTIONS);
}

/**
 * Verify a password. Returns false rather than throwing on a malformed hash: a
 * corrupt row must fail closed, not surface a stack trace to the login endpoint.
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) return false;
  try {
    return await argon2Verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * A precomputed hash of an unguessable value, verified against when the submitted
 * email matches no account.
 *
 * Without this, "no such user" returns in microseconds while a real account costs a
 * full Argon2 verification — a timing difference large enough to enumerate accounts
 * over the network. Doing the same work in both branches removes the signal.
 */
let dummyHashPromise: Promise<string> | undefined;

function dummyHash(): Promise<string> {
  const existing = dummyHashPromise;
  if (existing !== undefined) return existing;
  const created = argon2Hash(
    'no-account-with-this-email-exists-placeholder-value',
    OPTIONS,
  );
  dummyHashPromise = created;
  return created;
}

/** Burn the same CPU a real verification would, and always report failure. */
export async function verifyAgainstDummy(password: string): Promise<false> {
  await verifyPassword(password, await dummyHash());
  return false;
}

/** Warm the dummy hash so the first login does not pay to compute it. */
export async function warmPasswordHasher(): Promise<void> {
  await dummyHash();
}

/**
 * True when a stored hash was produced with weaker parameters than we now use.
 * The login path rehashes transparently, so raising cost never requires a reset.
 */
export function needsRehash(hash: string): boolean {
  const parsed = parseArgon2Hash(hash);
  if (parsed === null) return true;
  if (parsed.variant !== 'argon2id') return true;
  return (
    parsed.memoryCost < ARGON2_PARAMS.memoryCost ||
    parsed.timeCost < ARGON2_PARAMS.timeCost ||
    parsed.parallelism < ARGON2_PARAMS.parallelism
  );
}

export interface ParsedArgon2Hash {
  readonly variant: string;
  readonly memoryCost: number;
  readonly timeCost: number;
  readonly parallelism: number;
}

/** Parse the PHC string form: `$argon2id$v=19$m=47104,t=1,p=1$<salt>$<hash>`. */
export function parseArgon2Hash(hash: string): ParsedArgon2Hash | null {
  const parts = hash.split('$');
  // ['', 'argon2id', 'v=19', 'm=..,t=..,p=..', salt, digest]
  if (parts.length < 6) return null;
  const variant = parts[1];
  const params = parts[3];
  if (variant === undefined || params === undefined) return null;

  const read = (key: string): number | null => {
    const m = new RegExp(`(?:^|,)${key}=(\\d+)(?:,|$)`).exec(params);
    return m?.[1] === undefined ? null : Number.parseInt(m[1], 10);
  };

  const memoryCost = read('m');
  const timeCost = read('t');
  const parallelism = read('p');
  if (memoryCost === null || timeCost === null || parallelism === null) return null;

  return { variant, memoryCost, timeCost, parallelism };
}

/**
 * Constant-time string comparison.
 *
 * `===` on secrets leaks their contents through timing: it returns at the first
 * differing byte, so an attacker can recover a token one character at a time.
 * Lengths are compared first because that difference is not secret.
 */
export function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
