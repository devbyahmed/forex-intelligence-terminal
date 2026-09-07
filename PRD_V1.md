# PRD — V1: Fundamental Intelligence Terminal (XAUUSD)

**Status:** proposed, awaiting approval
**Derived from:** `AI_Trading_Intelligence_Terminal_PRD.md` (canonical master, not modified)
**Companion documents:** `ARCHITECTURE.md` (target design), `ROADMAP.md` (V1…V7)

This document is **self-contained**: it is the complete specification for V1 and can be implemented
without reading the master PRD. Master section numbers are cited only for traceability.

---

## 1. V1 in one paragraph

A private, password-protected web terminal that every day collects real economic, market and news
data about **gold (XAUUSD)** from free official sources, scores it with a deterministic fundamental
engine, has Gemini interpret that structured evidence under a strict schema, presents the result on a
single dashboard page where every number shows its source and freshness, and emails a daily briefing.
It answers *what is happening to gold fundamentally, why, and how confident should I be* — with a
visible, auditable chain from each conclusion back to an official data release.

It is **not** a trading bot. It never places, modifies or manages an order, and never connects to a
broker (master §48).

---

## 2. Goals

| # | Goal | Success looks like |
|---|---|---|
| G1 | Replace manual data gathering | The user opens one page instead of checking FRED, a calendar site and five news sites. |
| G2 | Deterministic, reproducible scoring | Re-running the engine on the same stored facts yields a byte-identical score and factor breakdown. |
| G3 | Zero fabricated data | Every displayed number traces to a stored fact with a source; missing data is shown as `UNAVAILABLE`, stale data as `STALE`. |
| G4 | Honest AI | Gemini interprets; it cannot introduce a number or a source. Schema violations are rejected, not stored. |
| G5 | Visible epistemics | Every conclusion is labelled FACT, INTERPRETATION or AI ASSESSMENT, enforced by the database. |
| G6 | Actually deployed | Reachable over HTTPS on a real domain, not just `localhost`. |
| G7 | Extensible | V2's technical engine, V3's confluence and V4's forex pairs slot into existing interfaces without refactoring. |

## 3. Non-goals for V1 (explicitly deferred)

Technical analysis engine and SMC/ICT detection (master §13); multi-timeframe analysis (§14); session
analysis (§15); technical score (§16); confluence engine (§17); conflict detection between
fundamental and technical (§18); charting (§37); market regime (§46); historical reaction study
(§24); backtesting (§25 — deferred per Amendment A1 below); Chrome extension (§36); WhatsApp and
other channels (§30); all assets other than XAUUSD (§5); forex relative-strength factors (§6); the
multi-asset overview table (§31, §59); on-demand analysis modes beyond a single fundamental run
(§27); SaaS, billing or multi-tenant features (§2).

Nothing in this list is stubbed with fake behaviour. Where a deferred capability has a database
column or an interface method, it exists and is nullable or unimplemented-by-declaration — never
filled with a placeholder value.

## 4. Standing amendments to the master PRD

- **A1 — Backtesting.** Master §25 is deferred beyond V1. When built (V6) it must use walk-forward
  out-of-sample evaluation with confidence intervals; in-sample win rates must never be reported as
  results. **V1 therefore ships no performance claim of any kind** — no win rate, no historical
  accuracy, no "this setup worked N% of the time". The UI and the AI prompts forbid it.
- **A2 — FACT / INTERPRETATION / AI ASSESSMENT.** Master §58 is a hard requirement of the V1 data
  model and UI, enforced by database constraints and three distinct UI components (see §9.6, §13.3).
- **A3 — No unmeasured predictive claims.** The product must not imply predictive validity that has
  not been measured. **A score describes current market conditions; it is not an expected outcome.**
  No copy, label, email line or AI-generated sentence may present a score as a forecast of price
  movement — direction, magnitude, probability or timing — until V6 supplies measured out-of-sample
  evidence. Enforced structurally, exactly as A1 is: a prohibited-claim guard in AI output validation
  (§8.8), a `<ScoreDisplay>` component whose caveat cannot be suppressed (§8.9), and a build-failing
  copy check over UI strings and email templates (§13.1). This is a correctness requirement, not a
  disclaimer: the system genuinely does not know what price will do, and must not sound as though it
  does.

## 5. Users and access

A single private account at launch; the schema, auth and authorisation paths are multi-user from day
one so trusted friends can be added by inserting a user row (master §2, §3). No public sign-up, no
password reset by email in V1 (an admin CLI command resets a password); password **change** while
logged in is required.

---

## 6. Scope: components in V1

1. Project foundation — monorepo, CI, configuration, logging, error taxonomy.
2. Database and migrations.
3. Authentication and session security.
4. Provider abstraction layer (MarketData, News, EconomicCalendar, Macro, AI, Notification).
5. Economic calendar pipeline.
6. News pipeline with deterministic sentiment.
7. Macro and spot-price pipelines.
8. Deterministic fundamental engine, fundamental scoring, confidence, event risk.
9. Gemini integration with schema-validated structured output.
10. Single dashboard page.
11. Daily email report.
12. Documentation and deployment.

---

## 7. Data providers for V1 (free only, master §9)

Every domain has an ordered chain. Failure of the whole chain yields `UNAVAILABLE` — never a guess.

| Domain | Chain (in order) | Auth | Tier | Notes |
|---|---|---|---|---|
| **Macro** | 1. FRED API 2. ECB Data Portal | FRED: free API key. ECB: none | 1 | The backbone of V1. Provides yields, dollar index, inflation, employment, volatility and credit spreads with real release timestamps and revision vintages. |
| **EconomicCalendar** | 1. FRED `releases/dates` + series actuals 2. ForexFactory weekly public calendar feed | FRED: free key | 1 / 3 | FRED is authoritative for the release **date** and the **actual** value — but **verified 2026-08-30, it publishes no time of day**. The scheduled time, the consensus forecast and the importance rating all come from the ForexFactory feed at **Tier 3**, separately provenanced from the Tier 1 actual. If the Tier 3 feed is unavailable, time, forecast and surprise are `UNAVAILABLE` and the calendar still works from FRED dates alone. |
| **News** | 1. Official RSS ×9, all verified reachable: Federal Reserve (press, monetary, speeches, testimony), ECB, Bank of England, Bank of Japan, BEA, Census 2. Reputable publisher RSS **over HTTPS** | none | 1 / 2 / 3 | Tier drives credibility weighting. No social media. **BLS (403) and US Treasury (404) were removed after failing empirically**; BEA and Census restore US coverage. BLS *data* still arrives via FRED. **GDELT is rejected**: its HTTPS endpoint is broken and only plaintext HTTP works, and needing volume is not a reason to weaken provenance. A test asserts every seeded feed uses HTTPS. |
| **MarketData** | 1. Twelve Data `XAU/USD` — **verified genuine SPOT on the Basic plan** 2. Yahoo Finance `GC=F` — **COMEX futures proxy, labelled as such, never as spot** | Twelve Data: free key | 2 / 3 | V1 needs spot price and daily closes only. **Nasdaq Data Link was removed** — it returns a 403 bot challenge, not JSON. 1 credit per symbol per call, 800/day, 8/min. The `getCandles` interface exists and is implemented; intraday ingestion begins in V2, where the credit budget becomes binding (LIMITS.md §6.4). |
| **AI** | Gemini `gemini-3.5-flash`, falling back to `gemini-3.6-flash`; **both ids are configuration, not constants** | free API key from Google AI Studio | — | Structured output via `responseSchema`, **verified working as specified 2026-08-30**. Defaults changed after `gemini-3.7-flash` returned 503 on 4/4 attempts and `gemini-2.5-flash` 404d despite being listed (§8.8). |
| **Notification** | 1. Resend 2. SMTP | Resend: free API key, or SMTP credentials | — | `EmailProvider` behind `NotificationProvider`. |

**Quota discipline.** Each provider declares its documented free-tier limits in code; the registry's
token bucket enforces them locally so a limit is never hit by accident, and remaining quota is
displayed on the system status panel. Cadences in §11.5 are sized to stay inside the smallest chain
member's free allowance.

### 7.1 Free-tier verification (performed 2026-08-29, before implementation)

