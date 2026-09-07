# ARCHITECTURE — AI Trading Intelligence Terminal

> Scope: this document describes the **target system design that satisfies the entire master PRD**
> (`AI_Trading_Intelligence_Terminal_PRD.md`, §1–§63). It is deliberately larger than V1.
> Sections not yet implemented have their **interfaces defined here now** so that later versions
> add implementations without refactoring the core.
>
> The master PRD is immutable and canonical. Two standing amendments apply everywhere:
> - **A1 — Backtesting (master §25)** is deferred beyond V1. When built it must use **walk-forward
>   out-of-sample** evaluation with **confidence intervals**. In-sample win rates must never be
>   reported as results.
> - **A2 — FACT / INTERPRETATION / AI ASSESSMENT (master §58)** is a **hard requirement of the data
>   model and the UI**, not a formatting convention. It is enforced by database constraints and by
>   dedicated UI components.
> - **A3 — No unmeasured predictive claims.** The product must not imply predictive validity that has
>   not been measured. **Scores describe current market conditions, not expected outcomes.** No copy,
>   label, chart annotation, email line or AI-generated sentence may present a score as a forecast of
>   price movement until V6 supplies measured out-of-sample evidence. Enforced the same way as A1 —
>   as a rule the prompts and the UI components obey (§7.3, §9.1), not a footnote.

---

## 1. Design principles

These are the non-negotiable invariants. Every module is judged against them.

| # | Principle | Enforced by |
|---|---|---|
| P1 | **Deterministic first.** Data is collected, validated, normalised and scored by pure code. The AI only interprets the resulting structured evidence (master §6, §23, §60). | Pipeline ordering; the AI layer receives an `EvidenceBundle` and has no provider or database access. |
| P2 | **No fabricated data, ever.** Missing → `UNAVAILABLE`. Old → `STALE`. Never interpolated, never guessed. | `Observation<T>` envelope; the `ProviderResult` union has no "assumed" variant; the AI schema forbids new numeric facts. |
| P3 | **Every stored fact is provenanced.** `source`, `source_timestamp`, `retrieved_at`, `freshness` on every fact row. | Shared Drizzle column helper; columns are `NOT NULL`. |
| P4 | **Three-layer epistemics.** FACT / INTERPRETATION / AI_ASSESSMENT are distinct row types with distinct provenance rules and distinct UI components. | `analysis_statements.layer` enum + CHECK constraints + lineage trigger (§7.3). |
| P5 | **Free providers only, with fallback.** Provider A → Provider B → cache → explicit STALE/UNAVAILABLE. | `ProviderRegistry.resolve()` chain + circuit breaker. |
| P6 | **Model-agnostic AI.** `AIProvider` interface; `GeminiProvider` is one implementation. | No Gemini import outside `packages/ai/providers/gemini`. |
| P7 | **Secrets server-side only.** Never in the browser bundle, never in the extension, never in logs. | Env access confined to `packages/config`; lint rule bans `process.env` elsewhere; the extension uses session cookies against the backend. |
| P8 | **Configuration is data, not code.** Weights, thresholds, cache TTLs, freshness limits live in versioned config records. | `packages/config` + `config_profiles` table. |
| P9 | **Tests ship with the component.** No component is "done" without its tests. | Definition of Done in every version in `ROADMAP.md`. |
| P10 | **Deployable from day one, on free tiers, permanently.** A documented process-based deploy from V1, on infrastructure that costs nothing indefinitely — no trials, no expiring credits. | `DEPLOY.md`; §14. Every provider's free-tier limits are recorded in §14.2 and treated as design constraints, not deployment trivia. |
| P11 | **Never executes trades** (master §48). | No broker client exists anywhere in the dependency graph. |
| P12 | **A score is a description, not a prediction** (Amendment A3). | Prohibited-phrase guard in AI validation; `<ScoreDisplay>` renders a mandatory descriptive caveat; a lint-level copy check on UI strings. |

---

## 2. Technology stack and justification

### 2.1 Chosen stack

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript 5.x**, strict mode, ESM | One language across web, worker, engines and the Chrome extension. Shared domain types between backend and extension eliminate an entire class of contract drift (master §36). Master §49 explicitly allows a strong TypeScript ecosystem. |
| Runtime | **Node.js 22 LTS** | Native fetch, stable test runner, long support window. |
| Monorepo | **pnpm workspaces + Turborepo** | Free, fast, no build-tool lock-in. The package graph is how module boundaries (P6/P7) are actually kept honest. |
| Web app | **Next.js 15 (App Router), React 19, server components** | A single deployable serving both the dashboard (§31–§35) and the JSON API (§56). Server components keep provider keys and raw evidence off the client by construction (P7). |
| Styling | **Plain CSS with custom properties**, in one stylesheet (`apps/web/src/app/globals.css`) | Changed in Phase 10 — see §2.3. Was Tailwind v4 + shadcn/ui. |
| Charts | **lightweight-charts (TradingView, Apache-2.0)** | Purpose-built candlestick renderer with custom overlays for FVG / order blocks / liquidity drawn from the technical engine (§37). Free, no service dependency. Introduced in V2. |
| Database | **PostgreSQL 16** | Relational as mandated (§4). Gives us `jsonb` for raw provider payloads, generated columns, `CHECK` constraints to enforce P3/P4, arrays for lineage, and advisory locks for job leadership. |
| ORM / migrations | **Drizzle ORM + drizzle-kit** | SQL-first and fully typed; migrations are plain reviewable SQL. No hidden query generation in a system where auditability matters. |
| Cache | **Postgres `provider_cache` table (V1) → Redis (optional, V4+)** | Avoids a second stateful service while volumes are small. The `CacheStore` interface is defined now so Redis drops in later (§39). |
| Jobs / scheduling | **Ledger-driven job runner with a pluggable trigger**: due-ness is computed from the `job_runs` table, not from process uptime. Triggers: `IntervalTrigger` (long-lived process) or `HttpTrigger` (external scheduler calls an endpoint). Postgres **transaction-scoped** advisory locks prevent overlap. | Ingestion must not run inside request handlers, and the free-tier survey (§14.2) showed the deployment target may or may not permit a long-lived process. Deriving due-ness from the ledger makes both modes the same code path — and makes a worker that was offline for three hours catch up correctly on restart. |
| Validation | **Zod** | One schema mechanism for env vars, provider responses, HTTP contracts and AI structured output (§44, §52). |
| Auth | **Hand-rolled session auth** (argon2id, opaque tokens, HTTP-only cookies, double-submit CSRF) | Master §3 requires precise control of hashing, sessions, CSRF, rate limiting, lockout and password change. A drop-in framework would abstract exactly the parts we are required to own. Small, auditable surface. |
| Email | **Resend** behind `EmailProvider`, with an SMTP implementation as the fallback | Master §28 names Resend as preferred and explicitly requires that we are not coupled to it. |
| AI | **Google Gemini** (`gemini-3.7-flash`, id held in configuration) behind `AIProvider`, structured output via `responseSchema` | Master §10. The free tier covers a handful of analyses per day. Native schema-constrained output plus our own Zod re-validation (§44). |
| Logging | **pino**, JSON lines, explicit redaction paths | Structured logging (§42) with a hard redaction list so secrets cannot be logged. |
| Testing | **Vitest** (unit + integration), **Playwright** (E2E) | Master §51 wants all three. Integration tests run against a **real, natively installed Postgres** on a dedicated test database, never a mock, because the schema constraints *are* part of the logic. |
| Local Postgres | **Natively installed PostgreSQL 16+** on the developer machine, reached through `DATABASE_URL` | No container runtime required. Nothing in the codebase knows the difference — the connection string is the entire interface. |
| Deployment | **Process-based**, supervised by systemd (Linux) or PM2 / a Windows service; TLS terminated by a reverse proxy or the managed host | See §14. No container runtime is required to run this system. |

