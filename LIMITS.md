# LIMITS — free-tier resource budget

**This is a living document.** Storage and compute are hard architectural limits on this project, not
deployment trivia. Every version that adds a data source, a job, or a provider **must update this
file as part of its definition of done**. A version is not complete until its entry here is current.

The point is to see a ceiling coming *before* it is hit — a database that fills up silently is a data
loss event, and a compute budget exhausted on day 16 is an outage for the rest of the month.

| Field | Meaning |
|---|---|
| **Cap** | The hard limit the free tier grants |
| **Projected** | What the system is expected to consume at the current design |
| **Headroom** | Cap minus projected |
| **Breached by** | The specific change that would exceed the cap |

- **Last reviewed:** 2026-08-30 (Phase 7 of V1)
- **Deployment profile:** primary — Neon + Vercel Hobby + GitHub Actions cron
- **Provider free-tier figures verified:** 2026-08-30 (`ARCHITECTURE.md` §14.2)

---

## 1. Database storage — Neon free

**Cap: 0.5 GB.** Exceeding it makes writes fail; it does not degrade gracefully.

| Consumer | V1 projected | Notes |
|---|---|---|
| `provider_responses` (raw payload archive) | **~120 MB steady state** | The dominant consumer. Bounded by a **14-day retention window**, pruned daily. Without that window this alone would exceed the cap within about three months. |
| `news_articles` + `news_sentiment` | ~150 MB/year | ~200 articles/day. Bodies stored **truncated** (canonical URL retained for full text), which is what keeps this from tripling. |
| `macro_observations` | **~3 MB/year** | 12 series with revision vintages. **Measured Phase 7: 2,385 rows for 400 days of history, of which 225 are revisions (9%).** Revisions are new rows, never overwrites, so the table grows with republication as well as time — still negligible against the cap. |
| `market_candles` (daily only in V1) | < 1 MB/year | One asset, one timeframe. |
| `market_quotes` | ~2 MB/year | One asset at the 15-min tick, gated to market hours (~120h/week), so roughly 480 rows/week. |
| `economic_events` + `economic_releases` | < 5 MB/year | A few hundred releases a year. |
| `analyses` + `evidence_bundle` snapshots | **~35 MB/year** | Hourly analyses, each storing a full JSON evidence snapshot for reproducibility (`PRD_V1.md` §9.5). Watch this: it grows with analysis frequency, not with data volume. |
| `job_runs`, `system_logs`, `provider_status` | ~20 MB/year | `system_logs` needs its own retention window before V4. |
| `sessions`, `login_attempts`, `audit_events` (Phase 3) | **< 5 MB/year** | Single user, a handful of logins a day. All three are pruned: sessions past their absolute cap plus a grace window, attempt history past the rate-limit window. Worth noting that `login_attempts` is the one table an *attacker* can grow — a sustained credential-stuffing run writes a row per attempt. The per-IP limiter caps the rate, and the prune job bounds the total, but if the app is ever exposed to broad traffic this is the row count to watch. |
| Indexes | ~30% of table size | Budgeted in the total below. |

**V1 total projected: ~400 MB in year one, ~250 MB steady state after pruning.**
**Headroom: thin but adequate — roughly 20%.**

### Breach conditions

| Change | Effect | Status |
|---|---|---|
| **V2 intraday candles across six timeframes** | **Would breach.** 1m candles alone are ~1,440 rows/day/asset ≈ 50 MB/year with indexes; all six timeframes for one asset ≈ 75 MB/year, and **×8 assets in V4 ≈ 600 MB/year — over the cap by itself.** | ⚠️ **Open. Must be resolved before V2 starts.** Options: retain 1m/5m for a rolling window only (e.g. 30 days) and keep 15m+ indefinitely; or move to the VM profile; or drop 1m entirely. |
| Removing the `provider_responses` retention window | +~40 MB/month, unbounded | Blocked by design |
| Storing full article bodies | roughly ×3 on news storage | Blocked by design |
| V4's eight assets | ×8 on candles and analyses | ⚠️ Must be re-projected during V4 planning |
| V5 historical backfill | Depends on depth of history retained | ⚠️ Must be projected before V5 starts |

---

## 2. Database compute — Neon free

**Cap: 100 CU-hours/month.** Minimum compute is 0.25 CU, so the practical ceiling is ~400
compute-hours against 730 hours in a month. Compute suspends after 5 idle minutes and wakes on
connection — so **job cadence, not query cost, is what drives this number.**

