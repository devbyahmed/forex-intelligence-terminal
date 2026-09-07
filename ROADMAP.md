# ROADMAP — AI Trading Intelligence Terminal

The master PRD (`AI_Trading_Intelligence_Terminal_PRD.md`, §1–§63) is delivered across **seven
versions**. Each version is **independently useful, testable and deployable**: at the end of every
version the system can be launched on a real host, logged into, and used to answer a real question —
it is never a half-wired scaffold waiting for the next release.

Master §50 lists fourteen build phases. Those phases are *within-version* ordering, not releases; the
mapping is given per version below.

## Standing amendments (apply to every version)

- **A1 — Backtesting.** Master §25 is deferred past V1 and lands in **V6**. It must use walk-forward
  out-of-sample evaluation with confidence intervals. In-sample win rates are never reported as
  results, and no API or UI surface exists that could present them as such.
- **A2 — FACT / INTERPRETATION / AI ASSESSMENT.** Master §58 is a hard requirement of the data model
  and the UI from **V1**, enforced by database constraints and by three distinct UI components.
- **A3 — No unmeasured predictive claims.** From **V1**, the product must not imply predictive
  validity that has not been measured. **Scores describe current market conditions, not expected
  outcomes.** The UI states this explicitly at every score, and no copy, label, email line or
  AI-generated sentence may present a score as a forecast of price movement. Enforced structurally,
  as A1 is: a prohibited-claim guard in AI output validation, a `<ScoreDisplay>` component carrying a
  caveat that cannot be suppressed, and a build-failing copy check on forecast vocabulary. The
  restriction lifts only for claims V6 can support with measured out-of-sample evidence, and even
  then only with the confidence interval and sample size attached.

## Constraints that hold in every version

**Free-tier budget.** The stack must run on permanently free infrastructure. Storage and compute are
hard architectural limits, tracked in [LIMITS.md](LIMITS.md). **Every version that adds a data
source, job or provider must update that file as part of its definition of done** — a version is not
complete until its entry there is current.

**Provider re-verification.** Free tiers, endpoints and model availability change without notice, and
Phase 4/5 found three dead endpoints and an unusable default model that documentation still listed as
current. **Every version begins by empirically re-checking the providers it depends on** — observed
behaviour, not documented behaviour. A provider that worked last version is evidence, not a guarantee.


Deterministic collection and scoring before AI interpretation; every stored fact carries `source`,
`source_timestamp`, `retrieved_at` and a freshness status; free providers only with fallback and
explicit `STALE`/`UNAVAILABLE`; secrets in environment variables and never in the frontend; tests
written alongside each component; a documented, permanently-free deploy path. The system never executes
trades (§48).

---

## Version map at a glance

| Version | Theme | Master sections newly covered |
|---|---|---|
| **V1** | Foundation + Fundamental Intelligence (XAUUSD) | 1, 2ᵖ, 3, 4, 5ᵖ, 6ᵖ, 7, 8, 9, 10, 11ᵖ, 12, 19ᵖ, 20ᵖ, 21ᵖ, 22, 23, 26ᵖ, 28, 29ᵖ, 31ᵖ, 33ᵖ, 34ᵖ, 35ᵖ, 38, 39, 40, 41, 42, 43, 44, 45, 47, 48, 49, 50ᵖ, 51ᵖ, 52, 53, 54, 55, 56ᵖ, 57, 58, 60, 61 |
| **V2** | Technical Intelligence | 13, 14, 15, 16, 32, 37, 46 |
| **V3** | Confluence and Decision Layer | 17, 18, 19ᶠ, 20ᶠ, 21ᶠ, 27, 29ᶠ |
| **V4** | Multi-Asset Terminal | 5ᶠ, 6ᶠ, 26ᶠ, 31ᶠ, 33ᶠ, 34ᶠ, 35ᶠ, 59 |
| **V5** | Historical Intelligence | 24 |
| **V6** | Walk-forward Backtesting | 25 (as amended by A1) |
| **V7** | Companion, Channels and Hardening | 30, 36, 51ᶠ, 62, 63 |

ᵖ = partially covered (scope stated in that version) ᶠ = completed in this version

---

## V1 — Foundation and Fundamental Intelligence (XAUUSD)

**One-line value:** log in and see, every morning, what the fundamentals say about gold, why they say
it, and exactly which official source each number came from — delivered to your inbox.