| Provider | Documented limit | V1 consumption | Verdict |
|---|---|---|---|
| FRED | 120 req/min with key (30 without); no daily cap | ~350–400 req/day, peak burst ~12/min | ✅ Large headroom |
| Resend | 3,000/month, **100/day**, one verified domain | 2–5/day | ✅ Large headroom |
| Gemini | Free tier confirmed for Flash and Flash-Lite; Pro removed from the free tier April 2026. Google no longer publishes a fixed table — live quota is per project in AI Studio | ~30–40 req/day, ~80 worst case with retries; no bursts | ✅ Fits conservative assumptions |
| ForexFactory weekly feed | None documented | 6 polls/day | ✅ Verified live |
| Official RSS | None documented | 96 conditional polls/feed/day | ✅ Verified live (Fed) |
| Twelve Data | 8 req/min, 800 credits/day | 288 credits/day at 5-min polling | ⚠️ Fits, but **symbol access unconfirmed** |
| ~~GDELT 2.0~~ | — | — | ❌ **Rejected** — HTTPS broken, HTTP-only. No plaintext transport in the news chain. |

**Findings that changed the design.**

1. **Stooq removed.** Its CSV endpoints now serve a JavaScript proof-of-work bot challenge. Defeating
   it would be circumventing bot detection, so it is out of the chain entirely.
2. **Yahoo has no gold spot symbol.** `XAUUSD=X` returns "symbol may be delisted"; only `GC=F` —
   COMEX gold futures — resolves. Futures are not spot. It is therefore stored and labelled as a
   **futures proxy** with its own provenance and a Tier 3 rating. Displaying it as "XAUUSD spot"
   would be precisely the quiet misrepresentation A2 exists to prevent.
3. **Twelve Data `XAU/USD` free-plan access is unconfirmed.** The vendor's pricing table lists the
   free plan as covering US equities, forex and crypto with commodities absent, while the `XAU/USD`
   symbol page states access begins at the Basic plan — which *is* the free plan. The two statements
   conflict. **Phase 7 must verify this empirically with a real key and record the result**; the
   chain must not depend on an assumption here.
4. **GDELT is rejected, not merely unavailable.** Its HTTPS endpoint fails from two independent
   TLS stacks while plaintext HTTP works. Using it would mean ingesting news over a channel an
   attacker could alter. Volume is not a sufficient reason to weaken provenance, so it is out —
   and a test asserts every seeded feed URL uses HTTPS, which keeps it out structurally.
5. **Gemini model ids are configuration.** `gemini-2.5-flash`, named in the original plan, is now two
   generations old — that plan aged in three months. Pinning a model id in source is a defect waiting
   to happen, so the default and fallback ids live in config.

**Why this is tolerable for V1.** No V1 fundamental factor consumes price data — F1–F8 are FRED
series plus news (§8.5.2). A complete market-data outage therefore degrades the displayed price to
`UNAVAILABLE` while the fundamental score continues to compute normally. Market data is not on V1's
critical path, which is what makes the unresolved Twelve Data question safe to carry into Phase 7
rather than a blocker now.

**Privacy note.** The Gemini free tier uses submitted content to improve Google's products. Evidence
bundles contain only public market data and no personal information, so this is acceptable; it is
recorded in `SECURITY.md` so the trade-off is explicit rather than assumed.

**RSS politeness.** All feed polling uses conditional GET (`ETag` / `If-Modified-Since`), so an
unchanged feed costs a 304 rather than a full body.

**Known V2 constraint, flagged now.** 800 credits/day will not cover six-timeframe candle ingestion.
V2 needs either a different market-data provider or a materially coarser intraday strategy. Not a V1
blocker, but it must not be discovered mid-V2.

**If a provider degrades or dies.** The chain moves to the next provider, then to cache within the
stale window, then to `UNAVAILABLE`. Each transition is logged, written to `provider_status`, shown
in the UI, and — if a whole domain is unavailable for longer than a configured window — triggers a
data-failure email alert (master §29).

---

## 8. Functional requirements

### 8.1 Authentication (master §3, §53)

- Login with email and password; argon2id hashing (m=19456, t=2, p=1); rehash on login when
  parameters change.
- Sessions: 256-bit opaque token, only its SHA-256 stored server-side; cookie
  `HttpOnly; Secure; SameSite=Lax; Path=/`; sliding 7-day expiry with a 30-day absolute cap;
  server-side revocation; logout deletes the row and clears the cookie.
- CSRF: double-submit token plus `Origin` / `Sec-Fetch-Site` checks on every unsafe method.
- Rate limiting and brute force: per-IP and per-account token buckets in `login_attempts`,
  progressive lockout, constant-time comparison, identical error text and timing for unknown-user and
  wrong-password.
- Password change while authenticated invalidates all other sessions.
- All authentication events are logged (never the credentials).

### 8.2 Economic calendar pipeline (master §7, §34)

Ingests, deduplicates and stores events and releases relevant to gold: US CPI, Core CPI, PPI, Core
PPI, NFP, unemployment rate, average hourly earnings, initial jobless claims, GDP, retail sales, ISM
manufacturing and services, consumer confidence, FOMC decisions and minutes, Fed speeches; plus ECB,
BoE and BoJ policy decisions.

Each release stores: event name, country, currency, scheduled time (UTC, with the source's local time
retained), importance (HIGH / MEDIUM / LOW), previous, forecast, actual, computed surprise and a
standardised surprise (`surprise_z`, using the trailing distribution of that event's surprises where
at least 12 observations exist, otherwise `UNAVAILABLE`), related assets, and full provenance for the
actual and — separately — for the forecast.

Importance classification is deterministic and configuration-driven: a curated map of event → default
importance, overridden by the Tier 3 feed's rating only where no curated entry exists. HIGH always
includes CPI, Core CPI, NFP, FOMC decisions and Fed chair speeches.

Deduplication key: `(country, normalised_event_name, scheduled_date)`. Conflicting values from two
sources are stored with both provenances and flagged `CONFLICTING_SOURCES` rather than silently
picking one.

Actuals are polled at an elevated cadence in a window around each scheduled HIGH-impact release so
the value is captured promptly; polling stops as soon as the actual is present or the window closes.

### 8.3 News pipeline (master §8, §33, §45)

Pipeline stages, each independently testable: **collect → validate → deduplicate → classify →
tag assets and currencies → resolve publication time → score sentiment → assign credibility →
persist with source reference.**

- Deduplication: canonical URL (tracking parameters stripped, redirects resolved), content hash, and
  near-duplicate detection by title shingling with a configurable Jaccard threshold.
- Classification into the master §8 categories — monetary policy, inflation, employment, economy,
  geopolitics, central banks, government policy, trade, banking, market sentiment, risk events — by a
  deterministic, versioned keyword and pattern ruleset. Rule version is stored per article so
  classifications remain explainable.
- Asset and currency tagging by the same deterministic ruleset (gold, USD, EUR, GBP, JPY, …).
- **Sentiment is deterministic**, not AI: a finance-specific polarity lexicon with negation and
  intensifier handling produces a score in [−1, +1] per article, plus the matched terms so the score
  can be inspected. The scoring method and lexicon version are stored on every row. The AI never
  assigns the stored sentiment; it may interpret the aggregate.
- Credibility tiers per master §45: Tier 1 official government, central banks and statistical
  agencies; Tier 2 major established financial data and news providers; Tier 3 other reputable
  financial publications; Tier 4 unverified. Tier 4 is stored but excluded from scoring by default,
  and social-media claims are never treated as confirmed facts.
- The aggregate **news score** is a recency-decayed, tier-weighted mean of article sentiment over a
  configurable window (default 48 hours) restricted to gold-relevant categories, published on the
  same signed −100…+100 scale — **when, and only when, volume clears the threshold in §8.3a.**

#### 8.3a Authority and tone are inversely related, and F8 is dark because of it

Measured 2026-08-30 across twelve feeds: only **2 of 7** gold-relevant articles carried any
sentiment term at all. That is not a gap in the lexicon. It is a property of the sources.

**Authoritative sources are deliberately toneless.** "Bank Rate maintained at 3.75%" is the single
most relevant sentence a central bank published that week, and it contains no sentiment vocabulary
whatsoever — by design, because a central bank writing emotively would itself move markets. The
outlets that *do* write with tone are commentary, and their tone is the writer's, not the market's.

So lexicon sentiment over Tier 1 news measures **editorial word choice**, not market sentiment. The
better the source, the less it tells a polarity scorer.

Two consequences, both binding rather than advisory:

1. **F8's volume threshold exists because of this** (10 articles, 2 sources — §11.6). It is not a
   tuning parameter to be relaxed when the factor stays dark. Measured volume is ~1.3 articles per
   48-hour window against a floor of 10, so **F8 abstains**, and the UI states
   `INSUFFICIENT_NEWS_VOLUME` with the observed count rather than renormalising silently.
2. **Loosening the lexicon to reach the threshold is prohibited**, not merely discouraged. Adding
   weak or ambiguous terms until neutral wording scores would manufacture signal out of text that
   carries none — a fabricated input, which Principle P2 forbids as squarely as an invented price.

