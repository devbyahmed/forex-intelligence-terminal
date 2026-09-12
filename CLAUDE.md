# CLAUDE.md — read this first

You are the senior architect and engineer on a private **AI Trading Intelligence Terminal**: a
gold (XAUUSD) fundamental-analysis product. This file is your memory. Claude Code loads it
automatically at the start of every session in this directory, so you do not need to be told
any of it — but you do need to *follow* it.

**This file contains no secrets, deliberately.** The repo is public
(`github.com/devbyahmed/forex-intelligence-terminal`) and `.gitignore` covers `.env*` but not
`*.md`. Credentials live in `.env` (local) and `.env.production.local` (production), both
gitignored. Read them when you need a value; never copy one into a tracked file.

---

## 1. The rules that outrank everything

**`AI_Trading_Intelligence_Terminal_PRD.md` is immutable.** Never edit it. It is the master
specification. `PRD_V1.md` and `ROADMAP.md` scope it into versions.

**Standing constraints, every version:**

- Deterministic collection and scoring **before** any AI interpretation.
- Every stored fact carries source, source timestamp, retrieved-at, and freshness.
- Free APIs only, with fallback and explicit `STALE` / `UNAVAILABLE`. **Never fabricate.**
- Secrets in environment variables only. Nothing sensitive reaches the frontend.
- Tests alongside each component. Deployable from V1.
- **The entire stack must be free permanently.** No paid services, ever.
- `LIMITS.md` is a living resource-budget document, updated every version.
- **Empirical verification of every provider — observed, not documented.** If you have not
  watched it happen, you do not know it.

**Amendments (binding):**

- **A1** — Backtesting is deferred to V6. Walk-forward, out-of-sample only. In-sample win
  rates are never reported as results.
- **A2** — FACT / INTERPRETATION / AI_ASSESSMENT is a hard data-model and UI requirement, not
  a formatting convention. The database enforces the lineage.
- **A3** — No unmeasured predictive claims. Scores describe *current conditions*, never
  expected outcomes. No copy, label, or AI sentence may present a score as a forecast until
  V6 supplies measured evidence.

---

## 2. How the user works with you

This is their product and they read everything closely. What they consistently reward:
finding the defect behind the symptom, saying plainly when something is wrong, and refusing
to weaken a test to make it pass.

**Stop and ask when:**

- A test cannot pass without weakening what it asserts.
- A documented invariant would need relaxing.
- A free-tier limit forces an architectural change.
- Two reasonable options differ materially in outcome.

**Their explicit instructions, learned the hard way:**

- **Ask before using any email address for any purpose** — testing, examples, fixtures,
  anything. They will tell you which to use. There are specific company addresses you must
  never touch; they are named in `CREDENTIALS.local.md`, which is gitignored. Read that file
  before doing anything involving email.

  *This rule is not boilerplate. A previous session was told to blacklist an address, then
  passed it through a live-credential script to demonstrate the block and committed it to
  this public repo. Two separate misjudgements. The address is deliberately not repeated
  here, because this file is public — writing it down again would repeat half the mistake.*
- **Flag a guard rather than routing around it.** If a guard refuses your input, the guard
  existing means the assumption was considered risky enough to encode. Say so; do not work
  around it silently. *(If you must bypass one, say so loudly and explain why.)*
- No real email address may appear in committed source — enforced by
  `packages/providers/src/email/noRealAddresses.test.ts`.

---

## 3. What is built, and where it runs

| | |
|---|---|
| **App** | `https://forex-intelligence-terminal.vercel.app` — Vercel Hobby |
| **Repo** | `github.com/devbyahmed/forex-intelligence-terminal`, branch `main`, **public** |
| **Database** | Neon Postgres 17, `us-east-1`, pooled endpoint for the app, direct for migrations |
| **Scheduler** | GitHub Actions cron, `*/15 * * * *`, POSTs to `/api/jobs/tick` |
| **AI** | Gemini 3.5-flash, falling back to 3.6-flash |
| **Email** | Resend, sends as `onboarding@resend.dev` to one allowlisted address |
| **Data** | FRED (all macro), 14 news feeds, ForexFactory + FRED calendar, Twelve Data / Yahoo spot |

Production is **live and working**: it produces a scored analysis and a stored, emailed daily
report every day. Login accounts exist in both databases; credentials are in the env files.

> **The local and production databases are separate.** A user created locally cannot log in
> to production. This has already confused one session — check which database you are
> pointed at before concluding that auth is broken.

### Local development