### 2.2 Explicitly rejected alternatives

- **Python/FastAPI backend + separate React frontend.** Python is stronger for numerics, but the
  technical engine here (EMA/RSI/ATR, swing detection, FVG, order blocks) is simple array arithmetic
  that does not need pandas. The cost — two languages, two deploy units, duplicated domain types, a
  hand-maintained contract with the Chrome extension — is not repaid. The engines are pure functions
  over OHLCV arrays, so they remain portable if V6 backtesting later becomes numerically heavy.
- **Serverless functions for the worker.** Ingestion needs long-running, stateful, rate-limited work
  with circuit breakers and backoff. A long-lived container is simpler and cheaper.
- **A vector database / RAG over news.** No section requires it. Deterministic classification and
  lexicon scoring are auditable; embeddings are not. If §24 similarity search demands it later, add
  a `pgvector` column, not a new service.
- **Redis in V1.** One fewer stateful service to operate; `CacheStore` makes it a drop-in later.

---

### 2.3 Changed decisions

Decisions recorded here were made during planning and revised once the code existed.
They are amended rather than deleted, because the reasoning that produced the original
choice is usually still worth knowing.

**Styling: Tailwind v4 + shadcn/ui → plain CSS with custom properties (Phase 10).**

The original choice was sound in the abstract: a dark trading-terminal aesthetic
without a component library we cannot modify, with accessible Radix primitives for
free. What changed is that the dashboard turned out to need very little of it.

The V1 surface is four panels and about three hundred lines of CSS. Against that,
Tailwind brings a PostCSS pipeline, a build step and a dependency, and shadcn/ui brings
components we would immediately have to override — the panel deliberately avoids the
default visual grammar of a trading UI, so a library tuned for that grammar is working
against the design rather than for it.

The styling that replaced it is not "no design system": `globals.css` defines the
palette as custom properties and encodes three product decisions that a utility
framework would have made it easy to lose track of:

- **No red/green pair for direction.** That palette is the vocabulary of buy and sell
  and makes a reading look like an instruction. Contributions are distinguished by
  which side of the centre line they sit on, plus two muted hues carrying no market
  convention.
- **Amber appears in exactly one place** — a configuration defect — so its presence is
  unambiguous.
- **Gaps use the same type scale as scores.** A smaller, greyer "unavailable" section
  would tell readers it matters less.

Accessibility primitives are not lost: the expanders are native `<details>`, the score
axis carries `role="img"` with a text alternative, and panels are labelled by their
headings.

**Revisit if** the surface grows past roughly a dozen distinct components, or V4's
multi-asset views introduce interactive primitives — menus, dialogs, comboboxes —
where hand-rolled accessibility becomes the larger risk. Neither is true in V1.

---

## 3. Runtime topology

```text
                                 ┌──────────────────────────────┐
   Browser (dashboard)  ────────▶│  Reverse proxy / managed host│
                                 │  (TLS, HSTS, headers)        │
   Chrome extension (V7) ───────▶└──────────────┬───────────────┘
                                                │
                    ┌───────────────────────────┴───────────────────────────┐
                    │                                                       │
          ┌─────────▼──────────┐                                 ┌──────────▼─────────┐
          │  apps/web          │                                 │  apps/worker       │
          │  Next.js           │                                 │  Node scheduler    │
          │  • UI (RSC)        │                                 │  • ingestion jobs  │
          │  • /api  (§56)     │                                 │  • analysis jobs   │
          │  • auth + sessions │                                 │  • report + email  │
          │  • on-demand runs  │                                 │  • leader election │
          └─────────┬──────────┘                                 └──────────┬─────────┘
                    │                                                       │
                    └───────────────────────┬───────────────────────────────┘
                                            │
                                  ┌─────────▼─────────┐
                                  │   PostgreSQL 16   │
                                  │  facts • analyses │
                                  │  cache • jobs     │
                                  └─────────┬─────────┘
                                            │
              ┌─────────────────────────────┴─────────────────────────────┐
              │            packages/providers  (the egress boundary)      │
              │  MarketData │ News │ EconomicCalendar │ Macro │ AI │ Notify│
              └──┬──────────┬──────────┬──────────┬──────────┬──────────┬─┘
                 │          │          │          │          │          │
            TwelveData   RSS (Fed,  FRED release  FRED     Gemini     Resend
            Yahoo,       ECB, BoE,  dates,        series               SMTP
            Yahoo        BoJ,BEA,   FF weekly feed
                         Census
```

Both `web` and `worker` import the same `packages/*`. **Only `apps/worker` and server-side route
handlers may call providers**; a lint boundary forbids `packages/providers` from being imported by
any client component.

---

## 4. Module boundaries

```text
apps/
  web/        Next.js — UI + HTTP API + auth. No provider calls in client code.
  worker/     Scheduler — owns all recurring ingestion, analysis, report and notification jobs.
  extension/  Chrome MV3 companion (V7). Consumes the same public API with a session cookie.

packages/
  config/     Zod-validated env + tunable runtime config (weights, thresholds, TTLs). No I/O.
  core/       Pure domain: Observation envelope, Freshness, ProviderResult, score types, Layer enum,
              asset/currency/timeframe vocabularies, error taxonomy. Zero dependencies.
  db/         Drizzle schema, migrations, typed repositories, seed data. Depends on core.
  providers/  Provider interfaces + implementations + registry, fallback, rate limiting,
              circuit breaker, cache. Depends on core, config, and db (cache/status tables only).
  engines/    Pure analysis: fundamental, sentiment, technical, regime, confluence,
              confidence, event risk, event study, backtest. Depends on core only.
  ai/         AIProvider interface, GeminiProvider, versioned prompts, output schemas,
              validation + single-retry policy. Depends on core, config.
  notifications/ NotificationProvider interface, EmailProvider (Resend | SMTP), templates.
  contracts/  Zod schemas + inferred types for the public HTTP API. Shared by web, extension, tests.
  testing/    Fixtures, provider fakes, test-database setup and truncation helpers.
              Test-only; never a runtime dependency.
```

### 4.1 Dependency rules (enforced by ESLint `import/no-restricted-paths` plus the package graph)

- `packages/engines` must remain **pure**: no `db`, no `providers`, no `fetch`, no ambient
  `Date.now()` (time is injected). This is what makes scoring unit-testable and reproducible (P1, P9).
- `packages/ai` must not import `packages/providers` or `packages/db`. The AI receives an
  `EvidenceBundle` value and returns a validated object; it cannot reach data (P1).
- `packages/providers` is the **only** place `fetch` to third parties is permitted.
- `packages/config` is the **only** place `process.env` is read (P7).
- Client components may import from `contracts` and `core` only.

---

## 5. The provider abstraction layer

This is the load-bearing abstraction of the whole system (master §9, §38, §39, §40, §41).