| Cadence | DB awake | CU-hours/month | Verdict |
|---|---|---|---|
| Every 5 min | ~100% | ~182 | ✗ Exhausts the month around day 16 |
| **Every 15 min (chosen)** | **~35%** | **~67** | ✓ Fits, ~33% headroom |
| Every 30 min | ~20% | ~36 | ✓ Comfortable |

**Projected: ~67 CU-hours/month. Headroom: ~33 CU-hours.**

### Breach conditions

- Tightening the ingestion tick below 15 minutes.
- Adding a second independent schedule that wakes compute between ticks — **this is why ingestion is
  consolidated into one tick rather than several per-domain schedules.**
- **Human page loads also wake compute.** Each authenticated request costs one session
  query (see §2.1 below). At realistic single-user traffic this is negligible beside the
  scheduled tick, but it means the database is never idle while someone is actively using
  the dashboard.
- Long-running analytical queries that keep compute active (relevant from V5 onward).

### 2.1 Per-request session and rate-limit lookups against a scale-to-zero database

Flagged during Phase 3, assessed, and **deliberately not optimised yet**.

Every authenticated request needs session state, and every login attempt needs
rate-limit state. Both must come from Postgres — a serverless target has no process
memory to cache them in, and a cached lockout that resets on cold start is not a
lockout. So the floor is one round trip per authenticated request.

What that actually costs on the primary target:

| Situation | Cost | Assessment |
|---|---|---|
| Warm database, session lookup | ~10–40 ms, one query | Negligible |
| **Cold database (idle > 5 min)** | **~500 ms–3 s wake-up on the first request** | The real user-visible cost |
| Login (rate-limit + user + session write) | 3–4 queries | Acceptable; only on login |
| Connection count | 1 per concurrent invocation | Irrelevant at single-user traffic; Neon's pooler handles far more |

**Design choices already made that address this:**

- Session validation is a **single query** joining sessions to users and evaluating
  revocation, idle expiry, absolute cap, activation and epoch together — not three
  or four round trips, each of which would pay the cold-start penalty separately.
- The sliding-expiry refresh is **throttled to once per hour**, so a normal request
  is a read with no write.
- Rate-limit counting happens **in SQL**, not by fetching attempt rows and counting
  in the application — which matters most precisely when under attack.

**What is deliberately not done, and why:**

A stateless signed session assertion — a short-lived JWT alongside the opaque token —
would let most requests skip the database entirely. It is rejected because it would
make revocation take effect only at the assertion's expiry rather than immediately.
For a single-user private tool, a sub-second cold start is a smaller cost than a
revoked session that stays live for another minute.

**Verdict: not worth solving now.** The cold-start wait is a once-per-visit UX cost
for one user, not a correctness or capacity problem. Revisit if the tool ever serves
several people concurrently, or if the dashboard becomes chatty enough that the
per-request query count matters — at which point the fix is request-scoped memoisation
within a single invocation, not caching across them.

---

## 3. Database egress — Neon free

**Cap: 5 GB/month.** Projected: well under 1 GB (the app and worker are co-located with small row
counts). Not currently a concern; re-check at V4 when eight assets multiply query volume.

---

## 4. Scheduling — GitHub Actions

**Cap: unlimited minutes (public repository).** Were the repository private, the cap would be
2,000 minutes/month and **each run bills rounded up to a whole minute**, making a 15-minute tick
(2,880 runs/month) impossible. The repository being public is therefore a load-bearing decision, not
a preference.

- Minimum schedule interval: **5 minutes** (we use 15).
- Public-repo schedules are **silently disabled after 60 days of repository inactivity** — a commit or
  a manual run resets it. Worth knowing before a quiet month looks like an outage.

---

## 5. Application hosting — Vercel Hobby

| Resource | Cap | Projected | Notes |
|---|---|---|---|
| Function duration | 300 s | Each tick well under | Jobs are chunked; a tick that cannot finish defers remaining work to the next one |
| Function memory | 2 GB | Low | |
| Cron | 1/day | Not used | Scheduling comes from GitHub Actions instead |
| Terms | **Non-commercial only** | Compliant — private personal tool | ⚠️ Would need revisiting if this ever became commercial |

---

## 6. Provider API quotas and reachability

**Empirically tested 2026-08-30 (Phase 4)** — every row below reflects an actual
call, not a documentation claim. Entries marked *needs key* could not be exercised
because no credential is available and account creation is out of scope.

