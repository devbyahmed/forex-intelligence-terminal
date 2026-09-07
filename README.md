# AI Trading Intelligence Terminal

A private, evidence-based market research terminal. It collects real economic, market
and news data from free official sources, scores it deterministically, has an AI
interpret that structured evidence under a strict schema, and shows every conclusion
alongside the source it came from.

**It is not a trading bot.** It never places, modifies or manages an order, and never
connects to a broker (master PRD §48).

## Status

**V1, Phase 7 of 12 complete** — foundation, core value types, configuration,
logging, the database schema, authentication, the provider layer, the job runner, the economic calendar, news, macro and spot-price pipelines. See [ROADMAP.md](ROADMAP.md) for the version plan and [PRD_V1.md](PRD_V1.md)
for the V1 specification.

| Phase | Component | Status |
|---|---|---|
| 1 | Monorepo, core types, config, logging, CI | ✅ Complete |
| 2 | Database schema and migrations | ✅ Complete |
| 3 | Authentication | ✅ Complete |
| 4 | Provider abstraction and worker | ✅ Complete |
| 5 | Economic calendar pipeline | ✅ Complete |
| 6 | News pipeline | ✅ Complete |
| 7 | Macro and spot pipelines | ✅ Complete |
| 8 | Fundamental engine | Not started |
| 9 | Gemini integration | Not started |
| — | **Checkpoint: end-to-end demonstration** | — |
| 10 | Dashboard | Not started |
| 11 | Daily report and email | Not started |
| 12 | Documentation and production deploy | Not started |

## The four rules this system is built around

1. **Deterministic first.** Data is collected, validated and scored by pure code. The
   AI interprets the result; it never produces the underlying numbers.
2. **Never fabricate.** Missing data is `UNAVAILABLE`. Old data is `STALE`. Nothing is
   interpolated, defaulted or guessed to fill a gap.
3. **Everything is attributed.** Every stored fact carries its source, the timestamp
   the source gave it, when we retrieved it, and a freshness status.
4. **Facts, interpretations and AI assessments are separate.** Not as formatting — as
   distinct database rows with distinct provenance rules, and distinct UI components.

Two standing amendments extend these: **A1**, backtesting must be walk-forward
out-of-sample with confidence intervals and in-sample results are never reported; and
**A3**, scores describe current conditions and are never presented as forecasts of
price movement. Both are enforced in code, not documentation.

## Architecture

Full design in [ARCHITECTURE.md](ARCHITECTURE.md).

```text
packages/core     Pure domain: Observation envelope, freshness, ProviderResult,
                  score scales, UUIDv7, vocabulary, error taxonomy. No dependencies.
packages/config   Environment parsing, runtime configuration, logging.
                  The only place process.env is read.
packages/db       Drizzle schema, migrations, dual-driver client, advisory locks,
                  seed data, and the integration-test harness.
packages/auth     Argon2id hashing, sessions, CSRF, rate limiting and lockout.
packages/providers Provider interfaces, fallback chains, rate limits, circuit breakers.
packages/engines  Pure analysis: news classification, sentiment, aggregation.
packages/worker   Ledger-driven job runner with interval and HTTP triggers.
packages/testing  Deterministic fixtures shared across packages.
```

Packages arriving in later phases: `providers`, `engines`, `ai`, `notifications`,
`contracts`, plus `apps/web` and `apps/worker`.

### Module boundaries are enforced by lint, not convention

`eslint.config.js` fails the build on:

- `process.env` outside `packages/config` — keeps credentials server-side
- `@forex-agent/db` or `@forex-agent/providers` imported into `packages/engines` —
  keeps scoring pure and reproducible
- `Date.now()` or `new Date()` inside `packages/engines` — the clock is injected, so
  analyses are deterministic
- a Gemini SDK imported outside `packages/ai/src/providers/gemini` — keeps the AI
  provider swappable

A reviewer will not catch these reliably on the hundredth pull request. A lint rule will.

## Requirements

- Node.js 22 or newer (developed on 24)
- pnpm 10
- PostgreSQL 16 or newer, **installed natively** — there is no container runtime in this project

### Installing PostgreSQL on Windows