**Direction for a future version, noted as direction rather than work.** If a news factor is wanted
later, the honest path is **classification of content, not polarity scoring**: a rate hold versus a
rate cut is a *fact* with a knowable direction for gold, and a Fed speech scheduled versus delivered
is a *fact* about event risk. Those are extractable from toneless official text precisely because
they do not depend on tone. Sentiment scoring is the wrong instrument for the sources that matter
most, and no amount of lexicon work changes that.

### 8.4 Macro and market-data pipelines (master §6, §11, §38)

- Macro: the FRED series listed in §9.2 are ingested with their observation date, value and vintage,
  so a revision is a new row rather than an overwrite. Revisions raise a `REVISED` quality flag.
- Market data: XAUUSD spot quote and daily closes. Prices stored as `numeric(20,8)`. Impossible
  values (non-positive, or a move beyond a configured sigma threshold) are flagged and quarantined
  rather than scored (master §52).

### 8.5 Deterministic fundamental engine (master §6, §12)

The engine is a **pure function** — `(facts, config, now) → FundamentalResult` — with no I/O and an
injected clock, so it is fully reproducible and unit-testable offline.

#### 8.5.1 Scales

Canonical internal scale is **signed −100…+100** (master §12). The display scale used by the UI and
by later confluence work is `display = round((signed + 100) / 2)`, giving 0…100. Both are stored.

Display bands (master §17, configurable):

| Display | Label |
|---|---|
| 90–100 | Extremely Bullish |
| 75–89 | Strong Bullish |
| 60–74 | Bullish |
| 45–59 | Neutral |
| 30–44 | Bearish |
| 15–29 | Strong Bearish |
| 0–14 | Extremely Bearish |

#### 8.5.2 Factors and default weights

Weights sum to 1.00 and live in `config_profiles`, not in code (master §57). "Sign" is the direction
of the factor's effect on **gold**.

| id | Factor | Inputs (FRED unless noted) | Sign | Weight |
|---|---|---|---|---|
| F1 | US dollar strength | `DTWEXBGS` broad dollar index — 5-day and 20-day change. **Publishes ~9 days in arrears — see §8.5.2a** | inverse | 0.18 |
| F2 | Real 10-year yield | `DFII10` — level and 5/20-day change | inverse | 0.18 |
| F3 | Nominal 10-year yield | `DGS10` — 5/20-day change | inverse | 0.10 |
| F4 | Policy-rate expectations | `DGS2` change, and the `DGS2 − DFF` spread as a policy-path proxy | inverse | 0.15 |
| F5 | Inflation | `CPIAUCSL` and `CPILFESL` year-on-year, plus the latest CPI surprise from §8.2 | net rule, see below | 0.09 |
| F6 | Growth and employment | `PAYEMS` surprise, `UNRATE`, `ICSA` four-week trend, latest NFP surprise | inverse | 0.10 |
| F7 | Risk sentiment | `VIXCLS` level and change, `BAMLH0A0HYM2` high-yield spread change | risk-off = bullish | 0.10 |
| F8 | Geopolitical and policy news pressure | the §8.3 news aggregate restricted to geopolitics, central banks and monetary policy, Tier 1–3 only. **Currently abstains — see §8.3a** | stress = bullish | 0.10 |

**F5's net rule is explicit, not a judgement call.** Inflation affects gold through two opposing
channels, so the factor is the documented combination
`F5 = 0.4 × hedge − 0.6 × rate_channel`, where `hedge` rises with the level of year-on-year core
inflation relative to the 2% target (higher inflation → bullish gold), and `rate_channel` rises with
the latest upside CPI surprise (a hot print implies tighter policy → bearish gold). The two
components are stored and displayed separately so the user sees the trade-off rather than a black box.

#### 8.5.2a F1 measures last week's dollar, and the UI must say so

Verified empirically 2026-08-30: the entire FRED **H.10 exchange-rate family** —
`DTWEXBGS`, `DTWEXAFEGS`, `DEXUSEU` and the rest — publishes with a **~9-day lag**,
while the H.15 yield family (`DGS10`, `DFII10`, `DGS2`) is current to about one
business day.

This is a property of the source, not a fault we can fix, and it has two consequences
that are **product-visible facts rather than configuration detail**:

1. **The series is classified `WEEKLY`, not `DAILY`.** Under daily thresholds a
   9-day-old value scores `UNAVAILABLE`, which would make the joint-heaviest factor
   (weight 0.18) **abstain permanently** — quietly removing 18% of the model's weight
   while everything continued to look like it was working.
2. **F1's momentum measures the previous week's dollar move, not the current one.** A
   reader seeing "USD weakness" is entitled to know how old that judgment is.

**UI requirement.** Wherever F1 contributes — the factor-breakdown row, any driver
list naming dollar strength, and the daily email — the interface must state the
observation date and note that the reading reflects the prior week. A freshness chip
alone is not enough: `RECENT` on a 9-day-old dollar index is technically true and
practically misleading, so F1 carries an explicit lag note beside the chip.

**Test requirement.** A test asserts that **F1 does not abstain under normal
conditions**. A silently abstaining top-weight factor is exactly the failure that
would never be noticed: the score would still be produced, still look plausible, and
be systematically wrong.

#### 8.5.3 Normalisation

Each factor's raw signal is converted to a z-score against a trailing window (default 252 daily
observations), clamped to ±3, with a deadband: `|z| < 0.25 → 0`. Then
`score = sign × clamp(z / 3, −1, 1) × 100`. Window, clamp and deadband are configuration.


#### 8.5.3a History windows are a per-cadence requirement, not a storage preference

A single two-year ingestion window across all twelve series **silently disabled two
factors**, and did so in the one way that looks like correct behaviour.

Two years of a monthly series is twelve observations. A year-on-year change consumes a
twelve-period lag, so the trailing history of year-on-year readings held *one* entry
against the thirty-observation minimum. F5 therefore could not produce a score in any
market condition whatsoever, and F6 ran on jobless claims alone at a quarter of its
input completeness. Neither raised an error: both abstained, which is the right
response to insufficient history and is indistinguishable, from the outside, from the
system working as designed.

This is the failure mode abstention creates. A factor that abstains for a *data* reason
and a factor that abstains because it was never given enough history to exist look
identical on the dashboard. The first is information; the second is a defect wearing
the first one's clothes.

The lookback is therefore sized per cadence, from what each cadence's longest
sub-signal needs plus the thirty-observation floor:

| Cadence | Longest lag | Minimum needed | Window | Observations stored |
|---|---|---|---|---|
| DAILY | 20 days | 272 | 2 years | ~500 |
| WEEKLY | 4 weeks | 34 | 10 years | ~520 |
| MONTHLY | 12 months | 42 | 25 years | ~300 |

FRED charges nothing for history, so this costs one larger response per series on the
first run and roughly 8,000 rows in total — negligible against the 0.5 GB budget in
`LIMITS.md`, and set against two factors that could not exist.

**The general rule: an abstention must be attributable to the world, not to our
configuration.** Where a factor cannot score because of how the system is set up, that
is a defect to fix rather than an abstention to display.

#### 8.5.3b Units are declared, never inferred

Factor explanations quote raw values, and each value's unit is declared alongside it
rather than derived from the field name. An earlier version inferred it and rendered
the broad dollar index level of 118.06 as `+118.06%`.

That is not a formatting slip. The explanation sits directly beneath the score as the
FACT-layer justification for it, which is the point in the interface where a user is
most likely to take a number at face value. A percentage sign on an index level is a
false statement about measured data — precisely the class of error Amendment A2 exists
to prevent, arriving through the presentation layer rather than the data model.

A key with no declared unit renders bare. Uninformative is recoverable; wrong is not.

#### 8.5.3c Every gap is attributed: world, configuration, or structural

An abstention or a partial reading tells the user *that* something is missing. It does
not tell them **whose** missing it is, and the three cases mean entirely different
things to whoever is reading the screen:

| Attribution | What it means | What the user should do |
|---|---|---|
| `WORLD` | The market was quiet, a release has not happened, a provider was down. | Nothing. This is information about conditions. |
| `CONFIGURATION` | Our setup makes the reading impossible. | Report it. It is a defect. |
| `STRUCTURAL` | The data exists but is unreachable on free sources. | Nothing, but know it is permanent until stated otherwise. |

`STRUCTURAL` is not a shade of either neighbour. It is not our misconfiguration — no
ingestion window retrieves a figure nobody publishes free — and it is not the market
being quiet, because the data is out there and paying customers have it. It is a
**standing consequence of the free-tier constraint**, and it recurs: V2 meets it again
on intraday history depth, V4 on per-pair provider coverage. Naming it in the model
now means those cases inherit a category rather than inventing one.