| Provider | Verified status | V1 projected | Verdict |
|---|---|---|---|
| **Fed RSS** ×4 (press, monetary, speeches, testimony) | ✅ **200**, conditional GET returns **304 / 0 bytes** | 96 conditional GETs/feed/day | Backbone of the news chain |
| **ECB press RSS** | ✅ 200, `application/rss+xml` | 96/day | Working |
| **Bank of England RSS** | ✅ 200, 25 KB | 96/day | Working |
| **Bank of Japan RSS** (English) | ✅ 200 | 96/day | Working |
| **BEA RSS** (`apps.bea.gov`) | ✅ 200 | 96/day | **Added** — restores US GDP/income coverage |
| **Census economic indicators** | ✅ 200 | 96/day | **Added** — restores retail sales/trade |
| **ForexFactory weekly feed** | ✅ 200, 110 events parsed, 15 HIGH-impact. ⚠️ **Returns 429 under repeated polling** despite documenting no limit | 6/day | Working; supplies time + forecast + importance. See §6.7 |
| **FRED** | ✅ **Key verified.** All 12 seeded series return data. 429 observed at ~120 cumulative req/min | ~350–400/day, peak ~12/min | ✓ Large headroom — see §6.2 |
| **Gemini** | ✅ **Key verified.** `responseSchema` works exactly as specified. ~10 RPM before 429 | ~30–40/day | ✓ But default model changed — see §6.3 |
| **Twelve Data** | ✅ **Key verified. `XAU/USD` IS available on Basic, and it is genuine spot.** 1 credit/symbol/call | 96 credits/day at the 15-min tick (12% of cap) | ✓ V1 fine; **V2 breaches** — see §6.1, §6.4 |
| **Resend** | ⚠️ Reachable, 401 without key | 2–5/day | **Needs key** (Phase 11) |
| **Yahoo `GC=F`** | ✅ 200, confirms `FUTURE` / COMEX / USD | 96/day | Working — **futures, not spot** |
| ~~GDELT~~ | ❌ **Rejected** — HTTPS fails from two TLS stacks, HTTP-only. See §6.5 | — | Out. No plaintext transport in the news chain |
| ~~BLS RSS~~ | ❌ **403** on all four candidate paths | — | **Removed from seed** |
| ~~US Treasury RSS~~ | ❌ **404**, feed retired, no replacement found | — | **Removed from seed** |
| ~~Nasdaq Data Link `LBMA/GOLD`~~ | ❌ **403** Incapsula bot challenge, HTML not JSON | — | **Not viable as a fallback** |

### 6.1 Twelve Data — settled: XAU/USD works, and it is spot

Verified 2026-08-30 with the registered Basic key.

```
/price?symbol=XAU/USD   → HTTP 200  {"price":"4458.78588"}
/quote?symbol=XAU/USD   → HTTP 200  name "Gold Spot / US Dollar", exchange "Forex",
                                     is_market_open: true
```

**It is genuine spot, not futures.** Twelve Data quoted 4458.79 against Yahoo `GC=F`
at 4529.90 in the same window — the ~71 gap is the futures basis. This matters: the
market-data chain now has a real **`SPOT`** primary with a **`FUTURES_PROXY`**
fallback, rather than only a proxy.

**Credit economics, measured against `/api_usage` before and after:**

| Call | Credits |
|---|---|
| `/price` or `/quote`, one symbol | **1** |
| `/time_series`, `outputsize=100` | **1** |
| `/time_series`, `outputsize=500` (500 bars returned) | **1** |
| `/price` with 3 comma-separated symbols | **3** (1 per symbol) |

**The cost is per symbol per call, and is independent of how many bars come back.**
Fetching 500 bars costs the same as fetching one — which is the single most important
fact for V2 planning.

Per-minute limit confirmed: 12 concurrent `/price` calls returned **2×200, 10×429**
against a documented 8/min. The 429 body names the limit explicitly and
`api-credits-left` drops to 0. **429s do not consume daily credits** (9 used, not 12),
so the token bucket only needs to protect the daily budget.

### 6.2 FRED — observed limits

- **All 12 seeded series exist and return data.** Verified individually.
- **`releases/dates` and `release/dates` work as the calendar pipeline assumes**:
  fields `release_id, release_name, release_last_updated, date`; upcoming CPI dates
  returned as 2026-09-11, 10-14, 11-10, 12-10. `series/release` maps `CPIAUCSL` → release 10.