### 5.1 Core value types (`packages/core`)

```ts
export type FreshnessStatus = 'LIVE' | 'RECENT' | 'STALE' | 'UNAVAILABLE';

export type SourceTier = 1 | 2 | 3 | 4;   // master §45

export interface Provenance {
  providerId: string;        // 'fred' | 'twelvedata' | 'ecb-rss' | ...
  sourceName: string;        // 'Federal Reserve Economic Data'
  sourceUrl: string | null;  // deep link to the exact series/document
  sourceTier: SourceTier;
  sourceTimestamp: Date;     // when the SOURCE says the fact was true / was published
  retrievedAt: Date;         // when WE fetched it
}

/** Every fact entering the system is wrapped in this envelope. Principle P3. */
export interface Observation<T> {
  value: T;
  provenance: Provenance;
  freshness: FreshnessStatus;   // computed against per-domain thresholds from config
  qualityFlags: QualityFlag[];  // IMPOSSIBLE_VALUE | DUPLICATE | ANOMALY | REVISED | ... (§52)
}

/** Providers never throw for "no data". They return an explicit outcome. Principle P2. */
export type ProviderResult<T> =
  | { status: 'OK';          observation: Observation<T> }
  | { status: 'STALE';       observation: Observation<T>; reason: StaleReason }
  | { status: 'UNAVAILABLE'; reason: UnavailableReason; attempted: AttemptLog[] };
```

`UNAVAILABLE` is a first-class, storable, renderable state. There is deliberately no code path that
converts it into a number.

### 5.2 The provider contract

```ts
export interface Provider {
  readonly id: string;
  readonly displayName: string;
  readonly tier: SourceTier;
  readonly capabilities: ReadonlySet<Capability>;
  readonly limits: RateLimitPolicy;      // requests per minute / per day, burst
  health(): Promise<ProviderHealth>;
}

export interface MarketDataProvider extends Provider {
  getQuote(symbol: AssetSymbol): Promise<ProviderResult<Quote>>;
  getCandles(req: CandleRequest): Promise<ProviderResult<Candle[]>>;      // used from V2
}

export interface NewsProvider extends Provider {
  fetchSince(cursor: NewsCursor): Promise<ProviderResult<RawArticle[]>>;
}

export interface EconomicCalendarProvider extends Provider {
  getEvents(range: DateRange): Promise<ProviderResult<RawEconomicEvent[]>>;
  getReleases(range: DateRange): Promise<ProviderResult<RawEconomicRelease[]>>;
}

export interface MacroDataProvider extends Provider {
  getSeries(seriesId: MacroSeriesId, range: DateRange): Promise<ProviderResult<MacroPoint[]>>;
  getLatest(seriesId: MacroSeriesId): Promise<ProviderResult<MacroPoint>>;
}

export interface AIProvider extends Provider {
  generateStructured<T>(req: StructuredRequest<T>): Promise<AIResult<T>>;
}

export interface NotificationProvider extends Provider {
  readonly channel: 'EMAIL' | 'WHATSAPP' | 'TELEGRAM' | 'DISCORD';
  send(message: OutboundMessage): Promise<ProviderResult<DeliveryReceipt>>;
}
```

Each domain gets a **registry** holding an ordered chain:

```ts
const result = await registry.marketData.resolve(p => p.getQuote('XAUUSD'), {
  cacheKey: 'quote:XAUUSD',
  ttl: cfg.cache.quote,                       // §39 — short for prices, long for macro
  acceptStaleUpTo: cfg.freshness.quote.stale,
});
```

`resolve()` executes, in order:

1. **Cache hit within TTL** → return `OK`.
2. For each provider in the chain, if its **circuit breaker** is closed and its **token bucket**
   allows: call it with a timeout, retrying transient failures with exponential backoff and jitter,
   capped (master §40 — *never continuously retry an unavailable API*).
3. First success → validate with the provider's Zod schema → normalise → write cache → `OK`.
4. All providers exhausted → **stale cache** within `acceptStaleUpTo` → `STALE` with a reason.
5. Otherwise → `UNAVAILABLE` with the full `AttemptLog[]`.

Every attempt updates `provider_status` (consecutive failures, last success, breaker state, quota
consumed). That table drives a System Status page and is an input to the confidence engine.

### 5.3 Selected free providers (master §9)

| Domain | Chain | Notes |
|---|---|---|
| MarketData | Twelve Data (free key, `XAU/USD`) → Yahoo Finance `GC=F` (COMEX futures **proxy**, Tier 3) → Nasdaq Data Link `LBMA/GOLD` (daily London fixing, Tier 2) | See the verification note below. `XAUUSD=X` does not exist on Yahoo; only the futures contract resolves, and it is stored and labelled as a futures proxy, never as spot. Stooq was removed — its CSV endpoints now serve a JavaScript proof-of-work bot challenge. |
| Macro | FRED (free key: `DGS10`, `DFII10`, `DGS2`, `DFF`, `DTWEXBGS`, `CPIAUCSL`, `CPILFESL`, `PAYEMS`, `UNRATE`, `ICSA`, `VIXCLS`, `BAMLH0A0HYM2`) → ECB Data Portal | Tier 1, official, with a true `source_timestamp` (release date) and revision vintages. |
| EconomicCalendar | FRED release-dates API (Tier 1 — authoritative *when*, with actuals via the series) → ForexFactory weekly public feed (Tier 3 — supplies consensus forecast and importance) | No free source provides Tier-1 forecasts. The two sources stay **separately provenanced**: dates and actuals are Tier 1; the consensus forecast is Tier 3 and is labelled as such in the UI. |
| News | Official RSS over HTTPS: Federal Reserve ×4, ECB, BoE, BoJ, BEA, Census (Tier 1) → reputable publisher RSS over HTTPS (Tier 2/3 breadth) | RSS is free, stable and legal to consume. Tiering feeds directly into credibility weighting (§45). **Every feed must be HTTPS** — GDELT was rejected for being HTTP-only, and a test enforces the scheme. |
| AI | Gemini `gemini-3.7-flash` → `gemini-3.5-flash` as a degraded fallback; **both ids are configuration** | Schema-constrained output plus our Zod validation. Auth is a `GEMINI_API_KEY` from Google AI Studio on its own free tier — a consumer Gemini subscription grants no programmatic access and is never used at runtime. |
| Notification | Resend → SMTP | §28. |

**Verified free-tier limits (checked 2026-08-29; re-check before each version).**

| Provider | Limit | Status |
|---|---|---|
| FRED | 120 req/min with key, 30 without; no documented daily cap | Verified reachable; key required as expected |
| Resend | 3,000/month, 100/day, one verified domain | Verified from vendor docs |
| Gemini | Free tier confirmed for Flash and Flash-Lite; Pro removed from the free tier in April 2026. Google no longer publishes a fixed limit table — the live per-project quota is shown in AI Studio | Model availability verified; exact RPD must be read from AI Studio |
| ForexFactory weekly feed | No documented limit | Verified live |
| Official RSS (Fed, ECB, BoE, BoJ, BLS, Treasury) | No documented limit | Fed feed verified live |
| Twelve Data | 8 req/min, 800 credits/day | ⚠️ **`XAU/USD` availability on the free plan is unconfirmed** — the pricing table omits commodities while the symbol page implies free-plan access. Must be verified empirically with a real key before it is relied upon |
| ~~GDELT 2.0~~ | — | ❌ **Rejected** — HTTPS broken from two TLS stacks, plaintext HTTP only. No HTTP-transport source enters the news chain. |

