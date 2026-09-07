/**
 * CSRF enforcement on mutating routes.
 *
 * The cookie half of double-submit existed from the first commit; the check that reads
 * it did not. **"Set up in the cookie layer but not enforced" is the shape of a
 * security control everyone assumes is working** — the token is visible in devtools,
 * the code issuing it is right there, and nothing announces that no route ever compares
 * it.
 *
 * These tests forge requests the way a cross-site page would: with the session cookie
 * attached (the browser sends it automatically) and without the header (a cross-origin
 * page cannot read our cookie to set it). If any of them passes, the control is not
 * doing anything.
 */

import { expect, test, type Page } from '@playwright/test';

interface FetchResult {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Issue the request from inside the page.
 *
 * `page.request` runs in Playwright's own context and does not carry the browser's
 * cookie jar here — every call arrived unauthenticated, which made a CSRF rejection
 * indistinguishable from a missing session. Running `fetch` in the page is both the fix
 * and the more faithful test: it is exactly what the real client does, with the same
 * cookies, the same origin and the same `Sec-Fetch-*` headers the browser sets.
 */
async function pageFetch(
  page: Page,
  url: string,
  init: { method?: string; headers?: Record<string, string> } = {},
): Promise<FetchResult> {
  return page.evaluate(
    async ({ url: u, init: i }) => {
      const response = await fetch(u, { method: i.method ?? 'GET', headers: i.headers ?? {} });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Non-JSON is fine; the status is what most assertions here care about.
      }
      return { status: response.status, body };
    },
    { url, init },
  );
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set. See .env.example.`);
  return value;
}

const EMAIL = required('E2E_EMAIL');
const PASSWORD = required('E2E_PASSWORD');

async function signIn(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL('/');
}

/** The CSRF token this browser context holds, read the way the client reads it. */
async function csrfToken(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const token = cookies.find((c) => c.name === 'fa_csrf')?.value;
  expect(token, 'a CSRF cookie should be issued at login').toBeDefined();
  return token ?? '';
}

test.describe('mutating routes reject requests without a valid token', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('a login issues a CSRF cookie the client can read', async ({ page }) => {
    // Not httpOnly, deliberately: double-submit requires the client to echo it, and a
    // value the client cannot read cannot be echoed.
    const cookies = await page.context().cookies();
    const csrf = cookies.find((c) => c.name === 'fa_csrf');
    expect(csrf?.httpOnly).toBe(false);

    // The session cookie is the opposite: never readable from script.
    const session = cookies.find((c) => c.name === 'fa_session');
    expect(session?.httpOnly).toBe(true);
  });

  test('refresh is rejected with no CSRF header', async ({ page }) => {
    // Exactly what a forged cross-site POST looks like: session cookie present
    // (the browser attaches it), header absent (the attacker cannot read the cookie).
    const response = await pageFetch(page, '/api/analysis/XAUUSD', { method: 'POST' });
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ error: expect.stringContaining('could not be verified') });
  });

  test('refresh is rejected with a wrong CSRF header', async ({ page }) => {
    const response = await pageFetch(page, '/api/analysis/XAUUSD', {
      method: 'POST',
      headers: { 'x-csrf-token': 'not-the-token' },
    });
    expect(response.status).toBe(403);
  });

  test('logout is rejected with no CSRF header', async ({ page }) => {
    // A forged logout is a denial of service — small, but a state change all the same.
    const response = await pageFetch(page, '/api/auth/logout', { method: 'POST' });
    expect(response.status).toBe(403);
  });

  test('a rejected logout leaves the session intact', async ({ page }) => {
    // The proof that the rejection happened *before* the effect, not after it.
    await pageFetch(page, '/api/auth/logout', { method: 'POST' });
    await page.goto('/');
    await expect(page).toHaveURL('/');
    await expect(page.getByText(`Signed in as ${EMAIL}`)).toBeVisible();
  });

  /*
   * These two use Playwright's request context rather than in-page `fetch`, and the
   * reason is the point of the tests.
   *
   * `Origin` and `Sec-Fetch-*` are **forbidden header names**: a browser will not let
   * page script set them, which is exactly why the server can trust them. In-page
   * `fetch` therefore cannot forge the condition being tested — the browser silently
   * replaces the values with the truth.
   *
   * Cookies are not needed here: `verifyCsrf` checks provenance before it looks at the
   * token, so a forged-origin request is refused whether or not a session exists.
   */
  test('a cross-site request is rejected even with a correct token', async ({ page }) => {
    // Belt and braces: if the token ever leaks, `Sec-Fetch-Site` still refuses.
    const token = await csrfToken(page);
    const response = await page.request.post('/api/analysis/XAUUSD', {
      headers: { 'x-csrf-token': token, 'sec-fetch-site': 'cross-site' },
    });
    expect(response.status()).toBe(403);
  });

  test('a request from a foreign origin is rejected', async ({ page }) => {
    const token = await csrfToken(page);
    const response = await page.request.post('/api/analysis/XAUUSD', {
      headers: { 'x-csrf-token': token, origin: 'https://attacker.example' },
    });
    expect(response.status()).toBe(403);
  });

  test('the rejection says nothing about which check failed', async ({ page }) => {
    // Telling an attacker which of the three checks stopped them is free help, and a
    // legitimate user has the same remedy in every case.
    const noHeader = await pageFetch(page, '/api/analysis/XAUUSD', { method: 'POST' });
    const badToken = await pageFetch(page, '/api/analysis/XAUUSD', {
      method: 'POST',
      headers: { 'x-csrf-token': 'wrong' },
    });
    expect(noHeader.body).toEqual(badToken.body);
  });
});

test.describe('a valid token is accepted', () => {
  test('refresh succeeds with the token the client would send', async ({ page }) => {
    // The other half. A CSRF check that rejects everything is not a working control,
    // it is an outage — and one that would look like a security success.
    await signIn(page);
    const token = await csrfToken(page);

    const response = await pageFetch(page, '/api/analysis/XAUUSD', {
      method: 'POST',
      headers: { 'x-csrf-token': token },
    });
    // 202 (queued) or 429 (budget spent) — both mean the request got past CSRF.
    expect([202, 429]).toContain(response.status);
  });

  test('the refresh button in the page works end to end', async ({ page }) => {
    await signIn(page);
    const button = page.locator('.refresh-button');
    if (await button.isDisabled()) test.skip();

    await button.click();
    // Whatever the outcome, it must not be a CSRF rejection: the client sends the
    // header through `postWithCsrf`.
    /*
     * Asserted as a count, not with `not.toContainText`: when the refresh succeeds the
     * refusal element does not exist, and `not.toContainText` fails on a missing
     * element rather than passing. The absence *is* the success here.
     */
    await expect(
      page.locator('.refresh-refusal', { hasText: 'could not be verified' }),
    ).toHaveCount(0);
  });

  test('logout succeeds with a valid token', async ({ page }) => {
    await signIn(page);
    const token = await csrfToken(page);

    const response = await pageFetch(page, '/api/auth/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': token },
    });
    expect(response.status).toBe(200);

    // And the session is genuinely gone, not merely reported gone.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });
});

test.describe('read-only routes are unaffected', () => {
  test('GET does not require a token', async ({ page }) => {
    // CSRF protects state changes. Requiring a token on a GET would break every link
    // and teach nothing.
    await signIn(page);
    const response = await pageFetch(page, '/api/system/status');
    expect(response.status).toBe(200);
  });
});