- ⚠️ **FRED gives dates, never times.** The design assumed FRED was authoritative for
  "when"; it is authoritative for the **date** only. Scheduled *times* (CPI at 08:30 ET)
  must come from ForexFactory or a curated schedule. Recorded in `PRD_V1.md` §8.2.
- ⚠️ `releases/dates` returns **3,378 upcoming dates** across all releases — the
  calendar job must filter to the ~20 releases that matter, not ingest the lot.
- **ALFRED vintages work exactly as the macro pipeline expects.** `output_type=1` with
  a realtime range returns one row per vintage with `realtime_start`/`realtime_end`,
  mapping directly onto the `vintage` column. Confirmed with a real revision: June
  payrolls 158,984 → 158,881.
- **Rate limit observed:** 20 and 40 request bursts all returned 200; an 80-request
  burst (≈140 cumulative in ~5 s) returned 60×200, 17×429, 3×403. Consistent with
  ~120 req/min.
- ⚠️ **429 carries no `Retry-After` header** — backoff must be exponential rather than
  header-driven. Our client already does this.
- ⚠️ **403 also appears under load**, alongside 429. We deliberately keep 403
  non-retryable, because it is also the legitimate "invalid key" response and retrying
  a bad key three times wastes quota. At ~12 req/min peak against a ~120/min limit this
  is not a practical risk.

### 6.3 Gemini — verified, and the configured model had to change

**`responseSchema` behaves exactly as the AI layer's design requires.** With a schema
mirroring `fundamental_analysis_v1`:

- Response parses as JSON directly — **no markdown fence, no prose wrapper**
- `propertyOrdering` respected; enums respected (`BULLISH`, `MEDIUM`, factor ids
  constrained to F1–F8)
- **Engine values copied exactly** (42 / BULLISH / MEDIUM) — nothing invented
- `fact_refs` cited only ids present in the bundle
- `data_gaps` correctly drawn from the bundle's UNAVAILABLE line
- 241 prompt / 424 output tokens — negligible

**But the configured default model was unusable.** Availability sampled 4× each:

| Model | Available | Note |
|---|---|---|
| `gemini-3.7-flash` | **0/4** — 503 every time | Was our configured default |
| `gemini-3.6-flash` | 4/4 ✓ | `responseSchema` verified; ~33 s latency |
| `gemini-3.5-flash` | 4/4 ✓ | `responseSchema` verified; ~8 s latency |
| `gemini-3.5-flash-lite` | 4/4 ✓ | |
| `gemini-2.5-flash` | **0/4** — 404 | **Listed by the models endpoint but not callable** |

Default changed to **`gemini-3.5-flash`**, fallback **`gemini-3.6-flash`** — both
verified working, 3.5 being markedly faster. `gemini-3.7-flash` should be promoted when
it stabilises; because model ids are configuration rather than constants, that is a
one-line change.

Two traps worth recording: a model appearing in `/models` **does not mean it is
callable** (2.5-flash 404s), and the newest stable Flash model is the *least* available
on the free tier.

**Rate limit observed:** 15 concurrent minimal calls → 7×200, 8×429, quota-exceeded
message. Consistent with ~10 RPM. Our usage is ~30–40 calls/day with no bursting.

⚠️ **Free-tier model availability is unstable and must be re-verified each version.**
This is not a one-off configuration finding. Within a single session the newest stable
Flash model was unavailable on every attempt while two older ones were perfectly
reliable, and a third model was advertised by the API but not callable. Treat the
model list as a claim, not a fact.

Consequences, now built into the design rather than left as a note:

- The AI provider **falls back to the configured alternate on 503/404 within the same
  analysis**, records which model actually answered on the `ai_generations` row, and
  surfaces the fallback on the system status panel (`PRD_V1.md` §8.8).
- **Every version re-runs the availability check** as part of its definition of done,
  the same way provider free tiers are re-verified. A model that worked last version is
  evidence, not a guarantee.

### 6.4 ⚠️ Twelve Data credits — the V2/V4 breach, now quantified

At **1 credit per symbol per timeframe per call** against **800/day**:

| Scenario | Calls/tick | Credits/day (96 ticks) | vs 800 cap |
|---|---|---|---|
| **V1: 1 asset, quote only** | 1 | **96** | ✓ 12% |
| V2: 1 asset, 6 timeframes | 6 | 576 | ⚠️ 72% |
| V2 + V4: 8 assets, 1 timeframe | 8 | 768 | ⚠️ 96% — no headroom |
| **V2 + V4: 8 assets × 6 timeframes** | 48 | **4,608** | ❌ **5.8× over cap** |