Attribution is derived from the abstention reason (`ATTRIBUTION_OF`), never chosen at
the call site, so one reason cannot be attributed two ways in two places.
`INSUFFICIENT_HISTORY` and `DISABLED` are ours; everything else describes the world.
A structural gap is declared by the caller in `FundamentalInputs.structuralGaps`,
because the engine sees only that a value is absent and cannot tell a permanent
constraint from a pipeline that has not caught up. **Absent a declaration the default
is `WORLD`** — the weaker claim — since telling a user a gap will never close when it
might is the worse error.

#### 8.5.3d A partial factor states which part is missing, in words

A completeness of 0.5 says how much weight a factor lost. It does not say **which half
the reader is looking at**, and for F5 that is the whole difference:

> **Inflation: neutral (0)** — reads as "inflation is not currently pushing gold
> either way".
>
> The truth is that the inflation-**hedge** channel is neutral and the opposing
> **rate** channel was not measured at all.

So every incompletely-measured factor carries `limitations`: what is missing, why, and
what would resolve it. These are appended to the factor's own explanation — the
sentence rendered directly beneath the score — rather than shown as a separate
completeness badge, because the caveat has to travel with the number it qualifies.

The two current cases, both `STRUCTURAL` (LIMITS.md §6.9):

| Factor | Missing | Effect |
|---|---|---|
| **F5 Inflation** | the rate channel — the policy-tightening response to a hot CPI print, which works against gold and carries 0.6 of the net rule | the published reading reflects the hedge channel only |
| **F6 Growth and employment** | the payrolls surprise — how far the latest jobs report landed from consensus | three of four labour inputs contribute |

Both state their resolution: *"resolves once roughly twelve months of forecasts have
accumulated from live ingestion"*. A limitation with an end date reads as a known
constraint; the same limitation without one reads as a permanent unknown, and users
discount a product accordingly.

The disclosure **removes itself**. It is emitted only while the sub-signal is absent,
so the first run after twelve surprises have accrued drops the caveat, restores full
completeness and needs no edit. A hardcoded caveat would outlive the constraint it
describes — which is its own kind of dishonesty.
#### 8.5.4 Factor confidence and aggregation

```
factor_confidence = freshness_weight × tier_weight × input_completeness
    freshness_weight: LIVE 1.00 | RECENT 0.85 | STALE 0.50 | UNAVAILABLE 0.00
    tier_weight:      T1 1.00 | T2 0.90 | T3 0.75 | T4 0.40
    input_completeness: fraction of the factor's required inputs that resolved

effective_weight_i = weight_i × factor_confidence_i
fundamental_score  = Σ(score_i × effective_weight_i) / Σ(effective_weight_i)
coverage           = Σ(effective_weight_i) / Σ(weight_i)
```

Renormalising by effective weight means an unavailable factor **abstains** rather than silently
voting zero — a missing input must not masquerade as a neutral reading.

**Insufficiency rule.** If `coverage < 0.50`, no score is published. The analysis is stored with
status `INSUFFICIENT_DATA`, the UI shows which factors are missing and why, the AI is not called, and
the daily email says so plainly. This is a required, tested behaviour, not an error path.

#### 8.5.5 Factor record

Every factor produces, and stores: direction (BULLISH / BEARISH / NEUTRAL), raw signal values,
z-score, normalised score, weight, effective weight, confidence, freshness, the list of `fact_refs`
it consumed, and a **deterministically generated** one-sentence explanation (a template filled with
real values — not AI prose). Master §12 requires direction, score, weight, confidence, source,
timestamp and explanation; all seven are present.

### 8.6 Confidence engine (master §21)

Confidence is **not** the score. It is computed from:

| Input | Effect |
|---|---|
| Coverage (data completeness) | primary driver |
| Source quality | weighted mean tier weight of contributing facts |
| Factor agreement | `agreement = |Σ wᵢsᵢ| / Σ wᵢ|sᵢ|` — high when factors point the same way |
| Freshness | penalty proportional to the effective weight sitting on STALE data |
| Provider degradation | penalty when a chain is running on a fallback or a breaker is open |
| Event risk | penalty and hard cap when a HIGH-impact release is imminent |

Result: a 0–100 confidence value mapped to HIGH (≥ 70), MEDIUM (≥ 45), LOW (< 45) — thresholds
configurable. **Hard caps:** coverage < 0.65 caps confidence at MEDIUM; a HIGH-impact release within
60 minutes caps it at MEDIUM; a fundamental↔technical agreement input is present in the interface
but unused in V1 and documented as such.

### 8.7 Event risk (master §47)

The engine detects imminent HIGH-impact releases and produces an explicit warning object: event name,
time until release, and the standard caution that a current reading may be invalidated by the
upcoming release. It feeds the confidence cap above, appears on the dashboard, and appears in the
daily email when a HIGH-impact event falls within the day.

### 8.8 Gemini integration (master §10, §11, §23, §43, §44)

**Abstraction.** `AIProvider` with `GeminiProvider` as the only V1 implementation. No Gemini symbol
appears outside `packages/ai/providers/gemini`, enforced by a lint boundary rule rather than
convention. Runtime authentication is a `GEMINI_API_KEY` issued by Google AI Studio on its own free
tier; a **consumer Gemini subscription grants no programmatic access and is never used at runtime**.
Neither is Claude Pro an API subscription, and it is likewise not used at runtime anywhere (master
§10). The model id and its fallback are configuration (§11.7), not constants.

**Input.** A single `EvidenceBundle` built from stored facts, in which every fact carries a stable
`factId`, a value, a unit, a source name, a source tier, a source timestamp, a retrieval time and a
freshness status; plus the computed factors, the score, the confidence breakdown, the upcoming
calendar, the top-ranked news headlines, and an explicit `unavailable[]` list naming every input that
could not be resolved. The AI has no network access and no database access; it sees the bundle and
nothing else.

**Prompt.** `fundamental_analysis_v1` and `daily_report_v1`, stored as versioned files, each
exporting its system prompt, its Zod schema and the JSON schema given to Gemini's `responseSchema`.
The prompt name and version are recorded on every generation.

**Output schema (V1).**

```jsonc
{
  "asset": "XAUUSD",
  "analysis_timestamp": "ISO-8601",
  "fundamental_score": 0,            // must equal the engine's display score
  "fundamental_bias": "BULLISH",     // must equal the engine's band
  "news_score": 0,                   // must equal the engine's news score
  "confidence": "HIGH",              // must equal the engine's confidence
  "interpretations": [               // INTERPRETATION layer
    { "statement": "", "fact_refs": ["factId"] }
  ],
  "bullish_factors":     [ { "factor_id": "", "statement": "", "fact_refs": [] } ],
  "bearish_factors":     [ { "factor_id": "", "statement": "", "fact_refs": [] } ],
  "conflicting_factors": [ { "statement": "", "fact_refs": [] } ],
  "key_events":  [ { "event_ref": "", "note": "" } ],
  "assessment": "",                  // AI ASSESSMENT layer, prose
  "invalidation_conditions": [ { "statement": "", "fact_refs": [] } ],
  "data_gaps": [ "" ],               // must be drawn from bundle.unavailable[]
  "sources": [ "factId" ]
}
```

Master §44's `technical_score`, `overall_score`, `technical_bias`, `overall_bias` and `key_levels`
fields are deliberately absent in V1 because no technical engine exists to populate them; adding a
fabricated technical number would violate the anti-hallucination requirement. They are reintroduced
in V2 and V3 with the same schema shape.

**Validation and the anti-hallucination gate (master §23, §44).** After the Zod parse, semantic
guards run:

1. Every numeric field must equal the corresponding engine value (exact for scores, within a stated
   tolerance for derived figures).
2. Every `fact_refs` and `sources` entry must exist in the bundle.
3. Every `factor_id` must be one of F1–F8.
4. Every `event_ref` must exist in the bundle's calendar.
5. `data_gaps` must be a subset of `bundle.unavailable[]`.
6. No free-text field may contain a numeric literal that does not appear in the bundle (a scanning
   guard with a documented tolerance and whitelist for ordinals and dates).
7. No performance or win-rate claim may appear (Amendment A1) — a prohibited-phrase check.
8. **No predictive claim may appear (Amendment A3)** — a versioned matcher rejects forecast
   constructions such as "will rise", "expect a move to", "targets", "should reach", "likely to
   break", and probability or percentage-chance phrasings about future price. The schema reinforces
   this by naming its fields `assessment` and `interpretations` — there is no `prediction`,
   `forecast`, `target` or `outlook` field for the model to fill. The prompt states the rule directly:
   describe what conditions are, not what price will do.

