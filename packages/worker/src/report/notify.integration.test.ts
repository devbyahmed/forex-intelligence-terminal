/**
 * Report storage, cooldown and notification recording, against real Postgres.
 *
 * The properties under test are ones a fake database cannot demonstrate: immutability
 * rests on a unique index, and the concurrent case rests on how Postgres resolves a
 * conflicting insert. Both would pass trivially against a stub and prove nothing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { uuidv7 } from '@forex-agent/core';
import {
  alertRules,
  analyses,
  assets,
  configProfiles,
  notifications,
  reports,
  seed,
  users,
} from '@forex-agent/db';
import { createTestDb, hasTestDatabase, type TestDb } from '@forex-agent/db/test-support';
import type { EmailProvider } from '@forex-agent/providers';
import {
  checkCooldown,
  markRuleFired,
  notify,
  recordSuppression,
  storeReport,
} from './notify.js';
import type { RenderedReport } from './render.js';

const describeIfDb = hasTestDatabase() ? describe : describe.skip;

const rendered = (over: Partial<RenderedReport['payload']> = {}): RenderedReport => ({
  title: 'XAUUSD — fundamental conditions, 2026-09-06',
  subject: 'XAUUSD 2026-09-06: conditions read bearish (-14.6), confidence high',
  text: 'Reading: -14.6 on the -100 to +100 scale (Bearish).',
  html: '<pre>Reading: -14.6</pre>',
  payload: {
    schemaVersion: '1',
    reportDate: '2026-09-06',
    asset: 'XAUUSD',
    analysisId: 'analysis-1',
    status: 'SCORED',
    signedScore: -14.6,
    displayScore: 43,
    band: 'Bearish',
    confidence: { value: 88, level: 'HIGH' },
    coverage: 0.875,
    gapCount: 1,
    hasAiAssessment: false,
    ...over,
  },
});

describeIfDb('report storage and notification (real Postgres)', () => {
  let handle: TestDb;
  let assetId: string;
  let profileId: string;

  beforeAll(async () => {
    handle = await createTestDb();
  });

  afterAll(async () => {
    await handle.close();
  });

  beforeEach(async () => {
    await handle.truncateAll();
    await seed(handle.db, { profileName: 'default', config: { placeholder: true } });
    const [asset] = await handle.db
      .select({ id: assets.id })
      .from(assets)
      .where(eq(assets.symbol, 'XAUUSD'))
      .limit(1);
    assetId = asset?.id ?? '';

    const [profile] = await handle.db
      .select({ id: configProfiles.id })
      .from(configProfiles)
      .limit(1);
    profileId = profile?.id ?? '';
  });

  /**
   * A real analysis row.
   *
   * `report_assets.analysis_id` is a foreign key, and passing a random UUID makes the
   * insert fail — correctly. The linkage is the point of the table: a stored report has
   * to name the run it was generated from, or reopening it cannot show the same
   * evidence.
   */
  async function insertAnalysis(): Promise<string> {
    const id = uuidv7();
    await handle.db.insert(analyses).values({
      id,
      assetId,
      mode: 'FUNDAMENTAL',
      status: 'COMPLETE',
      configProfileId: profileId,
      fundamentalScore: -14.6,
      coverage: 0.875,
    });
    return id;
  }

  describe('a stored report is immutable', () => {
    it('stores a report and links it to the analysis', async () => {
      const result = await storeReport(handle.db, {
        rendered: rendered(),
        assetId,
        analysisId: await insertAnalysis(),
      });
      expect(result.created).toBe(true);

      const [row] = await handle.db
        .select({ text: reports.contentText })
        .from(reports)
        .where(eq(reports.id, result.id));
      expect(row?.text).toContain('-14.6');
    });

    it('returns the existing report rather than rewriting it', async () => {
      /*
       * The property that makes an emailed link trustworthy. A report is a record of
       * what was said; a record that changes when the pipeline reruns is not one, and
       * yesterday's link would resolve to today's numbers.
       */
      const first = await storeReport(handle.db, {
        rendered: rendered(),
        assetId,
        analysisId: await insertAnalysis(),
      });

      const second = await storeReport(handle.db, {
        // A different reading for the same date — exactly the dangerous case.
        rendered: { ...rendered({ signedScore: 42, band: 'Bullish' }), text: 'Reading: +42.0' },
        assetId,
        analysisId: await insertAnalysis(),
      });

      expect(second.created).toBe(false);
      expect(second.id).toBe(first.id);

      const [row] = await handle.db
        .select({ text: reports.contentText })
        .from(reports)
        .where(eq(reports.id, first.id));
      // The original content, untouched.
      expect(row?.text).toContain('-14.6');
      expect(row?.text).not.toContain('+42.0');
    });

    it('produces one report when two runs race', async () => {
      // A duplicated tick or a retry must not create two reports for one date, and must
      // not fail either — both callers need the id.
      const [a, b] = await Promise.all([
        storeReport(handle.db, { rendered: rendered(), assetId, analysisId: await insertAnalysis() }),
        storeReport(handle.db, { rendered: rendered(), assetId, analysisId: await insertAnalysis() }),
      ]);

      expect(a.id).toBe(b.id);
      expect([a.created, b.created].filter(Boolean)).toHaveLength(1);

      const all = await handle.db.select({ id: reports.id }).from(reports);
      expect(all).toHaveLength(1);
    });

    it('keeps reports for different dates separate', async () => {
      await storeReport(handle.db, { rendered: rendered(), assetId, analysisId: await insertAnalysis() });
      await storeReport(handle.db, {
        rendered: rendered({ reportDate: '2026-09-07' }),
        assetId,
        analysisId: await insertAnalysis(),
      });
      expect(await handle.db.select({ id: reports.id }).from(reports)).toHaveLength(2);
    });
  });

  describe('every send attempt is recorded', () => {
    const provider = (result: unknown): EmailProvider => ({
      id: 'stub',
      isConfigured: () => true,
      send: vi.fn().mockResolvedValue(result),
    });

    it('records a successful send with the provider message id', async () => {
      const outcome = await notify(
        handle.db,
        [provider({ kind: 'SENT', providerId: 'stub', messageId: 'msg-1' })],
        {
          reportId: null,
          userId: null,
          alertRuleId: null,
          templateName: 'daily-briefing',
          recipient: 'recipient@example.invalid',
          from: 'onboarding@resend.dev',
          subject: 'subject',
          text: 'body',
          now: new Date('2026-09-06T09:00:00Z'),
        },
      );

      expect(outcome.kind).toBe('SENT');
      const [row] = await handle.db.select().from(notifications);
      expect(row?.status).toBe('SENT');
      expect(row?.providerMessageId).toBe('msg-1');
      expect(row?.sentAt).not.toBeNull();
    });

    it('records a failure with its reason rather than losing it', async () => {
      // "No email arrived" and "the provider refused it" are different situations, and
      // without a row they are indistinguishable — including from a job that never ran.
      const outcome = await notify(
        handle.db,
        [provider({ kind: 'FAILED', providerId: 'stub', reason: 'HTTP_503', retryable: true })],
        {
          reportId: null,
          userId: null,
          alertRuleId: null,
          templateName: 'daily-briefing',
          recipient: 'recipient@example.invalid',
          from: 'onboarding@resend.dev',
          subject: 'subject',
          text: 'body',
          now: new Date(),
        },
      );

      expect(outcome.kind).toBe('FAILED');
      const [row] = await handle.db.select().from(notifications);
      expect(row?.status).toBe('FAILED');
      expect(row?.errorMessage).toContain('HTTP_503');
      expect(row?.sentAt).toBeNull();
    });

    it('records a refusal as a failure carrying the guard message', async () => {
      const outcome = await notify(
        handle.db,
        [provider({ kind: 'REFUSED', providerId: 'stub', reason: 'from address not permitted' })],
        {
          reportId: null,
          userId: null,
          alertRuleId: null,
          templateName: 'daily-briefing',
          recipient: 'recipient@example.invalid',
          from: 'onboarding@resend.dev',
          subject: 'subject',
          text: 'body',
          now: new Date(),
        },
      );

      expect(outcome.kind).toBe('FAILED');
      const [row] = await handle.db.select().from(notifications);
      expect(row?.errorCode).toBe('REFUSED');
      expect(row?.errorMessage).toContain('not permitted');
    });
  });

  describe('suppression is recorded, so silence is explainable', () => {
    it('writes a row when an alert is suppressed', async () => {
      /*
       * A quiet inbox during an outage otherwise looks identical to a working system —
       * the same confusion the abstention model exists to prevent, one layer out.
       */
      const userId = uuidv7();
      await handle.db.insert(users).values({
        id: userId,
        email: 'operator@example.invalid',
        passwordHash: 'x',
        isActive: true,
      });
      const ruleId = uuidv7();
      await handle.db.insert(alertRules).values({
        id: ruleId,
        userId,
        ruleType: 'DATA_FAILURE',
        cooldownSeconds: 3600,
      });

      await recordSuppression(handle.db, {
        alertRuleId: ruleId,
        userId,
        templateName: 'data-failure',
        recipient: 'operator@example.invalid',
        subject: 'Ingestion failing',
        reason: 'Suppressed by a 60-minute cooldown; next allowed in 42 minutes.',
      });

      const [row] = await handle.db.select().from(notifications);
      expect(row?.status).toBe('SUPPRESSED');
      expect(row?.suppressedReason).toContain('next allowed in 42 minutes');
      expect(row?.sentAt).toBeNull();
    });

    it('advances the cooldown window when a rule fires', async () => {
      const userId = uuidv7();
      await handle.db.insert(users).values({
        id: userId,
        email: 'operator@example.invalid',
        passwordHash: 'x',
        isActive: true,
      });
      const ruleId = uuidv7();
      await handle.db.insert(alertRules).values({ id: ruleId, userId, ruleType: 'DATA_FAILURE' });

      const firedAt = new Date('2026-09-06T09:00:00Z');
      await markRuleFired(handle.db, ruleId, firedAt);

      const [row] = await handle.db
        .select({ lastFiredAt: alertRules.lastFiredAt })
        .from(alertRules)
        .where(eq(alertRules.id, ruleId));
      expect(row?.lastFiredAt?.toISOString()).toBe(firedAt.toISOString());
    });
  });
});