**V1 is comfortable. V2 is tight for one asset and V4 is impossible at this cadence.**

The measured fact that makes this solvable: **`outputsize` is free.** One
`/time_series` call returns 500 bars for 1 credit. So the fix is to fetch only the
*lowest* timeframe and aggregate upward locally — 500× 5-minute bars is ~41 hours of
history, enough to derive 15m, 1h, 4h and 1d without further calls. That turns
8 assets × 6 timeframes into 8 calls per tick:

| Mitigation | Credits/day | vs cap |
|---|---|---|
| 8 assets, fetch 5m only + aggregate, 15-min tick | 768 | 96% — still no headroom |
| 8 assets, fetch 5m only + aggregate, **30-min tick** | **384** | ✓ **48%** |
| 8 assets, candles on a 30-min tick + quotes on 15-min | 768 | 96% |

**DECIDED (2026-08-30), so V2 starts from a decision rather than a rediscovery:**

> **V2 fetches only the lowest required timeframe per asset and aggregates upward
> locally, on a 30-minute candle cadence.**

- One `/time_series` call per asset per tick, `outputsize=500` — ~41 hours of 5-minute
  history for 1 credit.
- 15m, 1h, 4h and 1d are **derived in code** from those bars, not fetched. Aggregation
  is a pure function over the candle array and belongs in `packages/engines`, so it is
  unit-testable against fixtures with no provider involved.
- Quotes stay on the 15-minute tick (1 credit each); candles move to 30 minutes.
- Budget: 8 assets × 48 candle ticks = **384 credits/day (48% of cap)**, plus quotes.

Two consequences to carry into V2 planning: aggregated bars must be **marked as
derived** in `market_candles` rather than presented as vendor-supplied, and a
partial trailing bar must never be aggregated into a closed higher-timeframe candle —
that is the classic off-by-one that silently corrupts a technical engine.

### 6.5 GDELT — rejected (HTTPS is broken)

`https://api.gdeltproject.org` fails from two independent TLS stacks (curl/schannel:
connection never establishes; Node/OpenSSL: `ECONNRESET`, then connect timeout).
`http://` to the same host returns HTTP 200 in ~3 s, consistently across three
samples, with well-formed JSON.

**Decision (2026-08-30): rejected.** Using it would mean ingesting news over plaintext
HTTP — no transport integrity, so a network-level attacker could alter headline text in
transit. It is Tier 2/3 breadth and never a scoring input on its own, but needing more
volume is not a reason to weaken provenance. Volume comes from Tier 2/3 publisher feeds
over HTTPS instead (§6.8).

**Enforced structurally**, not by convention: a test asserts every seeded news feed URL
begins with `https://`, which keeps out GDELT and any future HTTP-only source.

### 6.6 Market-data chain — now has a verified spot primary

Resolved by the Phase 5 key verification. **Twelve Data `XAU/USD` works on Basic and
is genuine spot** (§6.1), so the chain is now:

1. **Twelve Data `XAU/USD`** — Tier 2, `SPOT`, verified
2. **Yahoo `GC=F`** — Tier 3, `FUTURES_PROXY`, verified, labelled as futures
3. ~~Nasdaq Data Link~~ — blocked by bot protection, removed

Two working members with different instrument kinds. The V1 position is unchanged and
still safe: **no V1 fundamental factor consumes price data**, so a total market-data
outage degrades the displayed price to `UNAVAILABLE` while the score still computes.
What V2 needs is not a *working* provider but *enough credits* — see §6.4.

---

### 6.7 ForexFactory rate limiting — undocumented but real

Observed during Phase 5: after roughly eight requests in quick succession while
debugging, the feed began returning **HTTP 429** and kept returning it for several
minutes. It documents no rate limit at all.

Consequences:

- The provider declares `requestsPerDay: 200` so the registry's token bucket applies,
  and the scheduled cadence is 6/day — nowhere near the threshold. **Normal operation
  is unaffected**; this was self-inflicted by repeated manual probing.
- It is a reminder that the Tier 3 feed is a courtesy, not a contract. The pipeline is
  built to run without it: with the feed down, FRED alone still produces the calendar,
  losing only the scheduled time, the consensus forecast and the importance hint.
  **Verified working** — a FRED-only run wrote 35 releases with curated importance
  applied and zero unattributed rows.
