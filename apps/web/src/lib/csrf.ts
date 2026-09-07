/**
 * CSRF enforcement for mutating routes.
 *
 * The cookie half of double-submit was set at login from the first commit; the check
 * that reads it was not. **"Set up in the cookie layer but not enforced" is the shape
 * of a security control everyone assumes is working** — the token is visible in
 * devtools, the code that issues it is right there, and nothing announces that no route
 * ever compares it.
 *
 * Double-submit works because of the same-origin policy, not because the token is
 * secret. A cross-site page can cause a request that carries our cookies, but it cannot
 * *read* our cookie to set the matching header. So the CSRF cookie is deliberately not
 * `httpOnly` — a value the client cannot read cannot be echoed.
 *
 * Three checks, all of which must pass:
 *
 * 1. **Token match**, compared in constant time. A length-leaking or short-circuiting
 *    comparison on a value an attacker can probe is worth avoiding even where the
 *    practical attack is remote.
 * 2. **Origin / Referer**, where the browser sends one. This is the layer that survives
 *    a token leak, and the layer the token survives when a proxy strips headers.
 * 3. **`Sec-Fetch-Site`**, where the browser sends it. Modern browsers state the
 *    request's provenance directly, and `cross-site` is refused outright.
 *
 * Any one of these alone has a failure mode the others cover. All three are cheap.
 */

import { timingSafeEqual } from 'node:crypto';
import { cookies, headers } from 'next/headers';
import { CSRF_COOKIE, CSRF_HEADER } from './session';

export const CSRF_FAILURE_REASONS = [
  'MISSING_COOKIE',
  'MISSING_HEADER',
  'TOKEN_MISMATCH',
  'CROSS_SITE',
  'BAD_ORIGIN',
] as const;
export type CsrfFailureReason = (typeof CSRF_FAILURE_REASONS)[number];

export type CsrfResult = { ok: true } | { ok: false; reason: CsrfFailureReason };

/**
 * Constant-time string comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak length, so the
 * lengths are compared first and unequal lengths short-circuit to a failure that does
 * no further work — the same information either way, without the exception.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export async function verifyCsrf(request: Request): Promise<CsrfResult> {
  const store = await cookies();
  const headerStore = await headers();

  /*
   * `Sec-Fetch-Site` first: it is the browser's own statement about where the request
   * came from and cannot be set by page script. Absent on older browsers and on
   * non-browser clients, so its absence is not a failure — only `cross-site` is.
   */
  const fetchSite = headerStore.get('sec-fetch-site');
  if (fetchSite === 'cross-site') return { ok: false, reason: 'CROSS_SITE' };

  const origin = headerStore.get('origin') ?? headerStore.get('referer');
  if (origin !== null && origin !== '') {
    const host = headerStore.get('host');
    if (host !== null) {
      try {
        const originHost = new URL(origin).host;
        if (originHost !== host) return { ok: false, reason: 'BAD_ORIGIN' };
      } catch {
        return { ok: false, reason: 'BAD_ORIGIN' };
      }
    }
  }

  const cookieToken = store.get(CSRF_COOKIE)?.value;
  if (cookieToken === undefined || cookieToken === '') {
    return { ok: false, reason: 'MISSING_COOKIE' };
  }

  const headerToken = request.headers.get(CSRF_HEADER);
  if (headerToken === null || headerToken === '') {
    return { ok: false, reason: 'MISSING_HEADER' };
  }

  if (!constantTimeEquals(cookieToken, headerToken)) {
    return { ok: false, reason: 'TOKEN_MISMATCH' };
  }

  return { ok: true };
}

/**
 * The user-facing message.
 *
 * One message for every reason. The distinctions above are useful in a log and useless
 * to a caller — telling an attacker *which* check failed is free help, and telling a
 * legitimate user is noise, since the remedy is the same in every case.
 */
export const CSRF_REJECTION_MESSAGE =
  'This request could not be verified. Reload the page and try again.';