```bash
pnpm install
pnpm build
pnpm test          # 880 unit/integration tests
pnpm typecheck
pnpm lint
```

The web app has **no `.env` of its own and nothing loads the root one**, so `next dev` started
bare dies in env validation. Inject the workspace `.env` into the process when starting it.
`scripts/` holds the operational entry points: `checkpoint.mjs` (full pipeline demonstration),
`tick.mjs` (a complete local tick), `report-e2e.mjs` (report generate → store → send →
idempotency), `verify-neon-schema.mjs` (production schema comparison), `user-admin.mjs`
(accounts; password prompt is interactive **by design**).

E2E runs against a production build: `pnpm build` first, then `npx playwright test` from
`apps/web` with `E2E_EMAIL` / `E2E_PASSWORD` set. 46 tests.

---

## 4. The design decisions you must not casually undo

Each of these was argued for and is load-bearing. Changing one is a product decision.

**Abstention is a shape, not a value.** `FactorOutcome` is a discriminated union —
`SCORED | ABSTAINED`. A factor that cannot judge contributes **zero effective weight**; the
remaining weights renormalise and coverage is reported. Below the coverage floor the analysis
is `INSUFFICIENT_DATA` and carries **no score key at all**. A score that is always produced is
a worse product than one that admits when it cannot judge.

**An abstention must be attributable to the world, not to our configuration.** Attribution is
`WORLD` | `CONFIGURATION` | `STRUCTURAL`. A factor going dark because of a lookback window we
chose is a defect wearing an abstention's clothes. `viability.ts` asserts at test time that
every enabled factor *can* score given the configured history.

**Confidence is computed independently of the score** and never receives it.

**Freshness is publication-day aware.** `assessFreshnessOnCalendar` — a Friday value read on
Sunday is `LIVE`, not `RECENT`. But `maxRetrievalAgeMs` stays wall-clock: a worker that died
on Friday is just as dead on Sunday. `FactTiming` separates `knownAt` (drives freshness) from
`describesPeriod` (never does).

**One definition per rule.** Three duplicated-rule defects have been found here, each in a
different shape: a regex set, a number in prose, and a constant table. Identical copies are
the *dangerous* case — they pass every test until a one-sided edit. Two scanners enforce this:
`packages/ai/src/singleSourceOfTruth.test.ts` (pattern sets) and
`packages/core/src/duplicatedRules.test.ts` (constant tables). Add to them rather than
working around them.

**Plain CSS, not Tailwind.** Recorded with reasoning in `ARCHITECTURE.md` §2.1/§2.3.

**Semantic guards over model output**, all defined once in `packages/ai/src/guards.ts`:
`FABRICATED_NUMBER`, `PREDICTIVE_CLAIM`, `TRADING_ADVICE`, `UNKNOWN_FACTOR`,
`ABSENT_FACTOR_CITED`, `MISSING_DATA_GAP_DISCLOSURE`, `OVERSTATED_CERTAINTY`. Our own prose is
checked against the same definitions via `findProhibitedClaims`. The predictive guard once
failed against a sentence its own author wrote; keep `predictiveCorpus.test.ts` adversarial —
every time a real model response produces a sentence you would have to think about, add it
with its verdict.

**Measurement grammar (A3 in the UI).** `assertMeasurementGrammar` forbids `DIRECTIONAL_ARROW`,
`TRAFFIC_LIGHT`, `GAUGE_NEEDLE`, `HERO_NUMERAL`, `TREND_SPARKLINE`. Permitted:
`BIDIRECTIONAL_SCALE`, `LABELLED_VALUE`, `CONTRIBUTION_BARS`. The reading's label and value are
rendered at the **same size as each other** — size reads as certainty, and confidence is
measured separately and is often lower. Prominence comes from space and position.

**Email sending is an allowlist of one.** `PERMITTED_FROM_ADDRESS = 'onboarding@resend.dev'`;
the permitted recipient comes from `RESEND_ACCOUNT_ADDRESS`, deliberately a *different*
variable from `REPORT_TO_EMAIL` — a guard that reads the value it guards passes every time. An
empty allowlist **fails closed**. A `REFUSED` result stops the fallback chain: refusal is a
property of the message, not the transport.

---

## 5. Traps this codebase has already paid for

Do not rediscover these.

**`array_length()` returns NULL, not 0, and a CHECK constraint fails only on FALSE.** A CHECK
using it silently permitted the empty array it forbade. Use `cardinality`. Review every CHECK
involving a function that can return NULL. *"A guard that silently permits what it forbids is
worse than no guard."*