A failure produces **one** corrective retry with the specific validation errors appended. A second
failure stores the failure in `ai_generations`, stores **no** analysis prose, and the UI renders the
complete deterministic analysis under an explicit **"AI ASSESSMENT UNAVAILABLE"** banner. Malformed
analyses are never persisted.

**Model availability is a runtime concern, not a configuration one.** Verified
2026-08-30: `gemini-3.7-flash` returned 503 on 4 of 4 attempts, `gemini-3.5-flash` and
`gemini-3.6-flash` were available 4 of 4, and `gemini-2.5-flash` returned 404 despite
being listed by the models endpoint. Free-tier availability shifts without notice, so:

- A 503 or 404 from the configured model **falls back to the configured alternate
  within the same analysis** rather than failing the run.
- The model actually used is recorded on the `ai_generations` row, so an analysis is
  always attributable to the model that produced it.
- A fallback is logged and shown on the system status panel — running on the alternate
  is a degraded state, not a silent one.
- **A model listed by `/models` is not necessarily callable.** Availability must be
  re-verified at the start of each version rather than trusted once.

**Fallback and cost.** Gemini failures are retried with exponential backoff subject to the same
circuit breaker as any other provider. The system is fully useful with the AI switched off.

### 8.9 The dashboard (master §31, §32, §33, §34, §38, §58, §59)

**One page**, `/dashboard`, dark trading-terminal styling, server-rendered. It is the whole V1 UI
apart from `/login`, a minimal report archive (`/reports`, `/reports/:id` — required so the daily
email links to a permanent copy) and a system status panel.

Panels, in order:

1. **Header** — XAUUSD, spot price with freshness chip, last analysis time, global data-health
   indicator, `Refresh analysis` action.
2. **Verdict** — fundamental bias, display score with the −100…+100 value shown alongside, confidence
   with its contributing breakdown on hover, and an event-risk warning strip when armed. The score is
   rendered by `<ScoreDisplay>`, which always carries the Amendment A3 caveat — *"Describes current
   conditions. Not a forecast of price movement."* — as a structural part of the component, with no
   prop able to hide it. Every score anywhere in V1, including in the email, goes through this one
   component, so the caveat cannot be lost on a page added later.
3. **Factor breakdown** — the eight factors as rows: direction, score, weight, effective weight,
   confidence, freshness chip, the deterministic explanation, and an expander revealing every
   underlying fact with source name, source URL, source timestamp and retrieval time (master §22).
   Abstaining factors are rendered as `UNAVAILABLE` with the reason, never as 0.
4. **Analysis** — the three-layer block: FACT band, INTERPRETATION band, AI ASSESSMENT band, visually
   distinct, each labelled, each showing its lineage. This is the §58 requirement made structural.
5. **Economic calendar** — today and the next seven days, filterable by importance and currency, with
   previous / forecast / actual / surprise and separate provenance for the Tier 1 actual and the Tier
   3 forecast.
6. **News** — the ranked recent list with source, tier badge, category, deterministic sentiment,
   publication time and freshness, filterable by importance, sentiment and time window.
7. **System status** — per-provider health, breaker state, remaining free quota, last successful
   fetch per domain, and the last job runs.

Freshness chips (LIVE / RECENT / STALE / UNAVAILABLE) appear wherever a value appears (master §38).
No panel ever renders a number without its provenance being reachable in at most one interaction.

### 8.10 Daily email report (master §26, §28, §29)

- `NotificationProvider` → `EmailProvider` → Resend, with an SMTP implementation as fallback. No
  Resend symbol appears outside its provider module.
- Generated on a schedule (default 05:30 UTC, configurable, delivery time expressed in the user's
  configured IANA timezone; **market calculations remain UTC** and no local timezone is hard-coded
  into them, per master §15).
- Content: date; XAUUSD bias, display score and confidence; the top bullish and bearish factors with
  their values and sources; the day's HIGH-impact events with times; the top three news items with
  tier badges; the AI assessment clearly labelled as such; a data-health line naming anything
  `STALE` or `UNAVAILABLE`; and a link to the permanent stored report.
- Plain-text and HTML parts; no remote images; no tracking pixels.
- Delivery is recorded in `notifications` with provider message id and status. A send failure is
  retried with backoff and surfaced on the system status panel.
- **Data-failure alert:** if any domain is unavailable beyond its configured window, a separate alert
  email is sent (deduplicated, at most once per configured cooldown).
- The report is stored immutably before it is sent, so the emailed content and the stored copy can
  never diverge.

---

## 9. Data model (V1 subset)

Full conventions in `ARCHITECTURE.md` §7. UTC `timestamptz` throughout, UUIDv7 keys, `numeric` for
prices, raw payloads archived.

### 9.1 Tables created in V1

`users`, `sessions`, `login_attempts`, `audit_events`,
`assets`, `currencies`, `macro_series`, `news_sources`, `config_profiles`,
`provider_responses`, `provider_cache`, `provider_status`, `job_runs`,
`market_quotes`, `market_candles` (daily only in V1), `macro_observations`,
`economic_events`, `economic_releases`,
`news_articles`, `news_article_assets`, `news_sentiment`,
`analyses`, `fundamental_factors`, `analysis_statements`, `ai_generations`,
`reports`, `notifications`, `alert_rules`,
`system_logs`, `data_quality_incidents`.

Columns that later versions need — `analyses.technical_score`, `analyses.overall_score`,
`analyses.regime` — are created now as nullable, so V2 and V3 add data rather than migrate structure.

### 9.2 Macro series seeded in V1

`DTWEXBGS` broad dollar index · `DFII10` 10-year TIPS real yield · `DGS10` 10-year nominal ·
`DGS2` 2-year · `DFF` effective fed funds · `CPIAUCSL` CPI · `CPILFESL` core CPI ·
`PAYEMS` nonfarm payrolls · `UNRATE` unemployment · `ICSA` initial claims ·
`VIXCLS` volatility index · `BAMLH0A0HYM2` high-yield spread.

### 9.3 Provenance contract

Every fact-bearing row carries, `NOT NULL`: `source_provider`, `source_name`, `source_url` (nullable
only where the source publishes no addressable document), `source_tier`, `source_timestamp`,
`retrieved_at`, `freshness`, `quality_flags`, `created_at`, `updated_at`. Applied through one shared
column helper so it cannot be omitted.

### 9.4 Freshness thresholds (defaults, configurable)

| Domain | LIVE | RECENT | STALE beyond |
|---|---|---|---|
| Spot quote | < 10 min | < 30 min | > 2 h |
| Daily macro series | < 24 h | < 72 h | > 7 d |
| Monthly macro series | < 7 d | < 40 d | > 60 d |
| Economic calendar | < 6 h | < 24 h | > 48 h |
| News | < 30 min | < 4 h | > 24 h |

Freshness is stored at write time **and recomputed at read time**.

The spot thresholds were widened from the original plan's `< 2 min` LIVE. With a 5-minute polling
cadence (§11.5) a 2-minute LIVE window would have meant the price rendered as `RECENT` essentially
always — a threshold the system could never satisfy. Ten minutes is coherent for a fundamentals
product where price is context rather than a trading feed.

### 9.4a Seed reconciliation — removals must deactivate, not orphan

The seed arrays are the source of truth. Upserting alone leaves a removed entity in
the table, still active and still in use — observed for real when two news feeds were
dropped after failing verification and then kept appearing as ingestion failures on
every run, because nothing ever turned them off.

Every seeded entity is therefore reconciled on each run, by one of two mechanisms
chosen by what references it:

| Entity | On removal | Why |
|---|---|---|
| `news_sources` | **Deactivate** | Stored articles keep their source row and provenance |
| `macro_series` | **Deactivate** | `macro_observations` cascades from it; deleting would erase the history behind every factor that used it |
| `assets` | **Deactivate** | Candles, quotes, analyses and reports all cascade from it |
| `event_importance_rules` | **Delete** | Nothing references them — the rule is applied at ingest and its *result* stored. A leftover rule is an orphaned **decision**, silently classifying releases by a policy already retired |
| `config_profiles` | **Left alone** | Every analysis references the profile it ran under; an old profile must survive for its report to stay reproducible. Only one may be active, enforced by a partial unique index, so a superseded profile is already inert |
| `currencies` | **Left alone** | Assets reference them, and a currency is never meaningfully removed |

#### 9.4a.1 Field-by-field reconciliation, and why "the row exists" was never enough

Deactivation-on-removal fixed one half of the problem. The other half took two more
incidents to see:

