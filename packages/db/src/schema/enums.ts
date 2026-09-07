/**
 * Postgres enum types.
 *
 * Every enum mirrors a vocabulary declared in `@forex-agent/core`. The pairing is
 * asserted by a test, so adding a member in one place and forgetting the other
 * fails the build rather than surfacing as a constraint violation in production.
 */

import { pgEnum } from 'drizzle-orm/pg-core';

export const freshnessStatus = pgEnum('freshness_status', [
  'LIVE',
  'RECENT',
  'STALE',
  'UNAVAILABLE',
]);

/** Amendment A2. Order matters: lineage may only descend. */
export const statementLayer = pgEnum('statement_layer', [
  'FACT',
  'INTERPRETATION',
  'AI_ASSESSMENT',
]);

export const importanceLevel = pgEnum('importance_level', ['HIGH', 'MEDIUM', 'LOW']);

export const assetClass = pgEnum('asset_class', ['METAL', 'FX']);

export const seriesCadence = pgEnum('series_cadence', ['DAILY', 'WEEKLY', 'MONTHLY']);

export const newsCategory = pgEnum('news_category', [
  'MONETARY_POLICY',
  'INFLATION',
  'EMPLOYMENT',
  'ECONOMY',
  'GEOPOLITICS',
  'CENTRAL_BANKS',
  'GOVERNMENT_POLICY',
  'TRADE',
  'BANKING',
  'MARKET_SENTIMENT',
  'RISK_EVENTS',
  'OTHER',
]);

export const analysisMode = pgEnum('analysis_mode', [
  'FUNDAMENTAL',
  'QUICK',
  'FULL',
  'TECHNICAL_ONLY',
  'FULL_CONFLUENCE',
]);

export const biasDirection = pgEnum('bias_direction', ['BULLISH', 'BEARISH', 'NEUTRAL', 'MIXED']);

export const confidenceLevel = pgEnum('confidence_level', ['HIGH', 'MEDIUM', 'LOW']);

/** INSUFFICIENT_DATA is a first-class outcome, not an error (PRD_V1 8.5.4). */
export const analysisStatus = pgEnum('analysis_status', [
  'COMPLETE',
  'AI_UNAVAILABLE',
  'INSUFFICIENT_DATA',
]);

export const factorDirection = pgEnum('factor_direction', ['BULLISH', 'BEARISH', 'NEUTRAL']);

export const jobStatus = pgEnum('job_status', [
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'SKIPPED',
  'TIMED_OUT',
]);

export const breakerState = pgEnum('breaker_state', ['CLOSED', 'OPEN', 'HALF_OPEN']);

export const notificationChannel = pgEnum('notification_channel', [
  'EMAIL',
  'WHATSAPP',
  'TELEGRAM',
  'DISCORD',
]);

export const notificationStatus = pgEnum('notification_status', [
  'PENDING',
  'SENT',
  'FAILED',
  'SUPPRESSED',
]);

export const aiValidationOutcome = pgEnum('ai_validation_outcome', [
  'VALID',
  'VALID_AFTER_RETRY',
  'INVALID',
  'PROVIDER_ERROR',
]);