Two consequences are load-bearing. First, **no V1 fundamental factor consumes price data** — F1–F8
are FRED series plus news — so a total market-data outage degrades the displayed price to
`UNAVAILABLE` while the score still computes. Second, the free Gemini tier uses submitted content to
improve Google's products; evidence bundles contain only public market data and no personal
information, and this is documented in `SECURITY.md`.

**RSS politeness.** All feed polling uses conditional GET (`ETag` / `If-Modified-Since`) so an
unchanged feed costs a 304 rather than a full body.

Providers requiring a paid tier for production use are not in any chain. If a capability is only
available paid, the system reports `UNAVAILABLE` for that capability rather than degrading silently
(master §61).

---

## 6. Data flow (master §60)

The pipeline below is the literal call order in `apps/worker`. It must never be reversed.

```text
 (1) RAW DATA           providers/*  →  ProviderResult<Raw*> + AttemptLog
                            │             raw payload archived to provider_responses.jsonb
                            ▼
 (2) VALIDATION         Zod schema; type, range and timestamp checks; impossible-value and
                        duplicate detection (§52). Failures raise quality flags, never silent drops.
                            ▼
 (3) NORMALISATION      units, timezone → UTC, symbol and currency mapping, dedupe
                        (news: URL canonicalisation + title shingling); Observation<T> built;
                        freshness computed → persisted as FACT rows with full provenance.
                            ▼
 (4) DETERMINISTIC      engines/fundamental → FundamentalFactor[]   (pure)
     ANALYSIS           engines/sentiment   → ArticleSentiment[]    (lexicon, reproducible)
                        engines/technical   → TechnicalFeature[]    (V2, pure)
                        engines/regime      → MarketRegime          (V2)
                        engines/eventRisk   → EventRisk             (§47)
                            ▼
 (5) SCORES             fundamentalScore (−100..+100), technicalScore (V2), newsScore.
                        Each factor carries direction, weight, confidence, sources, explanation.
                            ▼
 (6) CONFLUENCE         engines/confluence (V3) + conflict detection (§18)
                        engines/confidence → HIGH/MEDIUM/LOW from completeness, source tier,
                        agreement, freshness and event risk (§21)
                            ▼
 (7) EVIDENCE BUNDLE    a serialisable, provenance-complete snapshot. This — and only this —
                        is what the AI sees.
                            ▼
 (8) GEMINI REASONING   ai/prompts/<name>_v<n> + responseSchema
                            ▼
 (9) VALIDATED OUTPUT   Zod parse → semantic guards: every numeric the AI emits must equal a
                        value present in the bundle; every cited source must be a bundle source.
                        Invalid → one corrective retry → else persist the failure and render the
                        deterministic analysis with "AI ASSESSMENT UNAVAILABLE" (§44).
                            ▼
(10) USER INTERFACE     three-layer rendering (§58) with provenance popovers (§22)
                            ▼
(11) HISTORICAL STORAGE immutable `analyses` snapshot; reports reopen exactly as generated (§35)
                            ▼
(12) NOTIFICATIONS      daily briefing plus threshold and bias-change alerts (§26, §29)
```

**Step 9 is the anti-hallucination gate (§23).** The AI's output schema is written so it can only
*select and reference* facts (by stable `factId`) and produce prose. It cannot introduce a price, a
level, a release value or a source URL that is not already in the bundle; attempts fail validation.

---

## 7. Database schema approach

PostgreSQL, Drizzle migrations, UTC everywhere (`timestamptz`), UUIDv7 primary keys (time-sortable),
`snake_case`. Prices and money as `numeric(20,8)`, never float. Raw provider payloads are archived so
any derived value can be recomputed and audited.

### 7.1 Cross-cutting column contract (P3)

Every table holding a fact from the outside world includes, `NOT NULL`:

```sql
source_provider   text        not null,
source_name       text        not null,
source_url        text,
source_tier       smallint    not null check (source_tier between 1 and 4),
source_timestamp  timestamptz not null,
retrieved_at      timestamptz not null,
freshness         freshness_status not null,     -- LIVE | RECENT | STALE | UNAVAILABLE
quality_flags     text[]      not null default '{}',
created_at        timestamptz not null default now(),
updated_at        timestamptz not null default now()
```

Applied through a shared Drizzle helper `sourcedColumns()` so it cannot be forgotten.


### 7.1a CHECK constraints: NULL is not FALSE

**A CHECK constraint rejects a row only when its expression evaluates to `FALSE`. An
expression that evaluates to `NULL` passes.**

This is the trap that cost us a real guard. `macro_series_publication_days_valid` was
written as `array_length(expected_publication_days, 1) >= 1` to reject an empty
publication calendar. `array_length('{}', 1)` returns **NULL**, not 0 — so the
predicate was NULL, and Postgres accepted the empty array it was written to forbid. An
empty calendar freezes a series' age at zero, so it would have read `LIVE` for ever at
full confidence weight, no matter how long the data had been missing. Fixed in
migration `0003`.

A guard that silently permits what it forbids is worse than no guard: it reads as
protection and stops anyone looking again.

**The rule.** Any CHECK expression must be `FALSE` — not `NULL` — for every input it
means to reject. Two safe shapes cover almost everything:

- **Explicit null guard.** `x IS NULL OR <predicate on x>`, or
  `<discriminator> <> 'VALUE' OR <requirement>`. `IS NULL` and `IS NOT NULL` never
  return NULL themselves, so these are sound whatever `x` holds. Every guard-form
  constraint in this schema was audited and is of this shape.
- **Bare comparison on a `NOT NULL` column.** Sound because the operand cannot be
  NULL — *provided the operator is a comparison and not a function call*.

**Where it goes wrong is functions.** Nullability analysis says "the column is
`NOT NULL`, therefore the expression is safe", and for `array_length` that reasoning is
simply wrong: it returns NULL for a perfectly valid, non-NULL, empty array. Before
putting any function inside a CHECK, establish what it returns for empty, zero-length
and boundary input, and whether that makes the predicate NULL rather than FALSE.

| | empty array | NULL array |
|---|---|---|
| `array_length(x, 1)` | **NULL** — the trap | NULL |
| `cardinality(x)` | `0` — safe | NULL |

Prefer `cardinality`. Use `array_length` only with an explicit
`IS NOT NULL` guard around the result.

**Audit, 2026-08-30, re-run continuously.** Every CHECK constraint is reviewed — the
count is deliberately not written here, because a number in prose is a second source of
truth that drifts the moment a migration adds a constraint (it has already gone from 27
to 33). `checkConstraints.integration.test.ts` enumerates them from `pg_constraint` at
run time, so the audit covers whatever exists rather than whatever was counted once.
Three contain a function
call, all `cardinality`, on `derived_from` and `expected_publication_days`. Both are
`NOT NULL` — as is every array column in the schema — so `cardinality` cannot return
NULL and all three are sound. No other constraint contains a function call.

This is enforced going forward, not just recorded:
`checkConstraints.integration.test.ts` fails when a CHECK introduces a function that
has not been reviewed, and fails if any array column is ever made nullable — which
would reopen the trap without touching a single constraint. It asserts the offending
predicates evaluate to `FALSE` rather than merely "not true"; `NOT TRUE` is satisfied
by NULL, so a loose assertion would reproduce the original bug.