| Phase | What the seed said | What the database did | Cost |
|---|---|---|---|
| 6 | feed removed | still active, failing every run | noise on every run until noticed |
| 7 | `DTWEXBGS` cadence `WEEKLY` | kept `DAILY` — the upsert refreshed only `name`, `role`, `unit` | **F1, joint-heaviest at weight 0.18, scored `STALE` at half weight for two phases** |
| 8 | `expectedPublicationDays` per series | *(same hazard, caught before it shipped)* | — |

All three are one failure: the seed is the source of truth, but nothing checked that
the database agreed with it. Presence was never the property that mattered.

`verifySeedIntegrity` therefore compares **every field the seed declares**, for every
seeded entity, and reports each divergence with its expected and actual value. It runs
in two places:

- **As a test**, against real Postgres, with each case reproducing an actual incident
  rather than a hypothetical one.
- **At worker startup**, via `assertWorkerPreflight`, which **fails closed**: a tick
  that cannot confirm the database matches the seed does not run its jobs. Stopping is
  deliberate. A halted pipeline is visible and has an obvious remedy; a pipeline
  scoring a factor at half weight because of a one-word mismatch is neither. There is
  no off switch — the worker's own tests re-seed rather than bypass it.

Two deliberate exclusions, both because the seed must not overrule an operator:

- `assets.isActive` is not compared. Activating an asset is an operational decision,
  which is also why the upsert does not overwrite it.
- `config_profiles` are not compared. An old profile must survive unchanged for its
  reports to stay reproducible (§9.5).

The check also enforces one invariant the seed alone cannot: every active news source
must be HTTPS. The seed test asserts no plaintext feed enters the seed; this asserts
none reaches the table by any other route.

### 9.5 Reproducibility

Every `analyses` row records the `config_profile_id` used and stores its complete `evidence_bundle`
as JSON. Re-opening an old report renders exactly what was true then, with the weights that were in
force then (master §35).

### 9.6 Three-layer enforcement (Amendment A2)

`analysis_statements` carries a `statement_layer` enum and CHECK constraints requiring: a FACT row to
have a `fact_table`, `fact_id` and full provenance and no derivation; an INTERPRETATION or
AI_ASSESSMENT row to derive from at least one lower-layer statement; an AI_ASSESSMENT row to
reference the `ai_generations` row that produced it, and non-AI rows to reference none. A trigger
enforces that lineage stays within the analysis and strictly descends the layer order. The exact DDL
is in `ARCHITECTURE.md` §7.3.

---

## 10. API (V1 subset, master §56)

Cookie-authenticated, Zod-validated request and response, CSRF header on unsafe methods.

```text
POST /api/auth/login          POST /api/auth/logout       GET /api/auth/me
POST /api/auth/password

GET  /api/assets
GET  /api/market-data/XAUUSD
GET  /api/macro/:seriesId
GET  /api/economic-calendar   ?range=today|tomorrow|week&currency=&impact=
GET  /api/news                ?category=&sentiment=&tier=&from=&to=&limit=
GET  /api/analysis/XAUUSD                       latest stored analysis
POST /api/analysis/XAUUSD     { "mode": "FUNDAMENTAL" }   refresh then analyse; rate limited
GET  /api/analyses            ?from=&to=&bias=&confidence=
GET  /api/reports             GET /api/reports/:id
GET  /api/system/status
```

`POST /api/analysis/XAUUSD` accepts the `mode` enum defined for all versions but rejects any value
other than `FUNDAMENTAL` in V1 with a clear "not available in this version" error — the contract is
forward-compatible without pretending the capability exists.

Every value-bearing response embeds provenance and freshness. Error responses use a stable error-code
taxonomy and never leak internal messages or secrets (master §41).

---

## 11. Operational behaviour

### 11.1 Caching (master §39)

Postgres-backed `CacheStore`. Defaults: spot quote 60 s; daily macro series 6 h; calendar 30 min
(2 min inside a release window); news feeds 10 min; AI responses are not cached.

### 11.2 Rate limits, retries, breakers (master §40)

Per-provider token buckets sized to documented free tiers; timeouts on every call; retries only for
transient classes (network, 5xx, 429 with `Retry-After` honoured) with exponential backoff and
jitter, capped at a configured attempt count; a circuit breaker opens after N consecutive failures
and half-opens after a cooldown. An unavailable API is never retried continuously.

### 11.3 Error handling (master §41)

A typed error taxonomy — `ProviderError`, `ValidationError`, `AIValidationError`, `DataUnavailable`,
`AuthError`, `RateLimited`, `DatabaseError` — each with a user-safe message and a private detail. No
stack trace, secret or raw provider response ever reaches a client.

### 11.4 Logging (master §42)

Structured JSON via pino with a request/job correlation id. Logged: provider requests and outcomes,
provider failures and breaker transitions, AI requests, latencies, token counts and validation
outcomes, ingestion counts, analysis generation, authentication events, notification events and
system errors. Redaction paths for `authorization`, `cookie`, `password`, `token`, `*apiKey*`.
Passwords, keys and tokens are never logged.

### 11.5 Schedule (worker, UTC; all jobs idempotent via `job_runs`)

| Job | Cadence |
|---|---|
| **Consolidated ingestion tick** | **every 15 min** — one invocation runs every job then due (news, calendar, macro, quote). Neon free grants 100 CU-hours/month and suspends compute after 5 idle minutes; a 5-minute cadence would keep it permanently awake and exhaust the month around day 16. |
| Economic calendar sync | every 4 h; **every 15 min** (tick cadence) inside a ±90 min window around a HIGH-impact release until the actual lands |
| Macro ingestion | hourly |
| Raw archive prune | daily — drops  older than the retention window |
| Spot quote | folded into the 15-minute tick, while the gold market is open (Sun 22:00 – Fri 22:00 UTC) |
| Daily close ingestion | daily after settlement |
| Fundamental analysis run | hourly, plus immediately after a HIGH-impact actual is captured |
| Daily report and email | daily at the configured time |
| Freshness sweep, provider health, cache prune | every 10 min |

### 11.6 Free-tier constraints on the design

The permanently-free requirement is a design constraint, not a deployment detail. Three consequences
reach into V1's code:

1. **The job trigger is pluggable.** Due-ness is computed from the `job_runs` ledger, not from
   process uptime, so the same `runDue(now)` serves both a long-lived process (`IntervalTrigger`) and
   an external scheduler calling `POST /api/jobs/tick` (`HttpTrigger`). Neither Vercel Hobby cron
   (once per day) nor a Cloudflare Worker (10 ms CPU) can host the work itself, so the fallback target
   needs the HTTP trigger. This also makes a worker that was offline for hours catch up correctly.
2. **Advisory locks are transaction-scoped** (`pg_advisory_xact_lock`), never session-scoped. Neon and
   Supabase pool connections through PgBouncer in transaction mode, where a session lock is silently
   ineffective — worse than no lock at all.
3. **Raw payload retention is bounded.** `provider_responses` is the dominant storage consumer against
   a 0.5 GB cap, so it carries a configurable retention window (14 days by default) pruned by a
   scheduled job. Article bodies are stored truncated with the canonical URL kept for the full text.
   Storage headroom appears on the system status panel so the cap is visible before it is reached.

### 11.7 Configuration (master §57)

Held in `config_profiles`, editable without a deploy, versioned, and referenced by every analysis:
factor weights, normalisation window, clamp and deadband, confidence thresholds and caps, bias bands,
news credibility tier weights, news window and decay, event importance overrides, cache TTLs,
freshness thresholds, alert thresholds and cooldowns, and the report schedule.

### 11.8 Environment variables (master §54)

```env
DATABASE_URL=
TEST_DATABASE_URL=        # integration tests only; a dedicated database
JOB_TRIGGER_SECRET=       # authenticates POST /api/jobs/tick when using an external scheduler
JOB_TRIGGER_MODE=         # interval | http
SESSION_SECRET=
CSRF_SECRET=
APP_BASE_URL=
GEMINI_API_KEY=          # from Google AI Studio; a consumer Gemini subscription grants no API access
GEMINI_MODEL=            # default gemini-3.7-flash
GEMINI_FALLBACK_MODEL=   # default gemini-3.5-flash
FRED_API_KEY=
TWELVEDATA_API_KEY=
NASDAQ_DATA_LINK_API_KEY=
RESEND_API_KEY=
SMTP_URL=                # fallback email transport
REPORT_FROM_EMAIL=
REPORT_TO_EMAIL=
REPORT_TIMEZONE=         # delivery time only; market calculations remain UTC
LOG_LEVEL=
```

