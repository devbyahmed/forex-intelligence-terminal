# PRD — AI Trading Intelligence Terminal

## 1. Project Overview

Build a private AI-powered trading intelligence platform focused initially on:

- Gold / XAUUSD
- Forex pairs

The system combines:
1. Fundamental analysis
2. Technical analysis
3. News and market sentiment
4. Economic calendar/events
5. Historical market reactions
6. AI reasoning
7. Final bullish/bearish bias
8. Daily automated reports
9. On-demand analysis
10. Email notifications
11. Future WhatsApp notifications
12. Chrome extension

This is NOT an autonomous trading bot. It must NOT execute trades. It is a decision-support and market-research system.

Core question:
"What is happening in the market, why is it happening, what are fundamentals saying, what are technicals saying, and how strong is the overall setup?"

## 2. Product Format

Build:
- Main web application/dashboard
- Chrome extension

The web app is the primary product. The extension is a lightweight companion connected to the backend.

Initially intended for:
- Personal use
- A small number of trusted friends

Do NOT build SaaS/subscription functionality in V1.

## 3. Authentication

Implement secure login.

Initially use one private account, but architect authentication so additional users can be added later.

Requirements:
- Secure password hashing
- Secure sessions
- HTTP-only cookies
- CSRF protection where applicable
- Login rate limiting
- Brute-force protection
- Secure logout
- Password change
- Environment variables for secrets
- Never expose credentials/API keys to frontend
- Never expose API keys inside Chrome extension

Users must be able to access historical analyses.

## 4. Database

Use a proper relational database.

Store:
- Users
- Assets
- Market data
- Economic events
- Economic releases
- News articles
- News sentiment
- Fundamental factors
- Technical analysis
- Market analyses
- AI reports
- Scores
- Biases
- Confidence levels
- Historical market reactions
- Alerts
- Notification history
- API/provider status
- System logs

Every important analysis must be timestamped and retrievable.

## 5. Supported Assets

Initial priority:
- XAUUSD

Forex:
- EURUSD
- GBPUSD
- USDJPY
- USDCHF
- AUDUSD
- NZDUSD
- USDCAD

Architecture must allow additional assets later.

## 6. Fundamental Analysis Engine

Build a dedicated deterministic fundamental-analysis engine.

Do NOT allow the AI to simply guess a bullish/bearish direction.

First collect real structured data, calculate measurable factors, then send structured evidence to Gemini for interpretation.

Analyze:

### Macroeconomics
- Interest rates
- Central-bank policy
- Federal Reserve decisions
- ECB decisions
- BoE decisions
- BoJ decisions
- Inflation
- CPI
- Core CPI
- PPI
- Core PPI
- NFP
- Employment
- Unemployment
- GDP
- Retail sales
- PMI
- Consumer confidence
- Jobless claims
- Wage growth
- Economic growth
- Manufacturing data
- Services data

### Gold-specific factors
- USD strength/weakness
- Treasury yields
- Real yields where available
- Fed expectations
- Inflation expectations
- Interest-rate expectations
- Safe-haven demand
- Geopolitical risk
- Central-bank activity where reliable data is available
- Risk sentiment

### Forex-specific factors

Analyze relative fundamental strength of both currencies.

Example:
EURUSD = EUR strength VS USD strength.

## 7. Economic Calendar

Integrate reliable free economic-calendar sources/APIs.

Display:
- Event name
- Country
- Currency
- Date
- Time
- Importance
- Previous
- Forecast
- Actual
- Surprise
- Related asset
- Source
- Timestamp

Classify:
- HIGH
- MEDIUM
- LOW

Highlight high-impact events such as CPI, NFP, FOMC, Fed speeches, ECB and BoE decisions.

## 8. News Engine

Use multiple free news/data sources where legally and technically possible.

Do not depend on one source.

Pipeline:
1. Collect news
2. Remove duplicates
3. Identify relevant assets
4. Identify countries/currencies
5. Determine publication time
6. Analyze sentiment
7. Determine potential market impact
8. Assign source credibility
9. Store article/source reference

Categories:
- Monetary policy
- Inflation
- Employment
- Economy
- Geopolitics
- Central banks
- Government policy
- Trade
- Banking
- Market sentiment
- Risk events