**Testing a shadowed constraint.** Two of the three sit behind the lineage trigger
(§7.3), which fires first and rejects the row itself. A row-level test would therefore
pass whether the CHECK were sound or not. Assert the predicate directly in SQL when a
trigger shadows a constraint — otherwise the test is measuring the trigger.
### 7.2 Table groups

**Identity and access** — `users`, `sessions` (hashed opaque token, `expires_at`, `ip`,
`user_agent`), `login_attempts` (rate limiting and lockout), `password_resets`, `audit_events`.

**Reference and configuration** — `assets` (XAUUSD, EURUSD, …, with `base_currency`,
`quote_currency`, `asset_class`), `currencies`, `macro_series` (FRED id → semantic role),
`config_profiles` (versioned JSON of weights and thresholds; every analysis records the
`config_profile_id` it used, so old reports stay reproducible), `news_sources` (feed URL → tier).

**Raw data and provider plumbing** — `provider_responses` (jsonb archive, hash-deduplicated, with a
retention policy), `provider_cache` (`key`, `payload`, `stored_at`, `expires_at`), `provider_status`
(breaker state, quota, last success/failure), `job_runs` (job, `scheduled_for`, started, finished,
status, error, items processed; idempotency key `(job, scheduled_for)`).

**Facts** — `market_candles` (`asset_id`, `timeframe`, `open_time`, OHLCV, unique on
`(asset_id, timeframe, open_time, source_provider)`), `market_quotes`, `macro_observations`
(`series_id`, `observation_date`, `value`, `vintage` for revisions), `economic_events` (canonical
event definition plus dedupe key), `economic_releases` (one occurrence: `scheduled_at`, `previous`,
`forecast`, `actual`, generated `surprise` and `surprise_z`), `news_articles` (canonical URL, content
hash, title, summary, `published_at`, `source_tier`), `news_article_assets`, `news_sentiment`
(deterministic lexicon score plus method version).

**Analysis** — `analyses` (one row per generated analysis: asset, mode, `run_at`,
`config_profile_id`, scores, biases, confidence, status, `evidence_bundle` jsonb snapshot);
`fundamental_factors` / `technical_features` / `confluence_components` (per-analysis child rows with
direction, raw signal, normalised score, weight, confidence, explanation and `fact_refs[]`);
`analysis_statements` (see §7.3); `ai_generations` (prompt name and version, model, token counts,
latency, validation outcome, retry count, raw response).

**History and reports** — `event_reactions` (§24: pre/post prices at +5m, +15m, +1h, +4h, +1d),
`reports` (immutable daily briefing snapshot), `report_assets`, `backtests` / `backtest_folds` /
`backtest_trades` (V6; folds carry train/test windows, out-of-sample metrics and confidence
intervals — Amendment A1).

**Notifications** — `alert_rules`, `notifications` (channel, template, status, provider message id,
error), `notification_deliveries`.

**Operations** — `system_logs` (structured, redacted), `data_quality_incidents`.

### 7.3 Enforcing FACT / INTERPRETATION / AI_ASSESSMENT (Amendment A2)

Not a convention — a constrained table.

```sql
create type statement_layer as enum ('FACT','INTERPRETATION','AI_ASSESSMENT');

create table analysis_statements (
  id                uuid primary key,
  analysis_id       uuid not null references analyses(id) on delete cascade,
  layer             statement_layer not null,
  ordinal           integer not null,
  body              text not null,

  -- FACT lineage: a fact statement must point at a stored fact row and carry provenance.
  fact_table        text,          -- 'macro_observations' | 'economic_releases' | ...
  fact_id           uuid,
  source_provider   text,
  source_name       text,
  source_url        text,
  source_tier       smallint,
  source_timestamp  timestamptz,
  retrieved_at      timestamptz,
  freshness         freshness_status,

  -- INTERPRETATION / AI_ASSESSMENT lineage: must derive from statements below them.
  derived_from      uuid[] not null default '{}',

  ai_generation_id  uuid references ai_generations(id),

  constraint fact_requires_provenance check (
    layer <> 'FACT' or (
      fact_table is not null and fact_id is not null and
      source_provider is not null and source_name is not null and
      source_tier is not null and source_timestamp is not null and
      retrieved_at is not null and freshness is not null
    )
  ),
  constraint fact_has_no_derivation check (
    layer <> 'FACT' or cardinality(derived_from) = 0
  ),
  constraint derived_requires_parents check (
    layer = 'FACT' or cardinality(derived_from) >= 1
  ),
  constraint ai_requires_generation check (
    layer <> 'AI_ASSESSMENT' or ai_generation_id is not null
  ),
  constraint non_ai_has_no_generation check (
    layer = 'AI_ASSESSMENT' or ai_generation_id is null
  )
);
```

A trigger additionally verifies that every uuid in `derived_from` belongs to the **same analysis**
and to a **strictly lower layer** (FACT < INTERPRETATION < AI_ASSESSMENT), so the lineage graph is
acyclic and layered by construction.

**UI counterpart.** `<FactBlock>`, `<InterpretationBlock>` and `<AiAssessmentBlock>` are three
distinct components with distinct colour, border, icon and label. There is no generic text renderer
for analysis prose. `<FactBlock>` refuses to render without provenance props and always shows the
freshness chip. An AI assessment can never be displayed unlabelled.

**UI counterpart for Amendment A3.** Every score reaches the screen through `<ScoreDisplay>`, which
renders a mandatory, non-dismissable descriptive caveat — *"Describes current conditions. Not a
forecast of price movement."* — adjacent to the number. The component takes no prop that can suppress
it. Because no score can be rendered any other way, the caveat cannot be forgotten on a new page. A
unit test asserts the caveat is present in the component's output, and a repository-wide copy check
fails the build on forecast vocabulary ("will rise", "target", "expected move", "probability of") in
UI strings and email templates. Until V6 produces measured out-of-sample evidence, the product makes
no claim about what a score implies for future price.

### 7.4 Freshness

`freshness` is computed at write time and **recomputed at read time** (a row written LIVE an hour ago
is not LIVE now). Thresholds per domain live in `config_profiles`:

| Domain | LIVE | RECENT | STALE beyond |
|---|---|---|---|
| Spot quote | < 10 min | < 30 min | > 2 h |
| Intraday candles | < 5 min | < 30 min | > 2 h |
| Daily macro series | < 24 h | < 72 h | > 7 d |
| Monthly macro series | < 7 d | < 40 d | > 60 d |
| Economic calendar | < 6 h | < 24 h | > 48 h |
| News | < 30 min | < 4 h | > 24 h |

`UNAVAILABLE` is set when no acceptable value exists at all. The chip is shown everywhere the value
appears (§38).

---

## 8. Analysis engines (pure, injected clock)

