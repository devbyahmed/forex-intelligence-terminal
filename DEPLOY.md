# Deployment

Phase 12 builds this out fully. What is here now is the part that has already been
verified against the real services, recorded while the reasoning is fresh — in
particular the connection-string distinction, which is the kind of thing that is
obvious for a week and then costs somebody an afternoon.

## Environment variables

| Variable | Local | Production | Used by |
|---|---|---|---|
| `DATABASE_URL` | local Postgres | Neon **pooled** | app and worker at runtime |
| `DIRECT_DATABASE_URL` | unset → falls back to `DATABASE_URL` | Neon **direct (non-pooled)** | migrations and DDL only |
| `TEST_DATABASE_URL` | local test database | — | integration tests |
| `NEON_POOLED_URL` | pooled string, pre-deploy checks only | — | verification scripts; **remove at Phase 12** |
| `JOB_TRIGGER_SECRET` | any value | 32+ random chars | authenticates `POST /api/jobs/tick` |
| `REPORT_TIMEZONE` | `America/New_York` | same | the report’s day boundary |
| `RESEND_API_KEY` | — | Resend sending key | daily report, alerts |
| `RESEND_ACCOUNT_ADDRESS` | account signup address | same | the recipient allowlist |
| `REPORT_FROM_EMAIL` | `onboarding@resend.dev` | same | sender, checked against the allowlist |
| `REPORT_TO_EMAIL` | account signup address | same | report recipient |

`DATABASE_URL` stays pointed at local Postgres in development and is overridden by the
hosting environment in production. That is deliberate: local test runs must keep working
without editing anything, and a developer who pulls this repo should not be one typo away
from writing to production.

## Neon: pooled and direct are not interchangeable

Neon gives two endpoints for the same database:

- **Pooled** — hostname contains `-pooler`. Goes through PgBouncer in transaction mode.
  Correct for application queries: it is what makes a scale-to-zero database survive
  many short-lived serverless invocations.
- **Direct** — the same hostname **without** `-pooler`. Correct for migrations.

**Migrations must use the direct endpoint.** DDL through PgBouncer in transaction mode
can misbehave, and a half-applied migration discovered during a deploy is a far worse
thing to debug than one caught beforehand. `scripts/verify-neon-schema.mjs` refuses to
run if `DIRECT_DATABASE_URL` contains `-pooler`, because a pooled string in that variable
would silently defeat the only reason the variable exists.

### Getting the direct string

**Take it from the Neon console, not by editing the pooled one.**

1. Neon console → your project → **Connection Details**.
2. In the connection string panel, find the **Connection pooling** toggle.
3. Turn it **off**. The string shown is the direct endpoint.
4. Copy it whole, including `?sslmode=require`.

> **The value currently in `.env` was derived, not supplied.**
>
> During Phase 11 verification the pooled string was pasted twice, so the direct host was
> obtained by removing `-pooler` and then **verified by connecting** — same database, same
> credentials, PostgreSQL 17.11. The migration run against it succeeded and the schema
> matched local exactly.
>
> That derivation happens to be Neon's convention today, but it is a convention, not a
> contract: it is not guaranteed across regions, project types, or future changes to
> their hostname scheme. **Whoever sets the production variables should copy the string
> from the console** rather than reproduce the string manipulation.

### Verifying before a deploy

```bash
node scripts/verify-neon-schema.mjs
```

Applies the migration set over the direct connection, then compares tables, enums, CHECK
constraints, triggers and indexes against the local database in **both** directions,
confirms the lineage trigger and the A2 and abstention constraints are present, seeds,
and runs the seed reconciliation check. It exits non-zero on any difference.

Last run 2026-09-06 against `us-east-1`, PostgreSQL 17.11: 32 tables, 16 enums, 33 CHECK
constraints, 31 triggers, 92 indexes — all matching, seed reconciliation clean.

## Watch for URL-special characters

Passwords are embedded in these connection strings, and a URL parser splits on the
**first** `@` — so a password containing one truncates the host and produces a connection
error that points nowhere useful. This project has already lost time to that, and
separately to a trailing `\r` on a pasted key.

Both are checked rather than assumed: the verification script parses each string and
reports the password's length, any URL-special characters it contains, and whether the
value had surrounding whitespace. If a password must contain `@`, `:`, `/`, `?`, `#` or
`%`, percent-encode it.

