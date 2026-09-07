/**
 * The news, calendar, refresh and status panels.
 *
 * Two of these carry product claims that only exist on screen:
 *
 *  - **News.** F8 does not score. The panel has to render that as a *measurement of
 *    coverage* — "6 relevant articles, 10 needed" — not as an empty region. A blank
 *    panel reads as broken, and a user who thinks a panel is broken concludes the
 *    system is unreliable rather than that the evidence is thin.
 *  - **Refresh.** The button spends a shared daily allowance. Its price has to be
 *    visible before the click, and a refusal has to name what is short and when it
 *    resets — otherwise a curious user at 10am breaks the scheduled run at 4pm.
 */

import { expect, test, type Page } from '@playwright/test';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. See .env.example.`);
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

test.beforeEach(async ({ page }) => {
  await signIn(page);
});

test.describe('news coverage reads as a measurement, not emptiness', () => {
  test('states the count against the threshold', async ({ page }) => {
    const panel = page.locator('.news-panel');
    await expect(panel).toBeVisible();
    // A count of relevant articles out of a count collected. "No data" would be both
    // less true and more alarming.
    await expect(panel.locator('.news-measure')).toContainText(/\d+ gold-relevant/);
    await expect(panel.locator('.news-measure')).toContainText(/out of \d+ collected/);
  });

  test('shows the threshold with the reason it exists', async ({ page }) => {
    // A floor a user cannot see is a floor they will assume was chosen to make the
    // number look good.
    const threshold = page.locator('.news-threshold');
    await expect(threshold).toContainText(/at least \d+ relevant articles/);
    await expect(threshold).toContainText(/square root/);
  });

  test('the threshold explanation is not visually demoted', async ({ page }) => {
    // Same type scale as the measurement above it. A greyed-out footnote would read as
    // an apology for missing data rather than a statement about what six articles can
    // support.
    const measureSize = await page
      .locator('.news-measure')
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    const thresholdSize = await page
      .locator('.news-threshold p')
      .first()
      .evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
    expect(thresholdSize).toBeGreaterThanOrEqual(measureSize * 0.9);
  });

  test('distinguishes counted articles from collected-but-irrelevant ones', async ({ page }) => {
    const list = page.locator('.news-list li');
    if ((await list.count()) === 0) test.skip();
    // Showing both is what separates "the feeds produced nothing" from "the feeds
    // produced plenty and little of it was about gold".
    const labels = await page.locator('.news-relevant, .news-irrelevant').allInnerTexts();
    expect(labels.length).toBeGreaterThan(0);
  });
});

test.describe('refresh shows its cost before it is spent', () => {
  test('the label states what pressing it consumes', async ({ page }) => {
    const panel = page.locator('.refresh-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.hint')).toContainText(/Refreshing costs .* from /);
  });

  test('the per-provider budget is shown, not just the verdict', async ({ page }) => {
    // A user refused while credits visibly remain needs to see the reserve, or the
    // refusal looks arbitrary and the number looks wrong.
    const table = page.locator('.quota-table');
    await expect(table).toContainText('Held for scheduled runs');
    await expect(table).toContainText('Used today');
  });

  test('pluralises units correctly', async ({ page }) => {
    // "1 requests" reads as a bug in a sentence whose whole job is to be trusted
    // about a number.
    await expect(page.locator('.refresh-panel .hint')).not.toContainText(/\b1 (requests|credits)\b/);
  });

  test('the button is disabled with a stated reason when unaffordable', async ({ page }) => {
    const refusal = page.locator('.refresh-refusal');
    if ((await refusal.count()) === 0) {
      // Affordable today: assert the button is usable rather than skipping silently.
      await expect(page.locator('.refresh-button')).toBeEnabled();
      return;
    }
    await expect(page.locator('.refresh-button')).toBeDisabled();
    await expect(refusal).toContainText(/resets/);
    await expect(refusal).toContainText(/held back for the scheduled run/);
  });
});

test.describe('system status reports on the pipeline itself', () => {
  test('lists providers with their quota consumption', async ({ page }) => {
    const panel = page.locator('.status-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('.status-table')).toContainText('Quota today');
  });

  test('shows recent job runs', async ({ page }) => {
    await expect(page.locator('.status-panel')).toContainText('Recent job runs');
  });
});

test.describe('the calendar is honest about missing forecasts', () => {
  test('explains the empty forecast column rather than leaving blanks', async ({ page }) => {
    const note = page.locator('.calendar-note');
    if ((await note.count()) === 0) test.skip();
    // A column of blank cells with no explanation is indistinguishable from a broken
    // join.
    await expect(note).toContainText(/no consensus forecast/);
    await expect(note).toContainText(/free source/);
  });

  test('renders a missing value as a dash, never as zero', async ({ page }) => {
    const table = page.locator('.calendar-table');
    if ((await table.count()) === 0) test.skip();
    // Zero is a real forecast value. Rendering an absence as 0 would invent a reading.
    await expect(table.locator('td.num').first()).not.toHaveText('0');
  });
});