```ts
// Engines are pure: (inputs, config, now) => result. No I/O. Fully unit-testable.
fundamentalScore(input: FundamentalInput, cfg: FundamentalConfig, now: Date): FundamentalResult
technicalAnalyse(candles: MultiTimeframeCandles, cfg: TechnicalConfig): TechnicalResult        // V2
detectRegime(input: RegimeInput, cfg: RegimeConfig): MarketRegime                              // V2
confluence(f: FundamentalResult, t: TechnicalResult, n: NewsResult, r: MarketRegime,
           cfg: ConfluenceConfig): ConfluenceResult                                            // V3
assessConfidence(input: ConfidenceInput, cfg: ConfidenceConfig): ConfidenceResult
eventRisk(releases: EconomicRelease[], now: Date, cfg: EventRiskConfig): EventRisk
studyReactions(input: ReactionInput, cfg: EventStudyConfig): ReactionStats                     // V5
walkForward(input: BacktestInput, cfg: BacktestConfig): BacktestResult                         // V6, A1
```

**Score scales.** Master §12 uses −100…+100 for the fundamental score; §17/§19/§31 display 0…100.
The canonical internal scale is **signed −100…+100** (direction is intrinsic); the display scale is
`display = round((signed + 100) / 2)`. Both are stored so reports are unambiguous, and the transform
lives in exactly one place in `packages/core`.

**Confidence is not the score** (§21). It is computed from data completeness (share of factor weight
backed by LIVE/RECENT data), source-tier quality, inter-factor agreement (weighted directional
dispersion), fundamental↔technical agreement (V3), supporting versus conflicting factor counts,
freshness penalties, provider degradation, and event-risk proximity.

---

## 9. AI layer

- **Versioned prompts as files**: `packages/ai/prompts/fundamental_analysis_v1.ts`,
  `technical_analysis_v1`, `confluence_analysis_v1`, `daily_report_v1` (§43). Each exports its system
  prompt, its Zod output schema, and the JSON schema handed to Gemini's `responseSchema`. The prompt
  name and version are stored on every `ai_generations` row, so old outputs stay explainable.
- **Input is an `EvidenceBundle`** — a serialised, provenance-complete structure in which every fact
  carries a stable `factId`. The prompt instructs: interpret only; cite `factId`s; if a value is
  absent say `DATA UNAVAILABLE`; if stale say `STALE DATA — LAST UPDATED: …`.
- **Output validation (§44)**: Zod parse → semantic guards (numbers must match bundle values within
  tolerance; `sources[]` must be a subset of bundle sources; from V2, `key_levels` must match engine
  output exactly, since the AI may not draw structures — §37) → one corrective retry with the
  validation errors appended → on a second failure, persist the failure and surface the deterministic
  analysis with an explicit "AI ASSESSMENT UNAVAILABLE" banner. Malformed analyses are never stored.
- **Model selection is configuration, not a constant.** The model id lives in config with a declared
  default and a degraded fallback. Google's lineup moves faster than this document: a model id pinned
  in source is a defect waiting to happen.
- **Degradation is a feature.** The system remains useful with the AI switched off: scores, factors,
  calendar, news and provenance are all deterministic.

### 9.1 Amendment A3 enforcement in the AI layer

A3 is a validation rule, not prompt etiquette. Three mechanisms, each independently tested:

1. **Prompt constraint.** Every prompt states that the score describes present conditions, that the
   model must not forecast price direction, magnitude, probability or timing, and that no claim of
   historical accuracy or win rate may be made (A1).
2. **Prohibited-claim guard.** A versioned matcher runs over every free-text field the model returns,
   rejecting forecast constructions ("will rise", "expect a move to", "targets", "should reach",
   "likely to break", probability and percentage-chance phrasings) and any performance claim. A hit
   fails validation and takes the standard single-retry path; a second hit yields
   "AI ASSESSMENT UNAVAILABLE" rather than softened prose.
3. **Vocabulary separation.** The schema names fields `assessment` and `interpretations` — never
   `prediction`, `forecast`, `target` or `outlook`. There is no field the model could fill with a
   forecast even if it wanted to.

The matcher's rule list is data, versioned alongside prompts, and recorded on each `ai_generations`
row so a rejection is explainable after the fact.

---

## 10. API surface (master §56, refined)

All routes under `/api`, cookie-authenticated, Zod-validated in and out via `packages/contracts`.
Mutating routes require the CSRF header.

```text
POST   /api/auth/login            POST /api/auth/logout        GET /api/auth/me
POST   /api/auth/password

GET    /api/assets
GET    /api/market-data/:asset            ?timeframe=&limit=            (candles from V2)
GET    /api/news                          ?asset=&currency=&importance=&sentiment=&from=&to=
GET    /api/economic-calendar             ?range=today|tomorrow|week&currency=&impact=
GET    /api/macro/:seriesId                                              (facts + provenance)

GET    /api/analysis/:asset               latest stored analysis
POST   /api/analysis/:asset               run on demand { mode }         (V1: FUNDAMENTAL only)
GET    /api/analyses                      ?asset=&from=&to=&bias=&confidence=

GET    /api/reports                       GET /api/reports/:id
GET    /api/historical/:asset                                            (V5)
GET    /api/backtests/:id                                                (V6)

GET    /api/alerts                        POST /api/alerts
GET    /api/system/status                 provider health, freshness, recent job runs
GET    /api/extension/summary/:asset                                     (V7, compact payload)
```

Responses embed provenance and freshness alongside values. No endpoint returns a bare number without
its source.

**Built in V1** (Phase 10): `POST /api/auth/login`, `POST /api/auth/logout`,
`GET|POST /api/analysis/:asset`, `GET /api/system/status`. Mutating routes enforce
double-submit CSRF plus `Origin` and `Sec-Fetch-Site` checks (§11), proven by
`apps/web/e2e/csrf.spec.ts`.

**Deferred to V7, deliberately** (`/api/news`, `/api/economic-calendar`,
`/api/macro/:seriesId`, `/api/assets`, `/api/analyses`, `/api/reports`):

The dashboard reads these through server components, which keeps raw evidence and
provider keys off the client by construction. A JSON route is only *needed* when
something outside the app consumes it, and the only such consumer in the roadmap is the
Chrome extension in V7.

Building them now would mean freezing a response shape against no real consumer.
`/api/extension/summary/:asset` already exists in this list as a compact payload
precisely because the extension's needs differ from the dashboard's — which is the
evidence that guessing the others' shapes in advance would produce the wrong ones. The
contracts in `packages/contracts` are the stable part and already exist; the routes are
a thin projection of them, and the projection is what should wait for its consumer.

This is a deferral with a trigger, not an omission: **V7 builds them, and V7 decides
their shape.**

---

## 11. Security architecture (master §3, §53)

- **Passwords**: argon2id (m=19456, t=2, p=1), per-user salt, rehash on login when parameters change.
- **Sessions**: 256-bit random token, only its SHA-256 stored; cookie `HttpOnly; Secure; SameSite=Lax;
  Path=/`; sliding expiry with an absolute cap; rotation on privilege change; server-side revocation.
- **CSRF**: double-submit token in a non-HttpOnly cookie plus an `X-CSRF-Token` header, required on
  all unsafe methods; `Origin` / `Sec-Fetch-Site` checks.
- **Brute force**: per-IP and per-account token buckets in `login_attempts`, exponential lockout,
  constant-time comparison, uniform error messages and timing.
- **Headers** (reverse proxy plus Next middleware): HSTS, a strict nonce-based CSP with no inline scripts,
  `X-Content-Type-Options`, `Referrer-Policy: same-origin`, `Permissions-Policy`,
  `frame-ancestors 'none'`.
