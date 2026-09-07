/**
 * Opaque tokens and CSRF (master PRD §3, §53).
 *
 * Session tokens are random, not signed or self-describing. A JWT would let a
 * request be validated without touching the database, but it would also make
 * revocation impossible before expiry — and being able to kill a session
 * immediately matters more here than saving one query.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256 bits. Guessing one is not a threat model we need to reason further about. */
const TOKEN_BYTES = 32;

/** base64url: safe in a cookie and a header without escaping. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * Only the hash is stored. A database leak then yields no usable session, the same
 * reason passwords are not stored in the clear.
 *
 * SHA-256 rather than Argon2: the input is already 256 bits of entropy, so there is
 * nothing to brute-force and no reason to pay a KDF's cost on every request.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ── CSRF (double-submit, signed) ────────────────────────────────────────────

/**
 * Double-submit CSRF: the token is sent both in a readable cookie and in a header,
 * and the two must match. An attacker's site can force a request to our origin but
 * cannot read our cookie, so it cannot populate the header.
 *
 * The token is HMAC-signed rather than raw random so a forged cookie cannot simply
 * be paired with a matching header — without the server secret an attacker who can
 * set cookies (via a subdomain, say) still cannot mint a token we will accept.
 */
export interface CsrfToken {
  /** Goes in a non-HttpOnly cookie so the frontend can echo it back. */
  readonly value: string;
}

const CSRF_NONCE_BYTES = 16;

export function issueCsrfToken(secret: string): CsrfToken {
  const nonce = randomBytes(CSRF_NONCE_BYTES).toString('base64url');
  const signature = signCsrf(nonce, secret);
  return { value: `${nonce}.${signature}` };
}

function signCsrf(nonce: string, secret: string): string {
  return createHmac('sha256', secret).update(nonce, 'utf8').digest('base64url');
}

/** Verify a token is well-formed, correctly signed, and matches its counterpart. */
export function verifyCsrfToken(
  cookieValue: string | undefined,
  headerValue: string | undefined,
  secret: string,
): boolean {
  if (
    cookieValue === undefined ||
    headerValue === undefined ||
    cookieValue === '' ||
    headerValue === ''
  ) {
    return false;
  }
  // Both halves must be present and identical before the signature is even checked.
  if (!timingSafeCompare(cookieValue, headerValue)) return false;

  const separator = cookieValue.lastIndexOf('.');
  if (separator <= 0) return false;
  const nonce = cookieValue.slice(0, separator);
  const signature = cookieValue.slice(separator + 1);
  if (nonce === '' || signature === '') return false;

  return timingSafeCompare(signature, signCsrf(nonce, secret));
}

// ── Cookie serialisation (framework-agnostic) ───────────────────────────────

export interface CookieOptions {
  readonly name: string;
  readonly value: string;
  readonly maxAgeSeconds: number;
  readonly httpOnly: boolean;
  readonly secure: boolean;
  readonly sameSite: 'Lax' | 'Strict' | 'None';
  readonly path?: string;
}

/**
 * Build a `Set-Cookie` value.
 *
 * Kept here rather than in the web app so the security attributes are decided once,
 * next to the tokens they protect, and are unit-testable without a server.
 */
export function serialiseCookie(options: CookieOptions): string {
  const parts = [
    `${options.name}=${options.value}`,
    `Path=${options.path ?? '/'}`,
    `Max-Age=${String(Math.floor(options.maxAgeSeconds))}`,
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly) parts.push('HttpOnly');
  // Secure is omitted only in local development over plain HTTP; production config
  // forces HTTPS, so the cookie is always Secure there.
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

/** An expired cookie of the same name and attributes, to clear it on logout. */
export function clearCookie(name: string, secure: boolean, path = '/'): string {
  return serialiseCookie({
    name,
    value: '',
    maxAgeSeconds: 0,
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path,
  });
}

export const SESSION_COOKIE_NAME = 'fa_session';
export const CSRF_COOKIE_NAME = 'fa_csrf';
export const CSRF_HEADER_NAME = 'x-csrf-token';
