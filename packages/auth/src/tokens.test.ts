import { describe, expect, it } from 'vitest';
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  clearCookie,
  generateToken,
  hashToken,
  issueCsrfToken,
  serialiseCookie,
  timingSafeCompare,
  verifyCsrfToken,
} from './tokens.js';

const SECRET = 's'.repeat(48);

describe('generateToken', () => {
  it('produces unique high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 5000 }, () => generateToken()));
    expect(tokens.size).toBe(5000);
  });

  it('is URL-safe so it needs no escaping in a cookie', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it('carries at least 256 bits', () => {
    // base64url of 32 bytes is 43 characters.
    expect(generateToken().length).toBeGreaterThanOrEqual(43);
  });
});

describe('hashToken', () => {
  it('is deterministic', () => {
    const token = generateToken();
    expect(hashToken(token)).toBe(hashToken(token));
  });

  it('does not reveal the token', () => {
    // Only the hash is stored, so a database leak yields no usable session.
    const token = generateToken();
    const hash = hashToken(token);
    expect(hash).not.toContain(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different tokens', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});

describe('CSRF double-submit', () => {
  it('accepts a token echoed back correctly', () => {
    const { value } = issueCsrfToken(SECRET);
    expect(verifyCsrfToken(value, value, SECRET)).toBe(true);
  });

  it('rejects a mismatch between cookie and header', () => {
    // The core of double-submit: an attacker's page can force the request but
    // cannot read our cookie to populate the header.
    const a = issueCsrfToken(SECRET);
    const b = issueCsrfToken(SECRET);
    expect(verifyCsrfToken(a.value, b.value, SECRET)).toBe(false);
  });

  it('rejects a token forged without the secret', () => {
    // Signing is what stops someone who can set a cookie — via a subdomain, say —
    // from minting a matching pair.
    const forged = 'attacker-nonce.attacker-signature';
    expect(verifyCsrfToken(forged, forged, SECRET)).toBe(false);
  });

  it('rejects a token signed with a different secret', () => {
    const { value } = issueCsrfToken('a'.repeat(48));
    expect(verifyCsrfToken(value, value, SECRET)).toBe(false);
  });

  it('rejects a tampered nonce with a valid-looking signature', () => {
    const { value } = issueCsrfToken(SECRET);
    const [, signature] = value.split('.');
    const tampered = `tampered.${signature ?? ''}`;
    expect(verifyCsrfToken(tampered, tampered, SECRET)).toBe(false);
  });

  it('rejects missing or empty values', () => {
    const { value } = issueCsrfToken(SECRET);
    expect(verifyCsrfToken(undefined, value, SECRET)).toBe(false);
    expect(verifyCsrfToken(value, undefined, SECRET)).toBe(false);
    expect(verifyCsrfToken('', '', SECRET)).toBe(false);
  });

  it('rejects a malformed token with no separator', () => {
    expect(verifyCsrfToken('nodot', 'nodot', SECRET)).toBe(false);
    expect(verifyCsrfToken('.onlysig', '.onlysig', SECRET)).toBe(false);
    expect(verifyCsrfToken('onlynonce.', 'onlynonce.', SECRET)).toBe(false);
  });

  it('issues a different token each time', () => {
    expect(issueCsrfToken(SECRET).value).not.toBe(issueCsrfToken(SECRET).value);
  });
});

describe('timingSafeCompare', () => {
  it('compares correctly regardless of length', () => {
    expect(timingSafeCompare('abc', 'abc')).toBe(true);
    expect(timingSafeCompare('abc', 'abd')).toBe(false);
    expect(timingSafeCompare('a', 'abcdef')).toBe(false);
  });
});

describe('cookie serialisation', () => {
  it('sets the security attributes a session cookie needs', () => {
    const cookie = serialiseCookie({
      name: SESSION_COOKIE_NAME,
      value: 'token-value',
      maxAgeSeconds: 604_800,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
    // HttpOnly keeps it away from XSS; SameSite blunts CSRF; Secure keeps it off
    // plaintext HTTP. All three are required, so all three are asserted.
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=604800');
  });

  it('omits HttpOnly for the CSRF cookie, which the frontend must read', () => {
    const cookie = serialiseCookie({
      name: CSRF_COOKIE_NAME,
      value: 'csrf-value',
      maxAgeSeconds: 3600,
      httpOnly: false,
      secure: true,
      sameSite: 'Lax',
    });
    expect(cookie).not.toContain('HttpOnly');
    expect(cookie).toContain('Secure');
  });

  it('omits Secure only when explicitly told to, for local HTTP development', () => {
    const cookie = serialiseCookie({
      name: SESSION_COOKIE_NAME,
      value: 'v',
      maxAgeSeconds: 60,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    });
    expect(cookie).not.toContain('Secure');
  });

  it('floors a fractional max age', () => {
    const cookie = serialiseCookie({
      name: 'x',
      value: 'v',
      maxAgeSeconds: 60.9,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
    expect(cookie).toContain('Max-Age=60');
  });

  it('clears a cookie with a zero max age', () => {
    const cookie = clearCookie(SESSION_COOKIE_NAME, true);
    expect(cookie).toContain('Max-Age=0');
    expect(cookie).toContain('HttpOnly');
  });
});