describe('cooldown arithmetic', () => {
  const now = new Date('2026-09-06T12:00:00Z');

  it('allows the first firing', () => {
    expect(checkCooldown({ lastFiredAt: null, cooldownSeconds: 3600, now }).allowed).toBe(true);
  });

  it('suppresses inside the window', () => {
    /*
     * The failure this prevents: at a 15-minute tick, a problem lasting a day sends 96
     * emails. The ninety-sixth is less informative than the first, because by then
     * nobody is reading them.
     */
    const decision = checkCooldown({
      lastFiredAt: new Date('2026-09-06T11:45:00Z'),
      cooldownSeconds: 3600,
      now,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.nextAllowedAt?.toISOString()).toBe('2026-09-06T12:45:00.000Z');
  });

  it('says when the next one is allowed, not just that it was suppressed', () => {
    // An operator seeing a gap in alerts needs to know whether to wait or investigate.
    const decision = checkCooldown({
      lastFiredAt: new Date('2026-09-06T11:45:00Z'),
      cooldownSeconds: 3600,
      now,
    });
    expect(decision.reason).toContain('15 minutes ago');
    expect(decision.reason).toContain('next allowed in 45 minutes');
  });

  it('allows again exactly at the boundary', () => {
    expect(
      checkCooldown({
        lastFiredAt: new Date('2026-09-06T11:00:00Z'),
        cooldownSeconds: 3600,
        now,
      }).allowed,
    ).toBe(true);
  });

  it('treats a zero cooldown as no suppression', () => {
    expect(
      checkCooldown({ lastFiredAt: new Date('2026-09-06T11:59:59Z'), cooldownSeconds: 0, now })
        .allowed,
    ).toBe(true);
  });
});