**Master sections covered.** §1, §2 (web app only), §3 authentication, §4 database, §5 (XAUUSD only),
§6 (macro + gold-specific factors; forex-relative strength deferred), §7 economic calendar, §8 news,
§9 provider abstractions and fallback, §10 AI engine abstraction, §11 (the fundamental subset of the
input list), §12 fundamental scoring, §19 (fundamental portion of the output), §20 (fundamental bias
only; no entry generation), §21 confidence (without technical agreement inputs), §22 source flow,
§23 anti-hallucination, §26 (daily report, XAUUSD), §28 notification abstraction, §29 (daily briefing
and data-failure alerts), §31 (dashboard, single asset), §33 and §34 (news and economic calendar as
filterable panels on the single dashboard page; dedicated pages arrive with the multi-asset terminal
in V4), §35 (a minimal report archive so the daily email links to a permanent copy; filters in V4), §38
freshness, §39 caching, §40 rate limits, §41 error handling, §42 logging, §43 prompt architecture,
§44 AI response schema, §45 source credibility, §47 event risk, §48 no automated trading, §49
technology, §50 phases 1, 3, 4, 5, 8, 9, 11, 12, §51 (unit + integration + one E2E path), §52 data
validation, §53 security, §54 environment variables, §55 documentation, §56 (the V1 subset of the
API), §57 configuration, §58 three-layer output, §60 core data flow, §61 build discipline.

**Master §50 phase order used inside V1:** 1 (setup, DB, auth, config, provider abstractions) → 3
(economic calendar) → 4 (news) → 2ᵖ (spot price only, no candles) → 5 (fundamental engine) → 8
(Gemini) → 9 (dashboard) → 11 (daily report) → 12 (email).

**Definition of done.**

1. From a clean clone against a natively installed Postgres, `pnpm db:create` and the documented
   setup steps bring the system up; `.env.example` lists every variable and the app fails fast on a
   missing one.
2. The system is deployed to a real host on a **permanently free** tier, reachable over HTTPS, with
   Node processes under a supervisor, and `DEPLOY.md` documents first deploy, migration, rollback and
   backup/restore. This has actually been done once.
3. Login, logout, password change, session expiry, rate limiting and lockout all work and are tested.
4. Economic calendar, news and macro pipelines run on schedule, are idempotent, survive a provider
   outage, and record every attempt in `provider_status` and `job_runs`.
5. Killing the primary provider for each domain produces a visible `STALE` or `UNAVAILABLE` state in
   the UI — never a fabricated or interpolated number. This is proved by an integration test.
6. The deterministic fundamental engine produces a signed −100…+100 score for XAUUSD from at least
   eight weighted factors, each with direction, weight, confidence, explanation and fact references.
   Its unit tests are golden-fixture based and pass with no network access.
7. Gemini returns schema-valid structured output; invalid output triggers exactly one corrective
   retry; a second failure stores the failure and the UI shows the deterministic analysis with an
   explicit "AI ASSESSMENT UNAVAILABLE" banner. All three paths are tested.
8. Every displayed fact shows source, source timestamp, retrieval time and a freshness chip; every
   analysis renders as three visually distinct FACT / INTERPRETATION / AI ASSESSMENT bands, and the
   database rejects a statement that violates the lineage rules.
9. The daily report generates on schedule, is stored immutably, is retrievable at a stable URL, and
   is emailed successfully through `EmailProvider`.
10. CI is green: typecheck, lint, unit, integration against a real Postgres, one Playwright E2E path
    (login → dashboard → open analysis → view report), and a secret scan.
11. `README.md`, `ARCHITECTURE.md`, `API.md`, `DATABASE.md`, `SECURITY.md` and `DEPLOY.md` are written
    and accurate.
12. Amendment A3 holds: every score renders with its descriptive caveat, the prohibited-claim guard
    rejects forecast and performance language from the model, and the copy check passes — all three
    proved by test.
13. `LIMITS.md` reflects V1's actual data sources, with projected usage against every free-tier cap
    and the V2 candle-storage question flagged as open.

**Deliberately deferred from V1.** Technical analysis engine and all SMC/ICT detection (§13);
multi-timeframe (§14); sessions (§15); technical score (§16); confluence and conflict detection
(§17, §18); charting (§37); market regime (§46); on-demand analysis modes beyond a single fundamental
run (§27); all assets other than XAUUSD (§5); forex relative-strength factors (§6); historical
reaction study (§24); backtesting (§25, per A1); Chrome extension (§36); WhatsApp and other channels
(§30); dedicated news and calendar pages with the full filter sets and historical-report browsing
filters (§33, §34, §35); the multi-asset overview table (§31, §59).

---

## V2 — Technical Intelligence

**One-line value:** the same terminal now also shows what gold's price structure is doing, on a
chart, with every level drawn by the deterministic engine rather than by an AI.

**Master sections covered.** §13 (market structure, liquidity, ICT/SMC, indicators), §14
multi-timeframe, §15 session analysis, §16 technical score, §32 asset detail page, §37 charting, §46
market regime. Completes master §50 phases 2 (full OHLCV pipeline) and 6.