- **Injection**: parameterised Drizzle queries only; no raw string SQL outside reviewed migrations.
- **Secrets**: `packages/config` parses `process.env` once through Zod at boot and fails fast on a
  missing or invalid value. `.env.example` documents every variable; `.gitignore` plus a secret scan
  in CI. No `NEXT_PUBLIC_*` variable is ever a credential.
- **Logging**: pino redaction paths for `authorization`, `cookie`, `password`, `*apiKey*`, `token`.
- **Extension (V7)**: holds no keys; authenticates with the same cookie session against a narrow,
  read-only endpoint with CORS pinned to the extension id.

---

## 12. Folder structure

```text
forex-agent/
├─ AI_Trading_Intelligence_Terminal_PRD.md   # canonical, never modified
├─ ARCHITECTURE.md  ROADMAP.md  PRD_V1.md
├─ README.md  API.md  DATABASE.md  SECURITY.md  DEPLOY.md  CHANGELOG.md
├─ .env.example
├─ package.json  pnpm-workspace.yaml  turbo.json  tsconfig.base.json
├─ scripts/
│  ├─ db-create.mjs                 # create + migrate dev and test databases
│  └─ deploy/                       # systemd units, PM2 ecosystem config, proxy snippets
├─ .github/workflows/ci.yml         # typecheck, lint, unit, integration, e2e, secret scan, build
├─ apps/
│  ├─ web/
│  │  ├─ app/(auth)/login/…
│  │  ├─ app/(app)/dashboard/…  app/(app)/xauusd/…  app/(app)/news/…
│  │  │   app/(app)/calendar/…  app/(app)/reports/…  app/(app)/system/…
│  │  ├─ app/api/…                  # route handlers mirroring §10
│  │  ├─ components/{layers,charts,tables,ui}/   # FactBlock / InterpretationBlock / AiAssessmentBlock
│  │  ├─ lib/{auth,session,csrf,rateLimit,server}/
│  │  └─ tests/e2e/                 # Playwright
│  ├─ worker/
│  │  ├─ src/jobs/{ingestMacro,ingestCalendar,ingestNews,ingestMarket,
│  │  │            runAnalysis,generateDailyReport,sendNotifications}.ts
│  │  ├─ src/runner.ts              # runDue(now): ledger-driven, trigger-agnostic
│  │  ├─ src/triggers/{interval.ts,http.ts}
│  │  ├─ src/index.ts
│  │  └─ tests/
│  └─ extension/                    # V7
└─ packages/
   ├─ core/{observation,freshness,result,scores,vocab,errors}/
   ├─ config/{env.ts,runtime.ts,defaults/}
   ├─ db/{schema/,migrations/,repositories/,seed/}
   ├─ providers/{registry.ts,fallback.ts,rateLimit.ts,circuitBreaker.ts,cache.ts,
   │             marketData/,news/,economicCalendar/,macro/}
   ├─ engines/{fundamental/,sentiment/,technical/,regime/,confluence/,confidence/,
   │           eventRisk/,eventStudy/,backtest/}
   ├─ ai/{provider.ts,providers/gemini/,prompts/,schemas/,validate.ts}
   ├─ notifications/{provider.ts,providers/{resend,smtp}/,templates/}
   ├─ contracts/
   └─ testing/
```

---

## 13. How future sections slot in without refactoring

| Master section | Lands in | Already prepared by |
|---|---|---|
| §13, §16 Technical engine and score | `packages/engines/technical` | `MarketDataProvider.getCandles`, `market_candles` table, `technical_features` child table, `analyses.technical_score` column, `TechnicalResult` type. |
| §14 Multi-timeframe | technical engine input type | `MultiTimeframeCandles` and the `timeframe` vocabulary exist in `core` from V1. |
| §15 Session analysis | `engines/technical/sessions` | All timestamps stored in UTC; session windows are configuration, not code; DST handled via IANA zones. |
| §17, §18 Confluence and conflict | `packages/engines/confluence` | `confluence_components` table and `overall_*` columns exist from V1 (nullable until V3). |
| §24 Historical reactions | `engines/eventStudy` + `event_reactions` | Candles and releases already stored with exact timestamps; reactions are a derived job. |
| §25 Backtesting (Amendment A1) | `engines/backtest` | `backtest_folds` mandates train/test windows and out-of-sample metrics with confidence intervals; no API exists for reporting in-sample results. |
| §27 On-demand modes | `POST /api/analysis/:asset` | The endpoint exists in V1 with a `mode` enum; V1 accepts `FUNDAMENTAL`, later versions widen it. |
| §30 WhatsApp | `notifications/providers/whatsapp` | `NotificationProvider` plus the `channel` discriminator and channel-agnostic `notifications` table. |
| §36 Chrome extension | `apps/extension` | `packages/contracts` gives typed API access; a compact endpoint and CORS pinning are specified. |
| §37 Charting overlays | `components/charts` | Overlays consume `TechnicalResult` only — the AI cannot draw. |
| New assets (§5) | `assets` seed rows | Asset-specific factor definitions are registered in a `FactorRegistry` keyed by asset class, not hard-coded to gold. |
| New AI vendor (§10) | `ai/providers/<vendor>` | `AIProvider` plus the prompt/schema separation. |

---

## 14. Deployment

**Constraint: the entire stack must run on free tiers, permanently.** No paid service at any point,
no trial credits, nothing that expires. This is a design constraint from Phase 2 onward, not a
deployment detail — it dictates the job layer (§14.4), the database driver (§14.5) and the retention
policy (§14.6).

There is no container runtime anywhere in this system. Local development uses a natively installed
Postgres; deployment runs Node processes under a supervisor.

### 14.1 Local development

- **Postgres installed natively** (16 or newer). Two databases: the development database and a
  dedicated `forex_agent_test` used only by integration tests.
- `pnpm db:create` and `pnpm db:create:test` create and migrate them; both read `DATABASE_URL` /
  `TEST_DATABASE_URL` and do nothing else. The codebase never learns how Postgres was installed.
- Integration tests still run against **real Postgres** — only the provisioning changed. Each test
  file truncates the tables it touches in a transaction-wrapped fixture, so runs are isolated
  without recreating the database.

### 14.2 Free-tier survey (conducted 2026-08-30)

Every figure below was checked against the vendor's own documentation on that date. Free tiers move;
this table is re-verified at the start of each version.

**Application hosting**

| Option | Free allowance | Disqualifying or limiting facts |
|---|---|---|
| Vercel Hobby | Functions to **300 s** and 2 GB memory — generous; global CDN | **Cron limited to once per day, ±59 min** (Pro is per-minute). **Non-commercial use only** per its terms, and Hobby projects may be terminated without notice. |
| Cloudflare Workers | 100k req/day, 5 cron triggers, 1-minute granularity | **10 ms CPU per invocation** on free, 50 subrequests. Fine as a *trigger*; far too little to render Next.js or run an ingestion job. |
| Render free | 750 instance-hours/month | Spins down after **15 min idle**, ~1 min cold start. |
| Oracle Cloud Always Free | **2 OCPU / 12 GB ARM, 200 GB block storage, 10 TB egress**, always on | Reduced from 4 OCPU/24 GB in June 2026. Capacity at signup is genuinely unreliable; idle-reclaim policy applies; self-managed. |

**Scheduling**