## Email: the restricted sending path is deliberate

The Resend account is shared with an unrelated project that owns a verified domain. This
project sends **as** `onboarding@resend.dev` and **to** the account signup address only,
enforced by an allowlist of one in `packages/providers/src/email/sendingIdentity.ts`.

`RESEND_ACCOUNT_ADDRESS` is deliberately a separate variable from `REPORT_TO_EMAIL`: a
guard that reads the value it is guarding compares a thing to itself and passes every
time. An unset allowlist **fails closed** rather than being treated as no restriction.

Do not widen the check to make a configuration change work. If this project needs its own
sending domain, verify one on a **separate** Resend account and update
`PERMITTED_FROM_ADDRESS` with that decision recorded — see LIMITS.md §6.10 for why.

## Vercel project settings

This is a pnpm workspace, and Vercel’s monorepo defaults are wrong for it — the
defaults install from `apps/web` alone, which cannot resolve `workspace:*`
dependencies. Set these explicitly:

| Setting | Value |
|---|---|
| Framework preset | Next.js |
| Root Directory | `apps/web` |
| Include files outside root | **on** (needed for `packages/*`) |
| Install Command | `cd ../.. && pnpm install --frozen-lockfile` |
| Build Command | `cd ../.. && pnpm build --filter @forex-agent/web...` |
| Output Directory | `.next` (default) |
| Node.js Version | 24.x |

The `...` suffix on the filter is load-bearing: it builds the web app **and everything
it depends on**. Without it Vercel builds `apps/web` against packages that were never
compiled, and the failure is a module-not-found for a workspace package that plainly
exists.

## The scheduled tick

Vercel’s own cron is limited to one invocation a day on the free plan, which is not a
schedule this product can run on. GitHub Actions cron is free for public repositories
and drives the tick instead: `.github/workflows/tick.yml` POSTs to
`/api/jobs/tick` every 15 minutes with `Authorization: Bearer $JOB_TRIGGER_SECRET`.

Two properties of that scheduler are designed around rather than assumed away:

- **It is at-least-once and often late.** Scheduled runs queue on shared infrastructure
  and can be delayed or dropped. Every job claims its slot under a unique
  `(job_name, scheduled_for)` key, so a duplicated delivery runs nothing twice and a
  missed one is simply due again.
- **It stops after 60 days without a commit.** GitHub disables scheduled workflows on
  inactive repositories. The data-failure alert is what notices: an ingestion gap
  raises an email even when the cause is that nothing is running at all.

Repository secrets required: `APP_BASE_URL` and `JOB_TRIGGER_SECRET`.

Verify a deploy immediately with **Actions → Scheduled tick → Run workflow**, rather
than waiting for the next quarter hour. The response body lists what ran.

### Running a tick locally

```bash
node scripts/tick.mjs           # run whatever is due
node scripts/tick.mjs --force   # ignore the ledger and run every job now
```

This is not a rehearsal of the deployed path — it calls the same `buildTick()` and the
same `handleHttpTrigger()` the route calls, with the same environment. A difference
between this and production is a difference in the platform, not in the code.

## The reporting calendar

`REPORT_TIMEZONE` decides which civil day a run is filed under and which analyses count
as belonging to that day. It is `America/New_York` because every fact in this system is
anchored to US release and market calendars — the 08:30 ET prints, the business-day
freshness thresholds, the economic calendar itself. A UTC boundary files a run made
after 20:00 ET under tomorrow while its contents describe today.

**Market calculations remain UTC throughout** (master PRD 15). The line matters: this
variable governs labelling and selection, never arithmetic. Freshness, z-scores and
every threshold are untouched by it.

Verified 2026-09-07: a report generated 23:24 ET was stored as `2026-09-06`, rendered
from an analysis run at 23:24 ET the same day. UTC would have dated it `2026-09-07`.

## Shared free-tier allowances

Both external accounts are shared with another project, and both allowances are **per
account**:

- **Neon** — 100 CU-hours/month compute, 0.5 GB storage per branch. This project projects
  ~8–12 CU-hours at a 15-minute tick with scale-to-zero after 5 minutes.
- **Resend** — 100 emails/day, 3,000/month. This project sends one report a day.

Headroom is large at V1 volumes, but the 15-minute tick and the 5-minute suspend are
load-bearing for a budget this project does not solely control. See LIMITS.md §6.10–6.11.