Download the installer from [postgresql.org](https://www.postgresql.org/download/windows/), or:

```bash
winget install PostgreSQL.PostgreSQL.16
```

Note the password you set for the `postgres` superuser and the port (5432 by default), and put them
into `DATABASE_URL` in your `.env`. Verify it is running:

```bash
psql -U postgres -c "SELECT version();"
```

## Setup

```bash
pnpm install
```

```bash
cp .env.example .env
```

Generate the two signing secrets and paste them into `.env`:

```bash
openssl rand -base64 48
```

Create and migrate the development and test databases (Postgres must already be running):

```bash
pnpm db:create
```

```bash
pnpm db:create:test
```

## API keys

All free. None is required yet; each unlocks a capability as its phase lands,
and the system reports a missing key as an explicit unavailable capability rather than
failing opaquely.

| Variable | Source | Free tier | Needed from |
|---|---|---|---|
| `FRED_API_KEY` | [FRED](https://fredaccount.stlouisfed.org/apikeys) | 120 req/min | Phase 5 |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) | see note below | Phase 9 |
| `TWELVEDATA_API_KEY` | [Twelve Data](https://twelvedata.com/) | 8 req/min, 800/day | Phase 7 |
| `RESEND_API_KEY` | [Resend](https://resend.com/) | 3,000/month, 100/day | Phase 11 |

**Gemini:** the key must come from Google AI Studio. A consumer Gemini subscription
grants no programmatic access and will not work. Note that the Gemini free tier uses
submitted content to improve Google's products; evidence bundles contain only public
market data and no personal information.

**Twelve Data:** whether `XAU/USD` is available on the free plan is unconfirmed —
the vendor's own pages contradict each other. This is verified empirically in Phase 7.
No V1 fundamental factor uses price data, so a market-data outage degrades the
displayed price without affecting the score.

## Development

```bash
pnpm check
```

That runs typecheck, lint and tests. Individually:

```bash
pnpm typecheck
```

```bash
pnpm lint
```

```bash
pnpm test
```

Watch mode while working on a package:

```bash
pnpm test:watch
```

## Testing

Tests are written alongside each component, never deferred. Currently **414 tests**, all passing.

Unit tests cover freshness boundaries, score-scale conversion, bias-band tiling,
provider-result semantics, the error taxonomy's public/private split, UUIDv7 ordering
and monotonicity, environment validation, configuration validation, and log redaction.

**Integration tests run against a real Postgres**, never a mock — the schema
constraints *are* the enforcement of Amendment A2 and Principle P3, so the only way to
know they hold is to ask Postgres to reject bad data. They verify that the database
refuses a FACT without provenance, an INTERPRETATION without lineage, an
AI_ASSESSMENT without its generation, lineage that crosses analyses or fails to
descend a layer, a scored INSUFFICIENT_DATA analysis, an abstaining factor that still
carries weight, an incoherent candle, and two job runs claiming the same slot.

They **skip automatically** when `TEST_DATABASE_URL` is unset, so `pnpm test` works
before Postgres is installed. CI always provides one, so coverage is never quietly
lost. To run them locally:

```bash
pnpm db:create:test
```

Playwright end-to-end tests arrive with Phase 10.

## Documentation

| Document | Contents |
|---|---|
| [AI_Trading_Intelligence_Terminal_PRD.md](AI_Trading_Intelligence_Terminal_PRD.md) | The canonical master specification. Never modified. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Target design for the whole system |
| [ROADMAP.md](ROADMAP.md) | V1–V7, what each covers and defers |
| [PRD_V1.md](PRD_V1.md) | Complete V1 specification |
| [LIMITS.md](LIMITS.md) | Free-tier resource budget — caps, projected usage, and what breaches them |
| [SECURITY.md](SECURITY.md) | Security decisions and their reasoning |

`API.md`, `DATABASE.md` and `DEPLOY.md` arrive with the phases that make them true.

## Security

See [SECURITY.md](SECURITY.md) for the full reasoning — argon2id parameter choice,
account-enumeration resistance, session expiry rules, and why rate-limit state lives
entirely in Postgres.

User administration:

```bash
pnpm user create you@example.com
```

Passwords are always prompted for with echo disabled — never passed as an argument,
where they would land in shell history and the process table.