Parsed once through Zod at boot; the process exits with a clear message on a missing or invalid
value. `.env.example` lists every variable with a comment; no real secret is committed; a secret scan
runs in CI. No `NEXT_PUBLIC_*` variable holds a credential.

---

## 12. Security requirements (master §53)

HTTPS in production via the reverse proxy or managed host, with HSTS; secure cookies; argon2id hashing; Zod input validation on
every boundary; parameterised queries only; React escaping plus a strict nonce-based CSP with no
inline scripts; CSRF double-submit; rate limiting on login and on on-demand analysis; CORS locked to
the app origin; `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`,
`frame-ancestors 'none'`; secrets only in environment variables, only read in `packages/config`;
`.env` git-ignored; dependency audit in CI.

---

## 13. Testing (master §51) — written alongside each component, never deferred

### 13.1 Unit

Fundamental factor normalisation (z-score, clamp, deadband, sign) with golden fixtures; the F5 net
rule including both channels; weighted aggregation with abstention and the `coverage < 0.50`
insufficiency rule; the confidence engine including every hard cap; event-risk detection across
boundary times; news deduplication (canonical URL, hash, near-duplicate); news classification and
lexicon sentiment including negation; economic surprise and `surprise_z` including the
insufficient-history case; freshness computation at every threshold boundary; bias band mapping;
score-scale conversion round-trip; the Amendment A3 prohibited-claim matcher against a corpus of
forecast phrasings that must be rejected and descriptive phrasings that must pass; `<ScoreDisplay>`
rendering its caveat with no prop able to suppress it; and a repository-wide copy check that fails
the build on forecast vocabulary in UI strings and email templates.

### 13.2 Integration (real Postgres on a dedicated test database, provider fakes at the HTTP layer)

Provider fallback A → B → cache → `UNAVAILABLE`, asserting no fabricated value at any step; rate
limiter and circuit breaker behaviour including recovery; each ingestion job's idempotency under
re-run and under partial failure; database constraint enforcement — a FACT statement without
provenance, an INTERPRETATION without lineage and an AI_ASSESSMENT without a generation id must all
be **rejected by the database**; authentication flows including lockout, session expiry and CSRF
rejection; Gemini schema validation across three paths (valid; invalid then corrected on retry;
invalid twice → failure recorded and no analysis prose stored); each anti-hallucination semantic
guard fired individually by a crafted response; email send success, failure and retry.

### 13.3 End-to-end (Playwright)

Login → dashboard renders with live data → factor breakdown expands to show real sources → the three
layers are visually and structurally distinct → trigger an on-demand analysis → a report exists and
reopens at its permanent URL. A second E2E run with the primary provider forced offline asserts that
`STALE` and `UNAVAILABLE` states render and that no number is invented.

### 13.4 Freshness-classification audit (Phase 8)

Every macro series carries a `cadence` — `DAILY`, `WEEKLY` or `MONTHLY` — and that
classification selects its freshness thresholds. Get it wrong and a factor either
abstains permanently or is treated as current when it is a week old. Both failures are
silent.

The H.10 discovery proved the assumed cadence can differ from the real one, and **H.10
will not be the only case**: `ICSA` is weekly but released with a lag, monthly series
publish on irregular calendars, and FRED can change a release schedule without notice.

So Phase 8 ships an audit that, for **every** seeded series, fetches recent
observations and asserts the **declared cadence matches the observed update interval**
— the real median gap between observation dates and the real publication lag, not the
name of the series or the `frequency` field FRED reports.

It runs as an integration test against live FRED. A mismatch fails, naming the series,
its declared cadence, and the observed one. This is a data-quality invariant, not a
one-off verification: the check must keep running, because the answer can change after
we ship.

#### 13.4.1 The audit, run 2026-08-30

Every figure below was read from FRED's **first-release** dates — `output_type=4` with
an explicit realtime range — so the publication weekday and lag are the dates the
values actually first appeared, not the dates of later revisions. Eighty releases per
daily series, fifty-one for `ICSA`, eleven for the monthlies.

| Series | FRED says | Observed obs-to-obs gap | Median publication lag | Publishes on | Declared cadence | Match? |
|---|---|---|---|---|---|---|
| `DGS10` | D | 1d x63, 3d x16 | 1d (max 4) | Mon-Fri | `DAILY` | yes |
| `DGS2` | D | 1d x63, 3d x16 | 1d (max 4) | Mon-Fri | `DAILY` | yes |
| `DFII10` | D | 1d x63, 3d x16 | 1d (max 4) | Mon-Fri | `DAILY` | yes |
| `DFF` | D | 1d x79 (all 7 days) | 1d | Mon-Fri, Tue heaviest | `DAILY` | yes |
| `VIXCLS` | D | 1d x63, 3d x16 | **0d** | Mon-Fri | `DAILY` | yes |
| `BAMLH0A0HYM2` | D | 1d x63, 3d x16 | **0d** | Mon-Fri | `DAILY` | yes |
| `DTWEXBGS` | D | 1d x64, 3d x15 | **5d** (max 10) | **Mon x75, Tue x5** | `WEEKLY` | qualified, see below |
| `ICSA` | W | 7d x50 | 5d | **Thu x48, Wed x3** | `WEEKLY` | yes |
| `CPIAUCSL` | M | 30-31d | **43d** | Tue-Fri, never Mon | `MONTHLY` | yes |
| `CPILFESL` | M | 30-31d | **43d** | Tue-Fri, never Mon | `MONTHLY` | yes |
| `PAYEMS` | M | 30-31d | **37d** | Fri x6, else Tue-Thu | `MONTHLY` | yes |
| `UNRATE` | M | 30-31d | **37d** | Fri x6, else Tue-Thu | `MONTHLY` | yes |

Two things the table makes visible that a per-series spot check would not:

**`DTWEXBGS` is a daily series with a weekly publication.** Its observations are dated
every business day — 64 one-day gaps in 80 — but they are released in a single Monday
batch. The `WEEKLY` classification reached the right answer for the wrong reason: it
was chosen to loosen a threshold, not to describe a release schedule. It is retained,
now on the correct grounds, and paired with a Monday-only publication calendar.

**`DFF`'s observation calendar and publication calendar genuinely differ.** The
effective federal funds rate is defined for all seven days, so observations carry
Saturday and Sunday dates, but nothing is published at the weekend — Monday's release
covers it, which is why Tuesday is its heaviest publication day (33 of 80). Only the
publication calendar belongs in `expectedPublicationDays`; conflating the two would
have marked it as publishing on days it never publishes on.

The maximum lags in the source data (`CPIAUCSL` 78d, `PAYEMS` 80d, `ICSA` 54d) are a
measurement artifact, not a finding: FRED clamps `realtime_start` to the requested
range, so the oldest rows in the window report the window's start rather than their
true first-release date. The medians are unaffected and are what the table reports.

#### 13.4.2 Business-day awareness: resolved

The open item recorded here previously — daily market series scoring `STALE` every
weekend — is fixed rather than deferred. Two days in seven of degraded confidence on
every market-hours series is a persistent distortion, and confidence carries this
product's central claim.

Each series now carries `expectedPublicationDays`: the weekdays it actually publishes
on, taken from the table above. Age is counted in **publication days elapsed**
(`assessFreshnessOnCalendar`) rather than calendar hours — days the source does not
publish on contribute nothing. This was chosen over a blanket business-day rule
because it also expresses the genuinely weekly series, which a business-day rule
cannot: `ICSA` on Thursdays, `DTWEXBGS` on Mondays.

Three consequences worth stating plainly:

1. **Thresholds are now read in publication-day time.** For daily series one
   publication day is one business day, so those numbers are unchanged. The weekly
   ones had to change: one publication day is a *week* for `ICSA` and `DTWEXBGS`, so
   the previous 7/14/30-day wall-clock thresholds would have meant seven, fourteen and
   thirty weeks. They are now 1/2/4 missed releases.

2. **The wall-clock age is still reported.** `CalendarFreshnessResult` carries both
   `sourceAgeMs` (honest — 39.7 hours for a Friday value read on Sunday) and
   `effectiveAgeMs` (what the status was computed from), plus `calendarAdjusted`. A
   `LIVE` chip on a Sunday must be explainable, not surprising.

3. **`maxRetrievalAgeMs` stays on the wall clock.** Whether our own worker has run is
   a fact about us, not about the publisher's calendar; a worker that died on Friday
   is just as dead on Sunday.

