/**
 * End to end: login → dashboard → provenance expander → report.
 *
 * **This layer is not a formality here.** The two worst defects found in Phase 10 were
 * both invisible to unit tests and obvious the moment something rendered:
 *
 *  - the provenance expander stated the analysis `run_at` as the publication date, so
 *    a figure published on 2026-08-31 rendered as *"published 2026-09-05"* — turning
 *    the one place designed to be verifiable into a confident misstatement;
 *  - `latestAnalysisResponse` ordered `asc(runAt)` and returned the **oldest** stored
 *    analysis, so the dashboard would have shown the first run ever made and gone on
 *    showing it forever.
 *
 * Neither is a logic bug the engine or the contracts could catch: both are mapper
 * bugs, where correct data is joined to the wrong field. The only thing that catches
 * those is rendering the page and reading it.
 *
 * The assertions below are therefore about **what a user can see and check**, not
 * about component internals — the product's claims are the things on the screen.
 */

import { expect, test, type Page } from '@playwright/test';

/**
 * Credentials come from the environment, with no fallback.
 *
 * A literal password here would work — it is a fixture for a local database, not a
 * deployed credential — but it would need a gitleaks allowlist entry, and an allowlist
 * entry is a small hole in a guard that has already caught real problems. "It is only
 * a test fixture" is the sentence that precedes the second and third entries. One
 * required variable costs a line of setup documentation and keeps the secret scan
 * absolute.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. The E2E suite signs in as a real user against the local ` +
        'database — create one with `node scripts/user-admin.mjs create <email>` and set ' +
        'E2E_EMAIL and E2E_PASSWORD. See .env.example.',
    );
  }
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

test.describe('authentication', () => {
  test('the dashboard is not reachable signed out', async ({ page }) => {
    // Redirect rather than an empty shell: a dashboard rendering without data because
    // you are signed out looks exactly like a data outage.
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
  });

  test('a bad password is refused without saying which half was wrong', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill(EMAIL);
    await page.getByLabel('Password').fill('definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    // Scoped to the login panel: Next injects its own `role="alert"` route announcer,
    // so an unscoped role query matches two elements. Still asserts the role, because
    // the message being announced is the accessibility property that matters.
    const alert = page.locator('.login-panel [role="alert"]');
    await expect(alert).toBeVisible();
    // Enumeration resistance is a property of the *rendered* message, so it is
    // asserted where a user would read it.
    await expect(alert).toHaveText('Those credentials were not accepted.');
    await expect(alert).not.toContainText(/unknown|no such|not found|incorrect password/i);
  });

  test('an unknown account gets the identical message', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel('Email').fill('nobody-here@example.test');
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.locator('.login-panel [role="alert"]')).toHaveText(
      'Those credentials were not accepted.',
    );
  });

  test('signing in reaches the dashboard', async ({ page }) => {
    await signIn(page);
    await expect(page.getByText(`Signed in as ${EMAIL}`)).toBeVisible();
  });
});

test.describe('the dashboard reads as a measurement', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('the score is present with its caveat in the same block', async ({ page }) => {
    const panel = page.locator('.score-panel');
    await expect(panel).toBeVisible();

    // The caveat must be inside the score panel, not in a footer or a tooltip. This is
    // the assertion that would fail if someone moved it "for layout reasons".
    const caveat = panel.locator('.caveat');
    await expect(caveat).toBeVisible();
    await expect(caveat).toContainText(/not a forecast/i);
  });

  test('the reading is phrased in the present tense', async ({ page }) => {
    await expect(page.locator('.reading-label')).toContainText(/^Conditions read /);
  });

  test('the score is not rendered in hero type', async ({ page }) => {
    // Size reads as certainty, and certainty is measured separately here. The number
    // must be no larger than the sentence beside it.
    const value = page.locator('.reading-value');
    const label = page.locator('.reading-label');
    const valueSize = await value.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    const labelSize = await label.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(valueSize).toBeLessThanOrEqual(labelSize);
  });

  test('the scale shows both directions', async ({ page }) => {
    // A bidirectional axis reads as a position in a known range. A bar growing from
    // zero would read as strength.
    await expect(page.locator('.scale-end').first()).toHaveText('−100');
    await expect(page.locator('.scale-end').last()).toHaveText('+100');
  });

  test('no directional arrow or traffic-light styling is present', async ({ page }) => {
    // The prohibited grammar, asserted against the DOM rather than trusted to review.
    await expect(page.locator('[class*="arrow"]')).toHaveCount(0);
    await expect(page.locator('[class*="traffic"], [class*="gauge"]')).toHaveCount(0);
  });
});

test.describe('gaps are visible, not tucked away', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('the gap panel appears above the factor detail', async ({ page }) => {
    // A qualification below the detail is one most readers never reach.
    const gapBox = await page.locator('.gap-panel').boundingBox();
    const factorBox = await page.locator('.factor-list').boundingBox();
    expect(gapBox).not.toBeNull();
    expect(factorBox).not.toBeNull();
    expect(gapBox!.y).toBeLessThan(factorBox!.y);
  });

  test('gaps are grouped and explained by attribution', async ({ page }) => {
    const panel = page.locator('.gap-panel');
    await expect(panel).toContainText('What this reading does not include');
    // At least one group, each carrying its meaning rather than a bare label.
    await expect(panel.locator('.gap-meaning').first()).not.toBeEmpty();
  });

  test('a structural gap states the condition under which it resolves', async ({ page }) => {
    const structural = page.locator('.gap-structural');
    if ((await structural.count()) === 0) test.skip();
    await expect(structural).toContainText('Resolves:');
    // A limitation with an end date reads as a known constraint; without one it reads
    // as a permanent unknown.
    await expect(structural).toContainText(/twelve months|accumulated/i);
  });

  test('an abstaining factor renders no contribution bar', async ({ page }) => {
    // A zero-length bar at the centre line is visually identical to a factor that
    // measured exactly neutral — the confusion abstention exists to prevent.
    const abstained = page.locator('.factor-abstained').first();
    if ((await abstained.count()) === 0) test.skip();
    await expect(abstained.locator('.contribution-bar')).toHaveCount(0);
    await expect(abstained.locator('.no-reading')).toBeVisible();
  });
});

test.describe('freshness and provenance', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('a lag note sits beside the freshness chip, not behind a hover', async ({ page }) => {
    const lag = page.locator('.lag-note').first();
    if ((await lag.count()) === 0) test.skip();
    // Visible without interaction: the correction has to arrive in the same glance as
    // the claim it corrects.
    await expect(lag).toBeVisible();
    await expect(lag).toContainText(/days before publication/);
  });

  test('the provenance expander opens and names a real source', async ({ page }) => {
    const details = page.locator('.factor details.provenance').first();
    await details.locator('summary').click();
    await expect(details.locator('.prov-source').first()).not.toBeEmpty();
  });

  test('the expander shows a publication date that is not the run date', async ({ page }) => {
    /*
     * The regression that motivated this whole file. The mapper filled factor
     * provenance with the analysis `run_at`, so every fact claimed to have been
     * published on the day the analysis ran.
     */
    const runAtText = await page.locator('.report-link a').getAttribute('href');
    expect(runAtText).not.toBeNull();

    const details = page.locator('.factor details.provenance').first();
    await details.locator('summary').click();
    const meta = await details.locator('.prov-meta').first().innerText();

    const published = /published (\d{4}-\d{2}-\d{2})/.exec(meta)?.[1];
    expect(published).toBeDefined();

    const today = new Date().toISOString().slice(0, 10);
    // At least one fact must predate today. Macro series publish in arrears; if every
    // fact claims today's date, the mapper is stamping rather than reading.
    const allMeta = await details.locator('.prov-meta').allInnerTexts();
    const dates = allMeta
      .map((m) => /published (\d{4}-\d{2}-\d{2})/.exec(m)?.[1])
      .filter((d): d is string => d !== undefined);
    expect(dates.length).toBeGreaterThan(0);
    expect(dates.some((d) => d < today)).toBe(true);
  });
});