- Anyone debugging against the live feed should expect to be throttled and use fixtures
  instead.

---

### 6.8 ⚠️ News volume — measured, and F8 stays dark

**Re-measured 2026-08-30 after adding Tier 2 feeds, using the real pipeline** — the
same parser, relevance and sentiment code the ingestion job runs.

**Feeds seeded: 12 (9 Tier 1, 3 Tier 2). Parse yield 100% on every feed.**

| Tier | Feed | 72h items | gold-relevant | with sentiment |
|---|---|---|---|---|
| 1 | Fed — Press Releases | 1 | 1 | 0 |
| 1 | Fed — Monetary Policy | 0 | 0 | 0 |
| 1 | Fed — Speeches | 1 | 1 | 0 |
| 1 | Fed — Testimony | 0 | 0 | 0 |
| 1 | ECB — Press | 2 | 0 | 0 |
| 1 | Bank of England | 1 | 0 | 0 |
| 1 | Bank of Japan | 1 | 0 | 0 |
| 1 | BEA | 0 | 0 | 0 |
| 1 | Census — Indicators | 3 | 0 | 0 |
| 2 | MarketWatch — Top Stories | 10 | 0 | 0 |
| 2 | CNBC — Economy | 3 | 2 | 0 |
| 2 | CNBC — Finance | 10 | 3 | 2 |

| Measure | Value |
|---|---|
| Gold-relevant articles, 72h | **7** (0 cross-feed duplicates) |
| Gold-relevant per day | **2.3** |
| Carrying a sentiment term | **2** → **0.7/day** |
| **Expected in the 48h scoring window** | **1.3** |
| **F8 threshold** | **10 articles, 2 distinct sources** |
| **Does F8 clear?** | **NO — 1.3 against 10** |

**F8 stays dark. That is the measurement, not a conclusion.**

Adding three Tier 2 feeds raised gold-relevant volume from ~0.5/day to ~2.3/day — a
real improvement, and still an order of magnitude below what a sentiment mean needs.
The pipeline measures this window on every run, so F8 activates if and only if volume
genuinely reaches the threshold. Nothing switches it on manually.

**Two caveats on the number, stated rather than smoothed over:**

1. **The window includes a weekend** — measured on a Sunday, with markets closed.
   Weekday volume is higher. Even at three times this rate the window would hold about
   four articles against a threshold of ten.
2. **Relevance and sentiment signal are not the same thing.** Only 2 of 7 relevant
   articles carried any lexicon term. Official central-bank headlines are deliberately
   toneless: "Bank Rate maintained at 3.75%" is highly relevant and contains no
   sentiment vocabulary at all. **The most authoritative sources are the least
   sentiment-bearing** — a structural property of the domain, not a lexicon gap. It is
   also the reason not to chase the threshold by loosening the lexicon, which would
   manufacture signal out of neutral wording.

**Candidate feeds dropped, and why**

| Candidate | Outcome |
|---|---|
| Yahoo Finance | **Terms.** "only permitted to display the content that is provided in the feed, **without modification**". Sentiment scoring and use as AI evidence exceed display. Dropped despite being the highest-volume candidate (~143/day). |
| Investing.com (Economy, Commodities) | **Terms unverifiable** — ToS returns 403 to every client. Cannot confirm the feed is legally consumable. |
| FXStreet | **Dropped — terms unverifiable.** ToS pages return 404, so there is no way to confirm the feed is legally consumable. Unverifiable terms is a real disqualifier, not a technicality. It was the best candidate by relevance (83% gold-relevant, ~12/day), but even adding it would not have brought F8 near its threshold. **Revisit only if a legitimate sentiment use case emerges** and its terms can be confirmed. |
| MarketWatch — RealTime | **Dead.** Newest item 1.2 years old. |
| St. Louis Fed, NY Fed | Return HTML, not a feed. |
| IMF, Trading Economics, Mining.com | HTTP 403. |
| BIS, Kitco | HTTP 404. |
| US Treasury | Timeout (404 on earlier attempts). |

**Survivors passed all four gates**: HTTPS reachable, 100% parse yield, publishing at a
useful rate, and terms permitting this use. Dow Jones terms explicitly permit
"individual, personal and non-commercial use" of RSS content — a permission that lapses
if this ever becomes commercial, the same caveat as Vercel Hobby. CNBC's terms of
service, read in full, contain no RSS restriction: a verified absence rather than an
unverifiable one.