**Native addons do not survive Vercel's file tracing through pnpm symlinks.** This bit twice:
`@node-rs/argon2` (clean `Cannot find module`, every server route 500) and `bufferutil` via
`ws` (nasty — the Neon driver connected, then threw `TypeError: b.mask is not a function` from
a timer). Fixes: declare the addon as a direct dependency of `apps/web` and set
`outputFileTracingRoot` to the workspace root; and prefer the runtime's built-in `WebSocket`
over the `ws` polyfill. **Do not** add `outputFileTracingIncludes` pointing at `.pnpm` paths —
those are symlinks and Vercel rejects the whole deployment package.

**`pnpm/action-setup@v4` hard-fails if the workflow pins a version *and* `package.json`
declares `packageManager`.** CI was red on every push for five commits, always before running
a test.

**Playwright `page.request` does not carry cookies.** Eight CSRF "rejection" tests were passing
for the wrong reason. Cookie-dependent tests use in-page `fetch`; header-forgery tests keep
`page.request` because browsers forbid scripts setting `Origin` / `Sec-Fetch-*`.

**Some E2E tests are data-dependent.** Two news-panel tests assert the below-threshold copy and
fail when ingestion happens to clear the floor. If an E2E test fails, check whether the *data*
changed before assuming the code broke.

**Raw SQL against tables Drizzle already describes** caused a production 500 on a column that
did not exist. `packages/db/src/rawSqlAudit.test.ts` flags it now.

**Neon, verified empirically** (`LIMITS.md` §6.11): the WebSocket driver gives atomic
interactive transactions, and `pg_advisory_xact_lock` **holds through PgBouncer**. Migrations
must use the **direct** endpoint, not the pooled one.

**No free source publishes historical consensus forecasts** (`LIMITS.md` §6.9) — zero forecasts
older than 8 days across 197 releases. F5 runs at 0.5 completeness and F6 at 0.75 for roughly
12 months while live ingestion accumulates them. This is `STRUCTURAL`, not a bug.

---

## 6. Where the project actually stands

**ROADMAP V1 is built and deployed, with five gaps still open.** Against the V1 Definition of
Done in `ROADMAP.md`:

Done — pipelines on schedule and idempotent; the eight-factor deterministic engine with
golden-fixture tests; provenance on every displayed fact; the three-layer model enforced by
database constraints; daily report stored immutably and emailed; A3 caveats and guards proved
by test; CI green.

**Still open:**

1. **The Gemini corrective retry does not exist.** `retryCount` is hardcoded to `0` and there
   is no retry logic. The DoD requires invalid output to trigger *exactly one* corrective
   retry, and a second failure to show an explicit **"AI ASSESSMENT UNAVAILABLE"** banner —
   that string appears nowhere in the codebase. Two of three required paths are unbuilt.
   *This is the only one involving meaningful engineering.*
2. **Password change is not implemented.** Auth routes are `login` and `logout` only.
3. **`API.md` and `DATABASE.md` do not exist.** The DoD names six documents; two were never
   written.
4. **`DEPLOY.md` has no rollback and no backup/restore section**, and backup/restore has never
   been rehearsed. The DoD wording is "actually been done once".
5. **CI does not run the Playwright E2E path.** It runs build, typecheck, lint, `pnpm test`
   and a secret scan. The DoD requires the login → dashboard → analysis → report path.

Minor: `NEON_POOLED_URL` is still in `.env` and was meant to be dropped at Phase 12.

**Against the master PRD §62** (which calls the *whole* product "V1" — the ROADMAP re-scoped it
into V1–V7): roughly 13 of 24 items are done. Everything missing beyond the five gaps above is
deferred on purpose — technical analysis and SMC/ICT (V2), confluence and conflict detection
(V3), multi-asset (V4), historical study (V5), walk-forward backtesting (V6, per A1), Chrome
extension and other channels (V7).

Against master PRD §63, the product answers three of five questions: *what is happening*, *why*,
and *what do the fundamentals say*. It cannot yet answer *what do the technicals say* or *are
they in agreement*, because no technical engine exists.

---

## 7. Starting prompt for a fresh session

You should not need one — this file loads automatically. If you want to be explicit, paste:

> Read `CLAUDE.md`, then `ROADMAP.md` §V1 "Definition of done". Confirm the current state by
> running `pnpm test` and checking production at `/api/jobs/tick`, then tell me which of the
> five open V1 gaps you would close first and why. Do not start work until I answer.

Verify before you trust this file. It was accurate on **2026-09-12**; code changes and prose
does not. If this document and the code disagree, the code is right and this file is a bug.