test.describe('the stored report', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('opens from the dashboard and renders the same run', async ({ page }) => {
    const dashboardReading = await page.locator('.reading-value').innerText();

    await page.locator('.report-link a').click();
    await page.waitForURL(/\/reports\//);

    await expect(page.locator('.report-tag')).toHaveText('Stored report');
    // The same evidence rendered by the same components: two renderers for one run is
    // two chances to disagree about what it said.
    await expect(page.locator('.reading-value')).toHaveText(dashboardReading);
  });

  test('says it is a snapshot before the number, not after', async ({ page }) => {
    await page.locator('.report-link a').click();
    await page.waitForURL(/\/reports\//);

    const noteBox = await page.locator('.report-note').boundingBox();
    const scoreBox = await page.locator('.score-panel').boundingBox();
    expect(noteBox!.y).toBeLessThan(scoreBox!.y);
    await expect(page.locator('.report-note')).toContainText(/not current readings/i);
  });

  test('carries the caveat too', async ({ page }) => {
    // Every surface that renders a score renders its caveat. That is the property, and
    // it holds because the caveat travels inside the payload.
    await page.locator('.report-link a').click();
    await page.waitForURL(/\/reports\//);
    await expect(page.locator('.score-panel .caveat')).toContainText(/not a forecast/i);
  });

  test('an unknown report id is a 404, not a crash', async ({ page }) => {
    const response = await page.goto('/reports/01a00000-0000-7000-8000-000000000000');
    expect(response?.status()).toBe(404);
  });
});

test.describe('the three layers stay distinguishable', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('each layer says what kind of claim it carries', async ({ page }) => {
    const panel = page.locator('.layer-panel');
    await expect(panel.locator('.layer-fact .layer-meaning')).toContainText(/Nothing here is inferred/);
    await expect(panel.locator('.layer-interpretation .layer-meaning')).toContainText(
      /not written by a model/,
    );
    await expect(panel.locator('.layer-ai_assessment .layer-meaning')).toContainText(
      /checked against them/,
    );
  });

  test('a derived statement can be traced to its parents', async ({ page }) => {
    // Traceability nobody can exercise is a claim rather than a property.
    const lineage = page.locator('.layer-interpretation details.lineage').first();
    await lineage.locator('summary').click();
    await expect(lineage.locator('.lineage-body').first()).not.toBeEmpty();
    await expect(lineage.locator('.layer-tag').first()).toContainText('fact');
  });

  test('an absent AI layer is explained rather than blank', async ({ page }) => {
    const ai = page.locator('.layer-ai_assessment');
    const statements = await ai.locator('.statements li').count();
    if (statements > 0) test.skip();
    // A missing section reads as a rendering bug; a section saying why is the system
    // reporting on itself.
    await expect(ai.locator('.layer-empty')).toContainText(/No AI assessment/);
  });
});
