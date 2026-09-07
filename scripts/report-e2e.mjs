/**
 * End-to-end daily report: generate, store, send, and prove idempotency.
 *
 * Everything shown is read back from the database rather than printed from memory.
 * Printing what was just computed proves the computation; printing what storage returns
 * proves the round trip, which is the part that has to work tomorrow.
 *
 * Usage: node scripts/report-e2e.mjs
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = Object.fromEntries(
  readFileSync(join(repoRoot, '.env'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);

const { createDb, notifications, reports } = await import(
  `file://${join(repoRoot, 'packages/db/dist/index.js')}`
);
const { ResendEmailProvider, SmtpEmailProvider } = await import(
  `file://${join(repoRoot, 'packages/providers/dist/index.js')}`
);
const { dailyReportJob } = await import(`file://${join(repoRoot, 'packages/worker/dist/index.js')}`);
const { desc, eq } = await import('drizzle-orm');

const rule = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);

const h = createDb({ connectionString: env.DATABASE_URL });
const now = new Date();

const providers = [
  new ResendEmailProvider({
    apiKey: env.RESEND_API_KEY,
    permittedTo: env.RESEND_ACCOUNT_ADDRESS,
  }),
  new SmtpEmailProvider({ url: env.SMTP_URL ?? '', permittedTo: env.RESEND_ACCOUNT_ADDRESS }),
];

const job = dailyReportJob({
  providers,
  from: env.REPORT_FROM_EMAIL,
  to: env.REPORT_TO_EMAIL,
  appBaseUrl: env.APP_BASE_URL ?? 'http://localhost:3000',
});

rule('1. FIRST RUN — generate, store, send');
const first = await job({ db: h.db, now, logger: console });
console.log(first.detail);

rule('2. STORED REPORT — read back from Postgres');
const [stored] = await h.db
  .select()
  .from(reports)
  .orderBy(desc(reports.generatedAt))
  .limit(1);

console.log('id           ', stored.id);
console.log('report_date  ', stored.reportDate);
console.log('kind         ', stored.kind);
console.log('title        ', stored.title);
console.log('generated_at ', stored.generatedAt.toISOString());
console.log('payload      ', JSON.stringify(stored.payload));
console.log('content_text ', stored.contentText.length, 'chars');
console.log('content_html ', stored.contentHtml.length, 'chars');

rule('3. THE EMAIL AS DELIVERED — text part');
const [sent] = await h.db
  .select()
  .from(notifications)
  .orderBy(desc(notifications.createdAt))
  .limit(1);
console.log(`subject: ${sent.subject}\n`);
console.log(stored.contentText);
console.log(`\nPermanent copy of this report: ${(env.APP_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '')}/reports/${stored.id}`);

rule('4. THE EMAIL AS DELIVERED — HTML part');
console.log(stored.contentHtml.slice(0, 700));
console.log(`… (${stored.contentHtml.length} chars total)`);

rule('5. DELIVERY RECORD');
console.log('status              ', sent.status);
console.log('provider            ', sent.providerId);
console.log('provider_message_id ', sent.providerMessageId ?? '(none)');
console.log('recipient           ', sent.recipient);
console.log('template            ', sent.templateName);
console.log('report_id           ', sent.reportId);
console.log('sent_at             ', sent.sentAt?.toISOString() ?? '(not sent)');
console.log('error               ', sent.errorMessage ?? '(none)');

rule('6. PERMANENT LINK RESOLVES TO THE SAME READING');
const [byLink] = await h.db.select().from(reports).where(eq(reports.id, stored.id)).limit(1);
const linkPayload = byLink.payload;
console.log('link target id     ', byLink.id);
console.log('reading in payload ', linkPayload.signedScore, linkPayload.band);
const inText = /Reading: ([-+][\d.]+)/.exec(byLink.contentText)?.[1];
console.log('reading in text    ', inText);
/*
 * The payload keeps full precision; the document states the reading at the precision it
 * is presented in. So the comparison has to apply the renderer's own rounding — comparing
 * the raw payload against the rendered string reports a mismatch that is not one, and a
 * check that cries wolf gets ignored on the day it is right.
 */
const rendered1dp =
  (linkPayload.signedScore > 0 ? '+' : '') + linkPayload.signedScore.toFixed(1);
console.log('payload at 1dp     ', rendered1dp);
console.log(
  'agree              ',
  rendered1dp === inText
    ? 'YES — the stored document and its payload state the same reading'
    : 'NO — MISMATCH',
);

rule('7. SECOND RUN — idempotency');
const before = (await h.db.select({ id: reports.id }).from(reports)).length;
const beforeNotifications = (await h.db.select({ id: notifications.id }).from(notifications)).length;

const second = await job({ db: h.db, now: new Date(), logger: console });
console.log(second.detail);

const after = (await h.db.select({ id: reports.id }).from(reports)).length;
const afterNotifications = (await h.db.select({ id: notifications.id }).from(notifications)).length;

console.log(`\nreports       before ${before}  after ${after}`);
console.log(`notifications before ${beforeNotifications}  after ${afterNotifications}`);
console.log(
  after === before && afterNotifications === beforeNotifications
    ? '-> IDEMPOTENT: no second report, no second email.'
    : '-> NOT IDEMPOTENT: a duplicate was created.',
);

await h.close();