**Volume is now a monitored quantity, not a one-time check.** The ingestion job records
relevant-article counts per run, so a feed dying shows up as falling volume and F8
abstains again automatically. A feed returning 200 but parsing to zero throws rather
than reporting an empty day.

---


### 6.9 ⚠️ Release surprises — no historical consensus exists on a free tier

**Measured 2026-09-01.** Ingested 400 days of the economic calendar: **197 releases,
78 with a forecast, and zero forecasts older than eight days.**

| | count |
|---|---|
| Releases stored | 197 |
| Releases in the past | 196 |
| With a forecast value | 78 |
| **With a forecast older than 8 days** | **0** |
| With an actual value | 0 |
| With a standardised surprise (`surprise_z`) | 0 |

The two calendar sources fail in complementary ways, and neither gap is closable:

- **ForexFactory** carries consensus forecasts but its feed is a rolling **one-week
  window**. Every forecast we hold is from the current week; nothing older is
  retrievable, now or ever, because the feed simply does not expose it.
- **FRED** supplies release *dates* going back years — which is why `Consumer Price
  Index` shows 13 releases and `Unemployment Rate` 12 — but publishes **no consensus
  forecast at all**. Its release-dates endpoint is a schedule, not a survey.

Historical consensus is a paid product at every vendor checked. There is no free
source, so this is not a routing problem.

**Consequence.** `surprise = actual − forecast` needs both halves, and `surprise_z`
needs at least twelve past surprises to standardise against. We can accumulate at most
one surprise per release per month going forward, so **CPI and payroll surprises become
usable after roughly twelve months of continuous operation, and not before.**

Until then:

| Factor | Sub-signal lost | Input completeness | Effective weight |
|---|---|---|---|
| F5 Inflation | CPI surprise (the rate channel, 0.6 of the net rule) | 0.5 | 0.045 of 0.09 |
| F6 Growth and employment | NFP surprise | 0.75 | 0.075 of 0.10 |

**This is attributable to the world, not to our configuration** (PRD_V1 §8.5.3a), so
it is genuine degradation rather than a defect wearing an abstention's clothes — the
data does not exist to be fetched. It is recorded here because the distinction is only
meaningful if the world-attributable cases are written down too; an undocumented
permanent gap becomes indistinguishable from a defect within a month of nobody
remembering why it is there.

It does mean F5's published reading currently reflects **only** the inflation-hedge
channel, with the opposing rate channel absent. That is a material qualification on
what the factor measures, not merely on how much it weighs, and the UI must say so.

**Open decision (see §7).** Whether to (a) run with the reduced completeness as
above, (b) redefine F5 and F6 so full completeness means "everything obtainable", or
(c) abstain both factors entirely until surprise history accrues. Option (b) makes
completeness honest but changes what F5 measures; (c) forfeits two working factors
over a missing sub-signal.

### 6.10 Resend — verified, and the quota is shared with another project

**Measured 2026-09-06 against the live API.** Two real sends succeeded from
`onboarding@resend.dev` to the account signup address.

| Observation | Value |
|---|---|
| Send response | HTTP 200 with `{ id }` |
| Rate limit headers | `ratelimit-limit: 10`, `ratelimit-reset: 1` — **10 requests per second** |
| `GET /domains` | **401** — this key is scoped to sending only |
| Sending identity | `onboarding@resend.dev` (sandbox sender) |
| Delivery | Account signup address only |

**The account is shared with an unrelated project that owns a verified domain, and the
free-tier allowance is per account.** Resend's free tier is 100 emails/day and
3,000/month, and that budget is *shared*: this project's sends reduce what the other
project can send, and vice versa.

V1 sends **one report a day**, so the ceiling is not a constraint. It is recorded
because the shape of the constraint is easy to forget: a future digest, an alert
fan-out, or a per-user report in V4 would consume a budget this project does not
control, and would degrade someone else's project when it did.

**The restricted sending path is deliberate.** The account's verified domain belongs to
the other project. Sending as that domain would borrow its reputation, its DMARC
alignment and its bounce history for mail this project generated — and **Resend will
not prevent it**, because the API cannot tell which project issued a request. The guard
is therefore ours: `checkSendingIdentity` allows exactly one sender address and refuses
anything else *before* any network call, with a message that explains whose reputation
is at stake rather than merely stating a rule.

Verified in both directions on 2026-09-06:

- valid configuration → `SENT`, message id returned;
- a custom sending domain → `REFUSED`, **no network call made**, and the fallback
  chain **stopped** rather than delivering the same message over SMTP;