Verified end to end on Sunday 2026-08-30 against live FRED and a real database: ten of
twelve series store `LIVE` where they previously stored `RECENT` or `STALE`. `VIXCLS`
and `BAMLH0A0HYM2` correctly remain `RECENT` — both publish same-day, both last
published on the Thursday, and Friday was a publication day that produced nothing. The
calendar removes the weekend penalty without removing a real missed-release penalty,
which is the property that makes it worth having.
### 13.5 Gates

CI must pass typecheck, lint (including the module-boundary rules), unit, integration, E2E, build and
secret scan before a merge. No component is considered complete without its tests.

---

## 14. Deployment (master §50 discipline, Amendment: deployable from V1)

**Hard constraint: the stack must be free permanently.** No paid service, no trial credits, nothing
that expires. This shapes the job layer, the database driver and the retention policy — see
`ARCHITECTURE.md` §14 for the full free-tier survey conducted 2026-08-30.

- **Local:** PostgreSQL 16+ **installed natively** — no container runtime. `pnpm db:create` creates
  and migrates the development database; `pnpm db:create:test` does the same for `forex_agent_test`.
  Both read only `DATABASE_URL` / `TEST_DATABASE_URL`, so nothing in the codebase knows or cares how
  Postgres was installed. A seeded admin user is created by a CLI command that prompts for a password
  — never a default credential.
- **Production, primary target:** a single **Oracle Cloud Always Free** ARM VM (2 OCPU / 12 GB /
  200 GB / 10 TB egress) running Postgres, the Next.js app and the worker as Node processes under
  **systemd**, with TLS from a reverse proxy. This target imposes no cadence, storage or connection
  constraints, and the design runs on it unmodified.
- **Production, portable fallback:** **Neon** (Postgres) + **Vercel Hobby** (Next.js and the job
  endpoint) + an external free scheduler (a Cloudflare Worker cron trigger or a GitHub Actions
  schedule) calling `POST /api/jobs/tick`. Chosen if Oracle capacity is unavailable at signup. Note
  Vercel Hobby is restricted to non-commercial use by its terms, which suits this private tool but
  would need revisiting if that ever changed.
- **Both targets are supported by one code path**, because job due-ness is computed from the
  `job_runs` ledger rather than from process uptime (§11.5). Windows deployment via PM2 or a Windows
  service is documented as a third option.
- `DEPLOY.md` documents native Postgres installation, first deploy on each target, migration,
  rollback, backup and restore, key rotation, supervisor configuration and the post-deploy check
  against `/api/system/status`. **V1 is not complete until this deploy has been performed once
  against a real domain.**

## 15. Documentation deliverables (master §55)

`README.md` (architecture summary, setup, installation, environment variables, database setup, API
key acquisition for FRED / Twelve Data / Gemini / Resend, local development, testing, deployment,
troubleshooting), `ARCHITECTURE.md` (exists), `API.md`, `DATABASE.md`, `SECURITY.md`, `DEPLOY.md`.
Chrome-extension setup documentation is deferred with the extension itself.

---

## 16. Build phases for V1 (master §50, §61 discipline)

Each phase is explained briefly, implemented, tested, fixed and integration-verified before the next
begins. No phase leaves a major feature as a placeholder, and no mock market data is used outside
tests (master §61).

| Phase | Content | Done when |
|---|---|---|
| **1** | Monorepo, TypeScript config, lint with module-boundary rules, CI skeleton, `packages/core` (Observation, Freshness, ProviderResult, scales, vocabularies, errors), `packages/config` with Zod env parsing, pino logging | Core types are unit-tested; CI is green; boot fails cleanly on a missing env var |
| **2** | Database: full V1 schema, migrations, the three-layer constraints and trigger, repositories, seed data (asset, macro series, news sources, default config profile) | Migrations apply and roll back; constraint violations are proved rejected by integration tests |
| **3** | Authentication: hashing, sessions, cookies, CSRF, rate limiting, lockout, password change, admin user CLI | Every auth flow tested including negative paths; login page works end to end |
| **4** | Provider abstraction: interfaces, registry, fallback, cache store, token bucket, circuit breaker, `provider_status`; ledger-driven job runner (`runDue`) with both the interval and HTTP triggers | Fallback and breaker behaviour proved with fakes; a job re-run is idempotent; the same job produces identical results under both triggers, proved by test |
| **5** | Economic calendar pipeline (FRED release dates + actuals, ForexFactory forecast feed) with dedupe, importance and surprise | Real events land in the database with dual provenance; degradation of the Tier 3 feed leaves the calendar working |
| **6** | News pipeline: HTTPS RSS collection (CDATA-safe), dedupe, classification, tagging, lexicon sentiment, credibility. F8 abstains until measured volume justifies it | Real articles land classified and scored; sentiment is reproducible across runs; a feed that returns 200 but parses to zero fails loudly; measured gold-relevant volume is recorded in LIMITS.md §6.8 |
| **7** | Macro and spot pipelines: FRED series with vintages, XAUUSD quote and daily closes, validation and anomaly quarantine | Real macro and price facts land with provenance and freshness |
| **8** | Fundamental engine: factors F1–F8, normalisation, aggregation with abstention, insufficiency rule, confidence engine, event risk. **Plus a freshness-classification audit (§13.4).** | Golden-fixture unit tests pass offline; a real end-to-end score is produced from live stored facts; the classification audit passes for all twelve series; F1 is proved not to abstain under normal conditions |
| **9** | Gemini integration: `AIProvider`, `GeminiProvider`, versioned prompts, schema, Zod validation, semantic guards, single retry, failure path, `analysis_statements` writing | All three AI paths tested; every semantic guard proved by a crafted response |
| **— CHECKPOINT —** | **Stop after phase 9 and demonstrate a working end-to-end run** before starting phases 10–12: real stored facts → deterministic score → schema-valid Gemini interpretation. A CLI dump or a rough page is sufficient; the point is proving the pipeline before UI, email and deploy work begins | Demonstrated to and acknowledged by the product owner |
| **10** | Dashboard: layout, verdict via `<ScoreDisplay>` with the A3 caveat, factor breakdown with provenance expanders, three-layer blocks, calendar and news panels with filters, system status, on-demand refresh | E2E passes; no value renders without reachable provenance; no score renders without its caveat |
| **11** | Daily report and email: report generation and immutable storage, `NotificationProvider`, `EmailProvider` (Resend + SMTP), templates, data-failure alert, report archive routes | A real email is delivered and its stored copy matches |
| **12** | Documentation, supervisor and proxy configuration, first real deploy on a permanently free tier, backup and restore rehearsal, security pass | The app is reachable over HTTPS on a real domain, running under a supervisor, and the runbook has been executed |

---

## 17. Definition of done for V1

1. Secure login, logout, password change, session expiry, rate limiting and lockout all work and are
   tested.
2. Economic calendar, news, macro and spot pipelines run on schedule, are idempotent, and record
   every provider attempt.
3. Provider fallback demonstrably yields `STALE` or `UNAVAILABLE` rather than a fabricated value,
   proved by an integration test with the primary provider disabled.
4. The deterministic fundamental engine produces a reproducible signed score for XAUUSD from eight
   weighted factors, each with direction, score, weight, confidence, sources, timestamps and an
   explanation, and abstains correctly when data is missing.
5. Confidence is computed independently of the score, with its caps enforced and tested.
6. Gemini returns schema-valid structured output; the corrective retry works; a double failure stores
   the failure and the UI shows the deterministic analysis under "AI ASSESSMENT UNAVAILABLE".
7. Every anti-hallucination semantic guard is individually proved by test.
8. FACT / INTERPRETATION / AI ASSESSMENT are enforced by database constraints and rendered as three
   visually distinct blocks.
9. Every displayed fact exposes source, source timestamp, retrieval time and freshness within one
   interaction.
10. The dashboard renders verdict, factors, three-layer analysis, calendar, news and system status
    from real data.
11. The daily report generates, stores immutably, is retrievable at a permanent URL, and is emailed
    successfully; a data-failure alert fires when a domain goes dark.
12. No secret reaches the frontend bundle; a build-output check asserts this.
13. CI is green across typecheck, lint, unit, integration, E2E, build and secret scan.
14. Documentation is complete and the application is deployed and reachable over HTTPS on a real
    domain.
15. No performance, win-rate or historical-accuracy claim appears anywhere in the product
    (Amendment A1).
16. Amendment A3 holds and is tested: every rendered score carries its descriptive caveat, the
    prohibited-claim guard rejects forecast language from the model on both the first attempt and the
    retry, and the repository copy check fails the build on forecast vocabulary in UI strings and
    email templates.

## 18. Out of scope, restated

No trade execution, no broker connection, no position management, ever in V1 (master §48). No paid
API dependency. No mock market data in any code path outside tests (master §61). No AI-authored
number, level, price, source or event.
