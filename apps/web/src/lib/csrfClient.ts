'use client';

/**
 * The client half of double-submit.
 *
 * Reads the CSRF cookie and echoes it in a header. This is why that cookie is not
 * `httpOnly`: a value the client cannot read cannot be echoed, and the scheme's
 * security comes from the same-origin policy — a cross-site page can cause a request
 * but cannot read our cookie to set the matching header.
 *
 * Every mutating fetch goes through `postWithCsrf` rather than each call site
 * remembering the header. A call site that can forget is a call site that will, and the
 * failure looks like a 403 nobody can explain.
 */

export const CSRF_COOKIE = 'fa_csrf';
export const CSRF_HEADER = 'x-csrf-token';

function readCsrfToken(): string | null {
  /*
   * `String.raw` is load-bearing here, not decoration.
   *
   * In an ordinary template literal `\\s` is not an escape sequence, so it collapses
   * to the letter `s` and the pattern becomes `(?:^|;s*)` — which matches only when
   * this cookie happens to be the first one in the header. Any other position, and
   * the token silently reads as null and the request goes out without its header.
   */
  const pattern = String.raw`(?:^|;\s*)` + `${CSRF_COOKIE}=([^;]*)`;
  const match = new RegExp(pattern).exec(document.cookie);
  return match?.[1] === undefined ? null : decodeURIComponent(match[1]);
}

export async function postWithCsrf(url: string, body?: unknown): Promise<Response> {
  const token = readCsrfToken();
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Sent even when absent, as an empty string: the server rejects it either way,
      // and omitting the header entirely would make a missing cookie and a missing
      // header indistinguishable in the logs.
      [CSRF_HEADER]: token ?? '',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
