/**
 * Server-side session handling for the app.
 *
 * The cookie carries an opaque token; only its SHA-256 is stored (SECURITY.md), so a
 * database read cannot recover a usable credential. Every attribute here is a
 * requirement rather than a default:
 *
 * - `httpOnly` — the token is never readable from JavaScript, so an XSS bug cannot
 *   exfiltrate a session.
 * - `sameSite: 'lax'` — blocks cross-site POSTs while leaving ordinary navigation
 *   working. CSRF is defended separately by the double-submit token; this is the
 *   second layer.
 * - `secure` in production only — a `Secure` cookie over plain HTTP is simply dropped,
 *   which would make local development fail in a way that looks like a login bug.
 * - `path: '/'` — one session for the app and its API, so a route cannot be reached
 *   with a cookie the rest of the app would reject.
 */

import { cookies } from 'next/headers';
import { getEnv } from '@forex-agent/config';
import { createDb, type Database } from '@forex-agent/db';
import { validateSession, type AuthenticatedSession } from '@forex-agent/auth';

export const SESSION_COOKIE = 'fa_session';
export const CSRF_COOKIE = 'fa_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface DbHandle {
  readonly db: Database;
  close(): Promise<void>;
}

export function openDb(): DbHandle {
  // Validated once by the schema, so a malformed connection string fails at startup
  // rather than on the first request that happens to need the database.
  return createDb({ connectionString: getEnv().DATABASE_URL });
}

/**
 * The current session, or null.
 *
 * Returns null for every invalid case — expired, revoked, unknown token, epoch bumped
 * — rather than distinguishing them. A page has nothing useful to do with the
 * difference, and surfacing it would tell an attacker whether a token was ever valid.
 */
export async function currentSession(): Promise<AuthenticatedSession | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token === undefined || token === '') return null;

  const handle = openDb();
  try {
    const result = await validateSession(handle.db, token, new Date());
    return result.valid ? result.session : null;
  } finally {
    await handle.close();
  }
}

export function sessionCookieOptions(expiresAt: Date): {
  httpOnly: true;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  expires: Date;
} {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: getEnv().NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  };
}

/**
 * The CSRF cookie is deliberately **not** `httpOnly`.
 *
 * Double-submit requires the client to read it and echo it in a header; a value the
 * client cannot read cannot be echoed. Its secrecy is not what makes the scheme work —
 * the same-origin policy is, since a cross-site attacker can cause a request but
 * cannot read the cookie to set the matching header.
 */
export function csrfCookieOptions(expiresAt: Date): {
  httpOnly: false;
  sameSite: 'lax';
  secure: boolean;
  path: '/';
  expires: Date;
} {
  return {
    httpOnly: false,
    sameSite: 'lax',
    secure: getEnv().NODE_ENV === 'production',
    path: '/',
    expires: expiresAt,
  };
}
