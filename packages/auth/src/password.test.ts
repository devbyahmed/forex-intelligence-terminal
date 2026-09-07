import { describe, expect, it } from 'vitest';
import {
  ARGON2_PARAMS,
  MIN_PASSWORD_LENGTH,
  PasswordPolicyError,
  assertPasswordAcceptable,
  hashPassword,
  needsRehash,
  parseArgon2Hash,
  timingSafeStringEqual,
  verifyAgainstDummy,
  verifyPassword,
} from './password.js';

const GOOD_PASSWORD = 'correct horse battery staple';

describe('argon2 parameters', () => {
  it('matches an OWASP-recommended configuration', () => {
    // OWASP lists five equivalent configurations; we use the high-memory,
    // single-pass one. Drifting off that list silently is the failure to catch.
    const owaspEquivalents = [
      { memoryCost: 47_104, timeCost: 1 },
      { memoryCost: 19_456, timeCost: 2 },
      { memoryCost: 12_288, timeCost: 3 },
      { memoryCost: 9_216, timeCost: 4 },
      { memoryCost: 7_168, timeCost: 5 },
    ];
    expect(owaspEquivalents).toContainEqual({
      memoryCost: ARGON2_PARAMS.memoryCost,
      timeCost: ARGON2_PARAMS.timeCost,
    });
    expect(ARGON2_PARAMS.parallelism).toBe(1);
  });
});

describe('hashPassword', () => {
  it('produces an argon2id PHC string carrying its parameters', async () => {
    const hash = await hashPassword(GOOD_PASSWORD);
    const parsed = parseArgon2Hash(hash);
    expect(parsed?.variant).toBe('argon2id');
    expect(parsed?.memoryCost).toBe(ARGON2_PARAMS.memoryCost);
    expect(parsed?.timeCost).toBe(ARGON2_PARAMS.timeCost);
    expect(parsed?.parallelism).toBe(ARGON2_PARAMS.parallelism);
  });

  it('salts automatically — the same password hashes differently each time', async () => {
    // Without per-hash salting, identical passwords would be visibly identical in
    // the database and precomputable in bulk.
    const a = await hashPassword(GOOD_PASSWORD);
    const b = await hashPassword(GOOD_PASSWORD);
    expect(a).not.toBe(b);
    expect(await verifyPassword(GOOD_PASSWORD, a)).toBe(true);
    expect(await verifyPassword(GOOD_PASSWORD, b)).toBe(true);
  });

  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword(GOOD_PASSWORD);
    expect(await verifyPassword(GOOD_PASSWORD, hash)).toBe(true);
    expect(await verifyPassword('wrong password entirely', hash)).toBe(false);
  });

  it('rejects a near-miss password', async () => {
    const hash = await hashPassword(GOOD_PASSWORD);
    expect(await verifyPassword(`${GOOD_PASSWORD} `, hash)).toBe(false);
    expect(await verifyPassword(GOOD_PASSWORD.toUpperCase(), hash)).toBe(false);
  });
});

describe('password policy', () => {
  it('rejects a password shorter than the minimum', () => {
    expect(() => assertPasswordAcceptable('a'.repeat(MIN_PASSWORD_LENGTH - 1))).toThrow(
      PasswordPolicyError,
    );
  });

  it('accepts one exactly at the minimum', () => {
    expect(() => assertPasswordAcceptable('a'.repeat(MIN_PASSWORD_LENGTH))).not.toThrow();
  });

  it('rejects an oversized password', () => {
    // An unbounded input is a cheap denial of service against a deliberately
    // expensive function.
    expect(() => assertPasswordAcceptable('a'.repeat(2000))).toThrow(PasswordPolicyError);
  });

  it('refuses to verify an oversized password rather than hashing it', async () => {
    const hash = await hashPassword(GOOD_PASSWORD);
    expect(await verifyPassword('a'.repeat(100_000), hash)).toBe(false);
  });
});

describe('verifyPassword robustness', () => {
  it('fails closed on a malformed hash instead of throwing', async () => {
    // A corrupt row must not surface a stack trace from the login endpoint.
    expect(await verifyPassword(GOOD_PASSWORD, 'not-a-hash')).toBe(false);
    expect(await verifyPassword(GOOD_PASSWORD, '')).toBe(false);
    expect(await verifyPassword(GOOD_PASSWORD, '$argon2id$garbage')).toBe(false);
  });
});

describe('verifyAgainstDummy', () => {
  it('always reports failure', async () => {
    expect(await verifyAgainstDummy('anything at all')).toBe(false);
  });

  it('costs roughly what a real verification costs', async () => {
    // The point of the dummy hash: the unknown-account branch must not be
    // detectably faster than the wrong-password branch. Compared as a ratio with a
    // wide tolerance, since CI timing is noisy.
    const hash = await hashPassword(GOOD_PASSWORD);
    await verifyAgainstDummy('warm up');

    const timeIt = async (fn: () => Promise<unknown>): Promise<number> => {
      const runs = 5;
      const start = process.hrtime.bigint();
      for (let i = 0; i < runs; i += 1) await fn();
      return Number(process.hrtime.bigint() - start) / runs / 1e6;
    };

    const realMs = await timeIt(() => verifyPassword('wrong password', hash));
    const dummyMs = await timeIt(() => verifyAgainstDummy('wrong password'));

    const ratio = dummyMs / realMs;
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(2.5);
  }, 30_000);
});

describe('needsRehash', () => {
  it('is false for a hash at current parameters', async () => {
    expect(needsRehash(await hashPassword(GOOD_PASSWORD))).toBe(false);
  });

  it('is true for a weaker hash', () => {
    // A legacy hash must be upgraded on next login rather than left in place.
    expect(needsRehash('$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2g')).toBe(true);
  });

  it('is true for a different argon2 variant', () => {
    expect(needsRehash('$argon2i$v=19$m=47104,t=1,p=1$c2FsdHNhbHQ$aGFzaGhhc2g')).toBe(true);
  });

  it('is true for an unparseable hash', () => {
    expect(needsRehash('nonsense')).toBe(true);
    expect(needsRehash('')).toBe(true);
  });
});

describe('parseArgon2Hash', () => {
  it('returns null on malformed input rather than guessing', () => {
    expect(parseArgon2Hash('')).toBeNull();
    expect(parseArgon2Hash('$argon2id$v=19')).toBeNull();
    expect(parseArgon2Hash('$argon2id$v=19$nothing$salt$hash')).toBeNull();
  });
});

describe('timingSafeStringEqual', () => {
  it('compares equal and unequal strings correctly', () => {
    expect(timingSafeStringEqual('abc', 'abc')).toBe(true);
    expect(timingSafeStringEqual('abc', 'abd')).toBe(false);
  });

  it('handles differing lengths without throwing', () => {
    // node's timingSafeEqual throws on length mismatch; length is not secret, so
    // it is compared first.
    expect(timingSafeStringEqual('short', 'much longer string')).toBe(false);
    expect(timingSafeStringEqual('', '')).toBe(true);
  });

  it('handles multi-byte characters', () => {
    expect(timingSafeStringEqual('café', 'café')).toBe(true);
    expect(timingSafeStringEqual('café', 'cafe')).toBe(false);
  });
});