- blocked recipient → `REFUSED` on the same terms.

The misconfigured case is verified by unit test rather than by a live attempt.
Confirming it empirically would mean actually sending from the other project's domain —
performing the exact action the guard exists to prevent, where the observation costs the
thing being protected.

**If this project ever needs its own sending domain**, verify one on a *separate* Resend
account and update `PERMITTED_FROM_ADDRESS` with that decision recorded. Widening the
check to make a config change work would reintroduce precisely this hazard.

### 6.11 Neon — verified on the real instance, and compute is shared

**Measured 2026-09-06** against the production project (`us-east-1`, PostgreSQL
**17.11**), through the **pooled** endpoint.

Two design decisions rested on facts that had not been observed on this instance. Both
now have been:

**1. The WebSocket driver gives real interactive transactions.** The HTTP driver was
rejected because Amendment A2 lineage writes must commit atomically. Verified by running
a two-statement transaction that throws: **0 rows survived the rollback**, and a
committed transaction persisted both rows. Under the HTTP driver's per-statement
autocommit the first insert would have survived.

**2. `pg_advisory_xact_lock` genuinely holds through PgBouncer.** Session-scoped
advisory locks silently do nothing in transaction pooling mode — *silently* being the
problem, since a lock that does nothing looks exactly like one that works. Verified with
two concurrent transactions contending for one key:

```
  480ms  A acquired
 1214ms  B requesting          <- B blocks here
 1986ms  A releasing (commit)
 2810ms  B acquired            <- only after A committed
```

B waited for A. A fresh transaction then re-acquired the same key immediately, and
`pg_locks` showed **zero** advisory locks outstanding afterwards — so the lock releases
at commit rather than leaking to whichever tenant next borrows that backend.

**Compute is per account, not per project.** The Neon free tier's 100 CU-hours/month
allowance is shared with another project on the same account, as is the 0.5 GB storage
ceiling per branch. The §4 tick projection therefore needs reading as *this project's
share of a shared budget*, not as the whole of it:

| | This project (projected) | Account allowance | Note |
|---|---|---|---|
| Compute | ~8–12 CU-hours/month at a 15-minute tick with scale-to-zero after 5 min | 100 CU-hours | shared with one other project |
| Storage | ~90 MB at V1 retention | 0.5 GB | per branch |

The headroom is large enough that sharing is not a risk at V1 volumes. It becomes one if
the tick interval shortens, if scale-to-zero stops taking effect because something polls
continuously, or if the other project's usage grows — none of which this project can
observe from inside. **The 15-minute tick and the 5-minute suspend are therefore load-
bearing for a budget we do not solely control**, which is a stronger reason to keep them
than the original one.
## 7. Open items requiring a decision

1. **Twelve Data credit budget (⚠️ blocking V2).** 8 assets × 6 timeframes = 4,608 credits/day
   against an 800 cap — 5.8× over. Known fix: fetch the lowest timeframe only and aggregate upward
   (`outputsize` is free), at a 30-minute candle cadence → 384/day. Needs a decision before V2 —
   see §6.4.
2. **News volume (open until re-measured).** The nine Tier 1 feeds yield ~0.5 gold-relevant
   articles/day — too few for a sentiment score, so **F8 abstains**. **Decided 2026-08-30:** add
   Tier 2/3 publisher RSS **over HTTPS only**. F8 stays dark until measured volume justifies it;
   adding feeds does not switch it on — the pipeline's own measurement does. See §6.8.
4. **V2 intraday candle retention (⚠️ blocking V2).** Six timeframes against a 0.5 GB cap does not
   fit at eight assets. A decision is needed before V2 begins: rolling windows per timeframe, fewer
   timeframes, or the VM profile.
5. **`system_logs` retention.** Unbounded today. Needs a window before V4.
6. **`analyses` snapshot growth.** Each analysis stores a full evidence bundle. If analysis frequency
   rises, this becomes a primary consumer; consider compressing older snapshots.

## 8. The alternative profile

On an always-on VM (Oracle Cloud Always Free or similar) every constraint in this document relaxes:
200 GB of storage instead of 0.5 GB, no compute-hour budget, no cadence floor, unrestricted retention.
The code and schema are identical — only configuration changes. **Every "would breach" row above
becomes a non-issue under that profile**, which is why it is documented as a supported upgrade path
in `ARCHITECTURE.md` §14.3 rather than abandoned.