Official government/central-bank sources receive highest credibility.

## 9. Free API Requirement

V1 must use FREE APIs/data sources only.

No paid API dependencies.

Use provider abstractions:
- MarketDataProvider
- NewsProvider
- EconomicCalendarProvider
- MacroDataProvider

Fallback:
Provider A → Provider B → Cached data → Clearly mark stale/unavailable.

NEVER fabricate missing data.

## 10. AI Engine

Use Google Gemini API as the initial runtime AI provider.

Architecture MUST be model-agnostic.

Create:
`AIProvider`
and:
`GeminiProvider`

Future providers may include:
- ClaudeProvider
- OpenAIProvider
- OtherProvider

Do not hard-code Gemini throughout the application.

Important:
Claude Pro is NOT an API subscription. Do not attempt to use a Claude Pro login as an API. Claude Pro can be used externally for development/review; Gemini API is the initial runtime AI provider.

## 11. AI Input

Gemini should receive structured evidence, not random raw internet content.

Inputs can include:
- Current price
- Market regime
- Economic data
- Economic surprises
- Upcoming events
- News
- News sentiment
- DXY
- Treasury yields
- Interest-rate expectations
- Fundamental scores
- Technical scores
- Market structure
- Liquidity
- FVG
- Order blocks
- BOS
- MSS
- RSI
- EMA
- ATR
- Previous highs/lows
- Session data
- Historical reactions

Gemini interprets the evidence rather than inventing it.

## 12. Fundamental Scoring

Create a deterministic fundamental score:

- +100 = extremely bullish
- +50 = bullish
- 0 = neutral
- -50 = bearish
- -100 = extremely bearish

Each factor contains:
- Direction
- Score
- Weight
- Confidence
- Source
- Timestamp
- Explanation

Example:
- USD weakness +18
- Lower yield expectations +15
- Dovish Fed expectations +20
- Geopolitical risk +10
- Inflation risk +5

Total = 68/100 bullish.

Weights must be configurable.

## 13. Technical Analysis Engine

Technical analysis is required in V1.

### Market Structure
- Higher High
- Higher Low
- Lower High
- Lower Low
- BOS
- MSS
- CHOCH

### Liquidity
- Equal highs
- Equal lows
- Previous day high/low
- Previous week high/low
- Session highs/lows
- Liquidity sweeps

### ICT/SMC
- Fair Value Gaps
- Order Blocks
- Breaker Blocks where objectively detectable
- Premium/Discount
- Displacement
- Liquidity grabs
- Market structure shifts

### Indicators
- EMA 20
- EMA 50
- EMA 100
- EMA 200
- RSI
- ATR
- Volume where reliable

Do not rely exclusively on indicators.

## 14. Multi-Timeframe Analysis

Support:
- 1m
- 5m
- 15m
- 1h
- 4h
- Daily

User can configure analyzed timeframes.

Determine higher-timeframe bias plus lower-timeframe confirmation.

Example:
Daily bullish
→ 4H bullish
→ 1H bullish
→ 15M bullish MSS
→ 5M liquidity sweep + FVG

## 15. Session Analysis

For Gold and Forex:
- Asian
- London
- New York

Track:
- Session high
- Session low
- Range
- Breakout
- Liquidity sweep

Session times must be timezone-aware and account for daylight-saving changes.

Do not hard-code Pakistan time into market calculations.

## 16. Technical Score

Create deterministic technical scoring.

Example:
- Market structure +20
- Liquidity +15
- MSS +15
- FVG +10
- Order block +10
- HTF alignment +15
- EMA alignment +5

Example total = 90/100 bullish.

Weights must be configurable.

## 17. Confluence Engine

Combine:
- Fundamental score
- Technical score
- News/sentiment
- Market regime

Example:
Fundamental 74
Technical 82
News 70
Market regime 80

Overall = 78/100.

Suggested classifications:
- 90-100 Extremely Bullish
- 75-89 Strong Bullish
- 60-74 Bullish
- 45-59 Neutral
- 30-44 Bearish
- 15-29 Strong Bearish
- 0-14 Extremely Bearish

Thresholds must be configurable.

## 18. Conflict Detection

If:
Fundamental = Bullish 78
Technical = Bearish 35

Do NOT simply output BUY.