**Scope.** Full candle ingestion across 1m/5m/15m/1h/4h/1D with gap detection and backfill; swing
detection, HH/HL/LH/LL, BOS, MSS, CHOCH; equal highs/lows, previous day/week levels, session
high/low, liquidity sweeps; fair value gaps, order blocks, breaker blocks where objectively
detectable, premium/discount, displacement; EMA 20/50/100/200, RSI, ATR; deterministic technical
score with configurable weights; timezone-aware Asian/London/New York sessions with DST handling;
market-regime classification feeding confidence.

**Blocking prerequisite.** `LIMITS.md` §7.1 — six timeframes of intraday candles do not fit in the
0.5 GB storage cap at V4's eight assets. A retention decision (rolling windows per timeframe, fewer
timeframes, or the VM profile) must be made **before** this version starts, not discovered when the
database fills.

**Definition of done.** Every detector is a pure function with hand-verified golden fixtures covering
at least one real historical window per pattern, plus explicit negative cases; the technical score is
reproducible and configuration-driven; the XAUUSD detail page renders candles with EMA, FVG, order
block, liquidity and session overlays sourced *only* from `TechnicalResult`; multi-timeframe bias
(daily → 4h → 1h → 15m → 5m) is displayed and stored; session times are correct across a DST
transition, proved by test; regime is stored per analysis and visibly influences confidence; the AI
prompt gains `technical_analysis_v1` with the same validation and retry contract, and the semantic
guard now rejects any level the AI emits that the engine did not produce.

**Deliberately deferred.** Combining fundamental and technical into one number (that is V3); trade
entries; any asset other than XAUUSD; historical reaction statistics.

---

## V3 — Confluence and Decision Layer

**One-line value:** one honest overall bias — including an explicit MIXED verdict when fundamentals
and technicals disagree — plus an ANALYZE NOW button and real-time alerts.

**Master sections covered.** §17 confluence engine, §18 conflict detection, §19 final output in full,
§20 buy/sell bias output in full, §21 confidence completed with fundamental↔technical agreement, §27
on-demand analysis with all five modes, §29 the full alert catalogue. Completes master §50 phase 7.

**Scope.** Weighted confluence of fundamental, technical, news and regime with configurable
thresholds and classification bands; conflict detection that refuses to collapse disagreement into a
direction and instead reports MIXED with a lowered confidence and an explanation; key levels,
invalidation conditions and key events assembled into the §19 output; `POST /api/analysis/:asset`
accepting QUICK / FULL / FUNDAMENTAL_ONLY / TECHNICAL_ONLY / FULL_CONFLUENCE, each refreshing the
data it needs first; alert rules for bias change, strong setup, high-impact event proximity,
technical confirmation and data failure, with deduplication and quiet hours.

**Definition of done.** A crafted fundamental-bullish / technical-bearish fixture produces MIXED with
a documented confidence penalty and never a BUY; confluence weights and thresholds are changeable
through configuration without a code change and old analyses still render with the profile they were
generated under; on-demand analysis completes within a stated budget and is rate limited per user;
each alert type has an integration test proving it fires once and only once; the §19 output block
renders completely, with invalidation conditions traced back to engine facts.

**Deliberately deferred.** Additional assets; historical reaction context inside the output; entry
and exit management of any kind.

---

## V4 — Multi-Asset Terminal

**One-line value:** the market-overview screen from §31 and §59 — seven forex pairs alongside gold,
each with its own fundamental, technical, news and overall scores.

**Master sections covered.** §5 in full (EURUSD, GBPUSD, USDJPY, USDCHF, AUDUSD, NZDUSD, USDCAD), §6
forex-specific relative currency strength, §26 daily report across all assets, §31 the full dashboard
overview table, §33 and §34 as dedicated news and calendar pages with their full filter sets, §35
historical reports with filters, §59 the final opening experience.

**Scope.** A per-currency fundamental strength model (rates, inflation, growth, employment, policy
stance) sourced from FRED plus the ECB Data Portal and other free official statistics providers, with
pair scores derived from base-versus-quote strength; parallel ingestion and analysis with per-provider
quota budgeting across eight assets; the overview table; the report archive with asset, date, bias,
score and confidence filters where clicking a report reopens the complete analysis exactly as it was.

**Definition of done.** All eight assets analyse on schedule inside the free-tier quota, with a
documented budget per provider; a currency whose data is unavailable degrades that pair to a partial
score with a visible reason rather than a wrong number; the daily report and email cover all assets;
opening the app shows today's outlook for every asset within a stated page-load budget; historical
report reopening is byte-stable against its stored snapshot, proved by test.

**Deliberately deferred.** Historical reaction statistics; backtesting; the extension.

---

## V5 — Historical Intelligence

**One-line value:** answers to "what usually happens to gold after a hot CPI print" — computed from
stored data, never asserted by the model.