| Option | Free allowance | Limiting facts |
|---|---|---|
| Oracle VM + systemd | Unlimited | None. |
| Cloudflare Worker cron | 5 triggers, 1-minute granularity | 10 ms CPU — usable only to *fire* an HTTP request, not to do work. |
| GitHub Actions | **2,000 min/month** (private repo); unlimited on a public repo | **5-minute minimum interval**; each run is **billed rounded up to one minute**, so the budget is ~2,000 invocations/month ≈ one job every 22 minutes. Public-repo schedules are silently disabled after 60 days of inactivity. |
| Vercel Hobby cron | 100 jobs | Once per day — sufficient only for the daily report. |

**Postgres**

| Option | Free allowance | Limiting facts |
|---|---|---|
| Neon | **0.5 GB storage**, 100 CU-hours/month, 5 GB egress, permanent | **Scale-to-zero after 5 min idle, not disableable.** See the compute-hour arithmetic in §14.4. |
| Supabase | 500 MB, 5 GB egress, 60 direct / 200 pooled connections | **Projects pause after one week of inactivity**; 2 active projects. |
| Render Postgres | — | **Expires 30 days after creation**, then deleted. Disqualified: not permanently free. |
| Self-hosted on the Oracle VM | 200 GB | Self-managed backups. |

### 14.3 Chosen target

**Primary — Neon + Vercel Hobby + an external cron trigger (GitHub Actions).**

This is the *most constrained* viable target, and it is primary for exactly that reason: a system
designed to the tightest limits runs anywhere, while one designed for an unconstrained VM has to be
retrofitted the first time it moves. It also removes a dependency on Oracle's free-capacity
availability at signup, which is not guaranteed and not under our control.

The binding constraints it imposes — all of which are now design inputs rather than deployment
trivia:

| Constraint | Value | Consequence |
|---|---|---|
| Database storage | 0.5 GB | Bounded retention on `provider_responses` (14 days), truncated article bodies, `LIMITS.md` tracking |
| Database compute | 100 CU-hours/month, suspends after 5 idle min | **15-minute consolidated ingestion tick** (see §14.4) |
| Connection pooling | PgBouncer transaction mode | **Transaction-scoped advisory locks only**; Neon WebSocket driver |
| Scheduling | No long-lived process | Ledger-driven `runDue()` behind an HTTP trigger |
| Function duration | 300 s (Hobby) | Each tick must complete within it; work is chunked per job |
| Vercel Hobby terms | Non-commercial only | Suits this private tool; would need revisiting if that changed |

**Documented alternative profile — a single always-on VM** (Oracle Cloud Always Free, or any other
host) running Postgres, the app and the worker under systemd. This is a **straight upgrade, not a
different build**: identical code and schema, with the `IntervalTrigger` in place of the HTTP one and
looser cadences and retention from configuration. `DEPLOY.md` documents both profiles; nothing in the
codebase branches on which is in use beyond two config values.

### 14.4 The job layer works in both modes

The original design — a long-lived process with `node-cron` holding schedule state in memory — only
works on the primary target. Rather than maintain two job systems, **due-ness is computed from the
`job_runs` ledger** instead of from process uptime:

```ts
interface JobDefinition {
  name: string;
  intervalMs: number;        // or a cron expression evaluated against the ledger
  handler: (ctx: JobContext) => Promise<JobOutcome>;
  timeoutMs: number;
}

// The single entry point, identical in both deployment modes.
runDue(now: Date): Promise<JobRunSummary>   // reads job_runs, executes what is due
```

Two triggers, one code path:

- **`IntervalTrigger`** — a long-lived process ticks every 60 s and calls `runDue()`. Used locally
  and on the Oracle VM.
- **`HttpTrigger`** — `POST /api/jobs/tick`, authenticated by `JOB_TRIGGER_SECRET`, calls `runDue()`.
  Invoked by whatever free scheduler the host offers: a Cloudflare Worker cron, a GitHub Actions
  schedule, or the host's own cron.

This is strictly better than the original, independent of hosting: correctness no longer depends on
the process having been up. A worker offline for three hours catches up on its next tick, because
what is due is a fact in the database rather than a timer in memory.

**Concurrency.** Each job body runs inside a **transaction-scoped** advisory lock
(`pg_advisory_xact_lock`), not a session-scoped one. Session locks do not survive PgBouncer in
transaction pooling mode, which is exactly how Neon and Supabase pool connections — a session lock
there would be silently ineffective, which is worse than no lock. The `(job_name, scheduled_for)`
unique key on `job_runs` remains the idempotency guarantee.

**Cadence consequence (a real constraint, not a preference).** Neon's free tier grants 100 CU-hours
per month; its minimum compute is 0.25 CU, giving ~400 compute-hours, against 730 hours in a month.
Compute suspends after 5 idle minutes and wakes on connection. Therefore:

| Job cadence | Database awake | CU-hours/month | Verdict on Neon free |
|---|---|---|---|
| Every 5 min | ~100% | ~182 | **Exceeds the cap around day 16** |
| Every 15 min | ~35% | ~67 | Fits |
| Every 30 min | ~20% | ~36 | Comfortable |

A 5-minute cadence is therefore **incompatible with the primary target**. Ingestion is consolidated
into a **single 15-minute tick** that performs all work then due — the default everywhere. The VM
profile may tighten it from configuration. This consolidation independently solves the GitHub Actions
minute budget, where every invocation is billed as a whole minute: one tick every 15 minutes is 2,880
invocations a month, which is why the repository is public (unlimited Actions minutes) rather than
private (2,000/month).

### 14.5 Database connection strategy

One schema, one Drizzle instance, two drivers selected by configuration:

- **Primary** (Vercel + Neon): the Neon serverless driver over **WebSockets**, not HTTP. The HTTP
  driver cannot do interactive transactions, and we require them — the three-layer lineage writes
  (§7.3) and each analysis snapshot must commit atomically or not at all.
- **Long-lived** (local development, VM profile): `node-postgres` `Pool`, `max: 10`.

Drizzle's query builder and the schema are identical across both; only `createDb()` differs.

### 14.6 Storage and retention (0.5 GB is the binding constraint)

The fallback target caps storage at 0.5 GB, which makes retention a schema concern rather than an
operational afterthought:

- **`provider_responses` (raw payload archive) is the dominant consumer** and is subject to a
  retention window — **14 days by default**, configurable, pruned by a scheduled job. The VM profile
  may extend it freely.
- News is roughly 150 MB/year at ~200 articles/day including indexes; acceptable, but article bodies
  are stored truncated with the canonical URL retained for the full text.
- V1 stores daily candles only, which is negligible. **V2's intraday candles across six timeframes
  are the next storage pressure point** and must be sized against the cap before that work starts.
- A `storage_usage` check is part of the system status panel, so the cap is visible before it is hit.
- Every figure above is tracked in **`LIMITS.md`**, which is updated whenever a version adds a data
  source. A version is not done until its entry there is current.

### 14.7 Runbook

`DEPLOY.md` carries: first deploy on each target, native Postgres installation, migration, rollback,
backup and restore (`pg_dump` on a timer, with a rehearsed restore), key rotation, supervisor
configuration (systemd unit files or PM2 ecosystem config), TLS setup, and the post-deploy check
against `/api/system/status`.

**CI**: typecheck → lint → unit → integration (real Postgres via the GitHub Actions `postgres`
service container) → build → E2E → secret scan.