Output:
- Overall Bias: MIXED
- Fundamentals: BULLISH
- Technicals: BEARISH
- Confidence: LOW/MEDIUM

Explain the conflict.

## 19. Final Output

Example:

XAUUSD

OVERALL BIAS:
BULLISH

CONFIDENCE:
HIGH

OVERALL SCORE:
78/100

FUNDAMENTAL:
74/100 BULLISH

TECHNICAL:
82/100 BULLISH

NEWS SENTIMENT:
70/100 BULLISH

KEY BULLISH FACTORS:
1. USD weakness
2. Lower yield expectations
3. Dovish Fed expectations
4. Strong technical structure

KEY BEARISH FACTORS:
1. Upcoming CPI
2. Resistance near key level

KEY EVENTS:
US CPI — 30 minutes
FOMC — 2 days

KEY TECHNICAL LEVELS:
- Support
- Resistance
- Liquidity
- FVG
- Order Block

INVALIDATION:
Clearly explain what would invalidate the thesis.

## 20. Buy/Sell Output

Possible outputs:
- BUY BIAS
- SELL BIAS
- NEUTRAL
- MIXED

This is decision support, not trade execution.

Clearly distinguish:
- Fundamental bias
- Technical bias
- Overall bias

Do not generate an entry unless sufficient technical confirmation exists.

## 21. Confidence Engine

Confidence must NOT simply equal score.

Base confidence on:
- Data completeness
- Source quality
- Agreement between factors
- Fundamental/technical agreement
- Number of supporting factors
- Conflicting factors
- Data freshness
- Historical consistency

Example:
HIGH confidence because most major factors agree, data is fresh, and multi-timeframe structure aligns.

## 22. Explanation and Source Flow

Every important conclusion must be traceable:

Factor
↓
Data
↓
Source
↓
Timestamp
↓
Interpretation
↓
Effect on score

Distinguish:
- FACT
- INTERPRETATION
- AI ASSESSMENT

## 23. Anti-Hallucination

AI must NEVER invent:
- Prices
- Economic data
- News
- Sources
- Historical results
- Forecasts
- Technical levels
- Market events

If unavailable:
DATA UNAVAILABLE

If stale:
STALE DATA — LAST UPDATED: X

Never fill missing information using AI assumptions.

## 24. Historical Analysis

Store historical market conditions.

Support questions such as:
- What happened to Gold after CPI came higher than expected?
- What usually happens to XAUUSD after dovish FOMC?
- How did Gold react to NFP surprises?
- How often did bullish fundamental + bullish technical confluence lead to positive movement?

Store:
- Event
- Expected
- Actual
- Surprise
- Pre-event price
- Post-event price
- 5-minute reaction
- 15-minute reaction
- 1-hour reaction
- 4-hour reaction
- Daily reaction

Only use reliable historical market data.

## 25. Backtesting

Architecture must support historical strategy testing.

Example:
- Fundamental score > 70
- Technical score > 70
- Bullish MSS
- Liquidity sweep

Calculate:
- Occurrences
- Win rate
- Average move
- Maximum adverse move
- Maximum favorable move
- Average R multiple
- Drawdown
- Time to target

Never claim performance without actual calculations.

## 26. Daily Automatic Report

Every day generate a market briefing.

Example:

DAILY MARKET OUTLOOK

XAUUSD
Bias: Bullish
Score: 78
Confidence: High

EURUSD
Bias: Neutral
Score: 55

GBPUSD
Bias: Bearish
Score: 42

Include:
- Fundamental drivers
- Important news
- Economic calendar
- Technical overview
- Key levels
- Upcoming risks
- Market sentiment
- AI explanation

Save the report.

## 27. On-Demand Analysis

Add an ANALYZE NOW button.

User selects:
- Asset
- Timeframe
- Analysis type

Modes:
- Quick Analysis
- Full Analysis
- Fundamental Only
- Technical Only
- Full Confluence

Retrieve fresh data before analysis.

## 28. Alert System

Implement email first.

Preferred provider: Resend, if its free tier/current API supports the required personal usage.

Create:
`NotificationProvider`

Then:
`EmailProvider`

Future:
- WhatsAppProvider
- TelegramProvider
- DiscordProvider

Do not tightly couple the application to Resend.

## 29. Email Alerts