**Master sections covered.** §24 historical analysis; completes master §50 phase 10 and the
historical-reaction portion of §11 and §32.

**Scope.** Historical backfill of candles and releases as far as free providers allow, with coverage
explicitly recorded; an event-study engine computing pre-event price and +5m/+15m/+1h/+4h/+1d
reactions per release; grouping by event type, surprise direction and surprise magnitude; summary
statistics with sample sizes; a historical panel on the asset page and a `GET /api/historical/:asset`
endpoint; the evidence bundle gains a historical-context section so the AI can reference measured
reactions.

**Definition of done.** Every statistic is displayed with its sample size and its data window, and
any group below a configured minimum sample is shown as insufficient rather than as a result; the
reaction engine is unit-tested against fixtures with known outcomes; coverage gaps in historical data
are visible, not silently averaged over; the AI is forbidden by the semantic guard from citing any
historical statistic not present in the bundle.

**Deliberately deferred.** Strategy-level performance claims of any kind — that is V6, under A1.

---

## V6 — Walk-forward Backtesting (Amendment A1)

**One-line value:** an honest, out-of-sample answer to "would this confluence rule have been worth
anything", with confidence intervals and no in-sample flattery.

**Master sections covered.** §25 backtesting, as amended by A1.

**Scope.** A strategy definition as a declarative rule over stored analysis features (for example
fundamental > 70 and technical > 70 with a bullish MSS and a liquidity sweep); a walk-forward
harness with rolling train and out-of-sample test windows, purging and an embargo period around
window boundaries to prevent leakage; per-fold and aggregate out-of-sample metrics — occurrences, win
rate, average move, maximum adverse and favourable excursion, average R multiple, drawdown, time to
target — each reported with a bootstrap confidence interval; explicit reporting of the number of
folds, the total out-of-sample sample size and the strategy variants evaluated, so multiple-comparison
risk is visible.

**Definition of done.** No API response, database view, report, email or UI surface can present an
in-sample metric as a result; in-sample values exist only inside a fold's training record, are
labelled `TRAINING_DIAGNOSTIC`, and a test asserts they are absent from every public payload. Every
reported metric carries a confidence interval and a sample size. A leakage test — a strategy given a
deliberately look-ahead feature — is detected and rejected by the harness. Results state their data
window and free-provider coverage limits. Where sample size is too small for a stable estimate, the
system says so instead of reporting a number.

**Relationship to Amendment A3.** V6 is the only version permitted to relax A3, and only narrowly. A
predictive statement becomes sayable exactly when a walk-forward out-of-sample result supports it, and
it must carry its confidence interval, sample size and data window. The `<ScoreDisplay>` caveat and
the prohibited-claim guard stay in force everywhere a measured result is not being cited; the guard
gains an allowlist keyed to a specific `backtest_id`, so a forecast-like sentence is permitted only
when it points at the evidence behind it. A live score with no backtest behind it remains descriptive,
permanently.

**Deliberately deferred.** Any automated action based on a backtest; position sizing; broker
connectivity — permanently out of scope per §48.

---

## V7 — Companion, Channels and Hardening

**One-line value:** the terminal in the browser toolbar, notifications on the channel you actually
read, and the master §62 checklist closed.

**Master sections covered.** §30 WhatsApp readiness, §36 Chrome extension, §51 the complete testing
matrix, §62 definition of done, §63 the final goal statement.

**Scope.** A Manifest V3 Chrome extension with cookie-session authentication, current-asset detection
where the active tab makes it possible, a compact summary panel (bias, overall, fundamental,
technical, confidence, key reasons) and a link into the dashboard, holding no keys and calling only a
narrow read-only endpoint with CORS pinned to the extension id; a `WhatsAppProvider` against an
official business API, plus Telegram, behind the existing `NotificationProvider` with per-channel
templates and opt-in — no unofficial automation; a full security pass (dependency audit, header
review, penetration checklist from §53) and the complete §51 test matrix including the full E2E
journey.

**Definition of done.** Every line of master §62 is demonstrably true; the extension ships with an
unpacked-load and a store-packaging path documented; a static check proves no secret is present in
the extension bundle; a channel outage degrades to email without losing the notification record.

---

## Sequencing rationale

Fundamentals come before technicals because they are the harder half of the pipeline — providers,
provenance, freshness, scoring, AI validation and the three-layer model all get built and proved
against slow-moving, officially sourced data where errors are visible and verifiable. Technicals then
plug into a system whose contracts are already exercised. Confluence cannot precede either input.
Multi-asset comes after the single-asset path is correct, because breadth multiplies any modelling
error by eight. History precedes backtesting because a backtest over data whose coverage is not yet
measured produces confident nonsense — exactly what A1 exists to prevent. The extension is last
because it is a thin client over an API that must first be stable.