Possible alerts:
- Daily briefing
- High-impact economic event
- Major market/news event
- Strong bullish setup
- Strong bearish setup
- Bias change
- Technical confirmation
- Data failure

Example:

URGENT MARKET ALERT

XAUUSD

Previous Bias: Neutral
New Bias: Strong Bullish
Score: 81/100

Reason:
USD weakness increased
+
Treasury yields declined
+
Bullish MSS confirmed
+
Liquidity sweep detected

Risk:
US CPI in 45 minutes

## 30. WhatsApp

Design notification architecture so WhatsApp can be added later.

Do not make WhatsApp mandatory for V1.

Do not use unofficial automation that risks account bans.

Use an official API/provider when implemented.

## 31. Dashboard UI

Use a professional dark trading-terminal interface.

Main dashboard:

MARKET OVERVIEW

| Asset | Fundamental | Technical | News | Overall | Bias | Confidence |
|---|---:|---:|---:|---:|---|---|
| XAUUSD | 74 | 82 | 70 | 78 | BULLISH | HIGH |
| EURUSD | 61 | 55 | 58 | 58 | NEUTRAL | MEDIUM |
| GBPUSD | 42 | 39 | 45 | 41 | BEARISH | MEDIUM |

Include:
- Fundamental drivers
- Technical structure
- Economic calendar
- Breaking news
- Upcoming events
- Key levels
- AI explanation
- Historical reactions

## 32. Asset Detail Page

For XAUUSD show:
1. Overall bias
2. Fundamental score
3. Technical score
4. News score
5. Confidence
6. Price
7. Chart
8. Market structure
9. Liquidity
10. FVG
11. Order blocks
12. Key levels
13. Economic events
14. News
15. AI explanation
16. Historical analysis
17. Invalidation conditions

## 33. News Page

Show:
- Latest news
- Asset
- Currency
- Importance
- Sentiment
- Source
- Timestamp

Filters:
- Asset
- Currency
- Importance
- Sentiment
- Time

## 34. Economic Calendar Page

Show:
- Date
- Time
- Country
- Currency
- Event
- Importance
- Previous
- Forecast
- Actual
- Surprise

Filters:
- Today
- Tomorrow
- This week
- Currency
- Impact

## 35. Historical Reports

Store previous reports.

Filters:
- Asset
- Date
- Bias
- Score
- Confidence

Clicking a report must open the complete analysis as it existed at that time.

## 36. Chrome Extension

Build a Chrome extension connected to the backend.

Features:
- Login/session
- Current asset detection where possible
- Quick analysis
- Fundamental score
- Technical score
- Overall bias
- Confidence
- Key reasons
- Link to full dashboard

Example:

XAUUSD
BULLISH
78/100
Fundamental: 74
Technical: 82
Confidence: HIGH

[VIEW FULL ANALYSIS]

Never put API keys in the extension.

## 37. Charting

Use a suitable charting library.

Display:
- Candlesticks
- EMA
- FVG
- Order blocks
- Liquidity levels
- Previous highs/lows
- Session ranges
- BOS
- MSS

Technical drawings must come from the technical-analysis engine.

Do not allow AI to arbitrarily draw structures.

## 38. Data Freshness

Every data object should include:
- created_at
- updated_at
- source
- source_timestamp
- retrieved_at

Status:
- LIVE
- RECENT
- STALE
- UNAVAILABLE

Make status visible.

## 39. Caching

Cache:
- Economic calendar
- News
- Market data
- Macro data

Use appropriate cache durations.

Real-time price data should have a short cache. Economic data can have a longer cache.

## 40. API Rate Limits

Implement:
- Rate-limit detection
- Retry logic
- Exponential backoff
- Provider fallback
- Caching
- Error logging

Never continuously retry an unavailable API.

## 41. Error Handling

Gracefully handle:
- API failure
- Invalid API key
- Rate limits
- Missing data
- Network failure
- AI failure
- Database failure
- Provider failure

Never expose secrets or sensitive server errors.

## 42. Logging

Implement structured logging.

Log:
- API requests
- Provider failures
- AI requests
- AI failures
- Data ingestion
- Analysis generation
- Authentication events
- Notification events
- System errors

Never log:
- Passwords
- API keys
- Tokens
- Sensitive authentication data

## 43. AI Prompt Architecture

Do not put one enormous prompt in the frontend.

Create versioned backend prompts:
- fundamental_analysis_v1
- technical_analysis_v1
- confluence_analysis_v1
- daily_report_v1

Prefer structured JSON output internally.

## 44. AI Response Schema

Use a schema similar to:

```json
{
  "asset": "",
  "timestamp": "",
  "fundamental_score": 0,
  "technical_score": 0,
  "news_score": 0,
  "overall_score": 0,
  "fundamental_bias": "",
  "technical_bias": "",
  "overall_bias": "",
  "confidence": "",
  "bullish_factors": [],
  "bearish_factors": [],
  "conflicting_factors": [],
  "key_events": [],
  "key_levels": [],
  "invalidation_conditions": [],
  "explanation": "",
  "sources": []
}
```

Validate AI output before saving.

If invalid, retry once with correction instructions.

If still invalid, return an error rather than storing malformed analysis.

## 45. Source Credibility

Create tiers:

### Tier 1
- Official government
- Central banks
- Official economic agencies

### Tier 2
- Major established financial data/news providers

### Tier 3
- Other reputable financial publications

### Tier 4
- Unverified sources

Do not treat social-media claims as confirmed facts.

## 46. Market Regime

Create a market-regime engine.

Possible regimes:
- Risk-on
- Risk-off
- Trending
- Ranging
- High volatility
- Low volatility
- Uncertain

Use measurable market information where available.

Market regime should influence confidence and interpretation.

## 47. Important Event Risk

Detect situations such as:
- CPI in 20 minutes
- NFP in 45 minutes
- FOMC today

Warn:
"High event risk — current technical setup may be invalidated by upcoming fundamental release."

This should affect confidence.

## 48. No Automated Trading

V1 must NOT:
- Place trades
- Modify trades
- Connect to broker for execution
- Manage positions automatically

Execution may be considered later.

## 49. Technology

Choose a modern, stable technology stack.

Prioritize:
- Reliability
- Maintainability
- Security
- Low cost
- Free/open-source tooling
- Easy local development
- Easy deployment
- Strong TypeScript/Python ecosystem where appropriate

Do not over-engineer.

## 50. Development Approach

Build in phases.

Do NOT generate the entire application blindly in one step.

### Phase 1
Project setup, database, authentication, configuration, provider abstractions

### Phase 2
Market-data pipeline

### Phase 3
Economic-calendar pipeline

### Phase 4
News pipeline

### Phase 5
Fundamental engine

### Phase 6
Technical engine

### Phase 7
Confluence engine

### Phase 8
Gemini AI integration

### Phase 9
Dashboard

### Phase 10
Historical analysis

### Phase 11
Daily reports

### Phase 12
Email notifications

### Phase 13
Chrome extension

### Phase 14
Testing and security hardening

## 51. Testing

Implement proper tests.

### Unit tests
- Fundamental scoring
- Technical detection
- Market structure
- FVG detection
- Order block detection
- Liquidity detection
- Confluence
- Confidence
- Event classification

### Integration tests
- APIs
- Database
- Gemini
- Authentication
- Notifications

### End-to-end
Login → Dashboard → Analyze asset → Generate report → Save report → View history

## 52. Data Validation

Validate:
- Data types
- Timestamps
- Missing values
- Impossible values
- Duplicate events
- Duplicate news
- Price anomalies

Flag suspicious data.

## 53. Security

Requirements:
- HTTPS in production
- Secure cookies
- Password hashing
- Input validation
- SQL injection protection
- XSS protection
- CSRF protection
- Rate limiting
- CORS configuration
- Secure headers
- API authentication
- Secret management
- No secrets in Git
- No secrets in frontend
- No secrets in Chrome extension

Create `.env.example` but never commit real secrets.

## 54. Environment Variables

Use environment variables for all secrets.

Examples:

```env
GEMINI_API_KEY=
DATABASE_URL=
SESSION_SECRET=
RESEND_API_KEY=
NEWS_API_KEY=
MARKET_DATA_API_KEY=
```

Only include variables for APIs actually selected.

## 55. Documentation

Create:
- README.md
- ARCHITECTURE.md
- API.md
- DATABASE.md
- SECURITY.md

README must cover:
- Architecture
- Setup
- Installation
- Environment variables
- Database setup
- API setup
- Gemini setup
- Local development
- Testing
- Deployment
- Chrome extension setup
- Troubleshooting

## 56. API Design

Example endpoints:

```text
POST /auth/login
POST /auth/logout
GET  /auth/me

GET  /assets
GET  /market-data/:asset
GET  /news
GET  /economic-calendar

GET  /analysis/:asset
POST /analysis/:asset

GET  /reports
GET  /reports/:id

GET  /historical/:asset

GET  /alerts
POST /alerts
```

Improve the exact structure where appropriate.

## 57. Configuration

Make configurable:
- Supported assets
- Timeframes
- Fundamental weights
- Technical weights
- Confluence weights
- Confidence thresholds
- News credibility
- Alert thresholds
- Event importance
- Cache duration
- Data freshness thresholds

Do not bury important settings in source code.

## 58. Responsible Output

Every analysis must distinguish:

FACT  
INTERPRETATION  
AI ASSESSMENT

Example:

FACT:
US CPI was X.

INTERPRETATION:
This may increase/decrease rate expectations.

AI ASSESSMENT:
This currently supports Gold.

## 59. Final User Experience

Opening the application should immediately show:

TODAY'S MARKET OUTLOOK

XAUUSD
BULLISH — 78
HIGH CONFIDENCE

EURUSD
NEUTRAL — 56
MEDIUM CONFIDENCE

GBPUSD
BEARISH — 43
MEDIUM CONFIDENCE

Clicking XAUUSD opens the complete reasoning.

The user should not need to manually collect dozens of economic inputs.

## 60. Core Architecture Principle

```text
RAW DATA
    ↓
VALIDATION
    ↓
NORMALIZATION
    ↓
DETERMINISTIC ANALYSIS
    ↓
FUNDAMENTAL + TECHNICAL SCORES
    ↓
CONFLUENCE
    ↓
GEMINI REASONING
    ↓
VALIDATED STRUCTURED OUTPUT
    ↓
USER INTERFACE
    ↓
HISTORICAL STORAGE
    ↓
NOTIFICATIONS
```

Do NOT reverse this process.

Do not let Gemini invent underlying data.

## 61. Important Development Instruction

Act as the senior software architect and engineer.

Do not merely provide explanations or pseudo-code.

Build the actual working application.

Before each major component:
1. Explain implementation plan briefly.
2. Implement it.
3. Test it.
4. Fix errors.
5. Verify integration.
6. Move to the next component.

Do not leave major features as placeholders unless absolutely necessary.

If an API cannot provide a required feature for free, identify the limitation and implement the best available free alternative.

Never fake functionality.

Never use mock market data in production logic. Mocks may only be used for automated tests.

## 62. Definition of Done

V1 is complete only when:

- Secure login works.
- Dashboard works.
- XAUUSD analysis works.
- Forex analysis works.
- Fundamental data is collected.
- News is collected.
- Economic calendar works.
- Technical analysis works.
- SMC/ICT concepts are objectively detected where possible.
- Multi-timeframe analysis works.
- Fundamental score works.
- Technical score works.
- Confluence score works.
- Conflict detection works.
- Gemini produces structured reasoning.
- Sources are visible.
- Historical reports are stored.
- Daily report works.
- On-demand analysis works.
- Email alerts work.
- Chrome extension connects securely.
- API keys remain private.
- Errors are handled.
- Tests pass.
- Documentation is complete.

## 63. Final Goal

The final product should feel like a private AI-powered trading intelligence terminal.

It should answer:

WHAT IS HAPPENING?

WHY IS IT HAPPENING?

WHAT ARE THE FUNDAMENTALS SAYING?

WHAT ARE THE TECHNICALS SAYING?

ARE THEY IN AGREEMENT?

WHAT IS THE CURRENT BIAS?

HOW STRONG IS THE BIAS?

WHAT COULD INVALIDATE IT?

WHAT IMPORTANT EVENTS ARE COMING?

WHAT HAPPENED HISTORICALLY IN SIMILAR CONDITIONS?

Save all of this so the user can review and improve trading decisions over time.

Do not build an autonomous trading bot.

Build a reliable, transparent, evidence-based AI trading intelligence system.
