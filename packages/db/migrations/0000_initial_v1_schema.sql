CREATE TYPE "public"."ai_validation_outcome" AS ENUM('VALID', 'VALID_AFTER_RETRY', 'INVALID', 'PROVIDER_ERROR');--> statement-breakpoint
CREATE TYPE "public"."analysis_mode" AS ENUM('FUNDAMENTAL', 'QUICK', 'FULL', 'TECHNICAL_ONLY', 'FULL_CONFLUENCE');--> statement-breakpoint
CREATE TYPE "public"."analysis_status" AS ENUM('COMPLETE', 'AI_UNAVAILABLE', 'INSUFFICIENT_DATA');--> statement-breakpoint
CREATE TYPE "public"."asset_class" AS ENUM('METAL', 'FX');--> statement-breakpoint
CREATE TYPE "public"."bias_direction" AS ENUM('BULLISH', 'BEARISH', 'NEUTRAL', 'MIXED');--> statement-breakpoint
CREATE TYPE "public"."breaker_state" AS ENUM('CLOSED', 'OPEN', 'HALF_OPEN');--> statement-breakpoint
CREATE TYPE "public"."confidence_level" AS ENUM('HIGH', 'MEDIUM', 'LOW');--> statement-breakpoint
CREATE TYPE "public"."factor_direction" AS ENUM('BULLISH', 'BEARISH', 'NEUTRAL');--> statement-breakpoint
CREATE TYPE "public"."freshness_status" AS ENUM('LIVE', 'RECENT', 'STALE', 'UNAVAILABLE');--> statement-breakpoint
CREATE TYPE "public"."importance_level" AS ENUM('HIGH', 'MEDIUM', 'LOW');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED', 'TIMED_OUT');--> statement-breakpoint
CREATE TYPE "public"."news_category" AS ENUM('MONETARY_POLICY', 'INFLATION', 'EMPLOYMENT', 'ECONOMY', 'GEOPOLITICS', 'CENTRAL_BANKS', 'GOVERNMENT_POLICY', 'TRADE', 'BANKING', 'MARKET_SENTIMENT', 'RISK_EVENTS', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('EMAIL', 'WHATSAPP', 'TELEGRAM', 'DISCORD');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('PENDING', 'SENT', 'FAILED', 'SUPPRESSED');--> statement-breakpoint
CREATE TYPE "public"."series_cadence" AS ENUM('DAILY', 'WEEKLY', 'MONTHLY');--> statement-breakpoint
CREATE TYPE "public"."statement_layer" AS ENUM('FACT', 'INTERPRETATION', 'AI_ASSESSMENT');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"event_type" text NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"detail" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"ip_address" "inet",
	"succeeded" boolean NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" "inet",
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"display_name" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"session_epoch" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"name" text NOT NULL,
	"asset_class" "asset_class" NOT NULL,
	"base_currency" text NOT NULL,
	"quote_currency" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"is_active" boolean DEFAULT false NOT NULL,
	"config" jsonb NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "currencies" (
	"code" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_importance_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"country" text NOT NULL,
	"event_pattern" text NOT NULL,
	"importance" "importance_level" NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "macro_series" (
	"id" uuid PRIMARY KEY NOT NULL,
	"series_id" text NOT NULL,
	"provider" text DEFAULT 'fred' NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"unit" text NOT NULL,
	"cadence" "series_cadence" NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_sources" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"feed_url" text NOT NULL,
	"homepage_url" text,
	"tier" smallint NOT NULL,
	"publisher" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_etag" text,
	"last_modified" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"job_name" text NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"status" "job_status" NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"duration_ms" integer,
	"items_processed" integer DEFAULT 0 NOT NULL,
	"error_code" text,
	"error_message" text,
	"triggered_by" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_runs_finished_after_started" CHECK ("job_runs"."finished_at" is null or "job_runs"."started_at" is null or "job_runs"."finished_at" >= "job_runs"."started_at")
);
--> statement-breakpoint
CREATE TABLE "provider_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"payload" jsonb NOT NULL,
	"provenance" jsonb NOT NULL,
	"stored_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_responses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider_id" text NOT NULL,
	"operation" text NOT NULL,
	"request_url" text,
	"http_status" integer,
	"payload_hash" text NOT NULL,
	"payload" jsonb,
	"duration_ms" integer,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_status" (
	"provider_id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"tier" smallint NOT NULL,
	"breaker" "breaker_state" DEFAULT 'CLOSED' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_success_at" timestamp with time zone,
	"last_failure_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"breaker_opened_at" timestamp with time zone,
	"quota_used_today" integer DEFAULT 0 NOT NULL,
	"quota_limit_daily" integer,
	"quota_reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "economic_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"country" text NOT NULL,
	"currency" text NOT NULL,
	"name" text NOT NULL,
	"normalised_name" text NOT NULL,
	"importance" "importance_level" NOT NULL,
	"importance_is_curated" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "economic_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"scheduled_local_time" text,
	"previous_value" numeric(24, 8),
	"actual_value" numeric(24, 8),
	"actual_reported_at" timestamp with time zone,
	"forecast_value" numeric(24, 8),
	"forecast_source_provider" text,
	"forecast_source_name" text,
	"forecast_source_url" text,
	"forecast_source_tier" integer,
	"forecast_retrieved_at" timestamp with time zone,
	"surprise" numeric(24, 8),
	"surprise_z" real,
	"unit" text,
	"source_provider" text NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text,
	"source_tier" smallint NOT NULL,
	"source_timestamp" timestamp with time zone NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"freshness" "freshness_status" NOT NULL,
	"quality_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "economic_releases_source_tier_valid" CHECK ("economic_releases"."source_tier" between 1 and 4),
	CONSTRAINT "economic_releases_retrieved_after_source" CHECK ("economic_releases"."retrieved_at" >= "economic_releases"."source_timestamp" - interval '1 hour'),
	CONSTRAINT "economic_releases_forecast_tier_valid" CHECK ("economic_releases"."forecast_source_tier" is null or "economic_releases"."forecast_source_tier" between 1 and 4),
	CONSTRAINT "economic_releases_forecast_provenanced" CHECK ("economic_releases"."forecast_value" is null
        or ("economic_releases"."forecast_source_provider" is not null and "economic_releases"."forecast_source_tier" is not null))
);
--> statement-breakpoint
CREATE TABLE "macro_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"series_row_id" uuid NOT NULL,
	"observation_date" date NOT NULL,
	"value" numeric(24, 8),
	"vintage" timestamp with time zone NOT NULL,
	"source_provider" text NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text,
	"source_tier" smallint NOT NULL,
	"source_timestamp" timestamp with time zone NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"freshness" "freshness_status" NOT NULL,
	"quality_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "macro_observations_source_tier_valid" CHECK ("macro_observations"."source_tier" between 1 and 4),
	CONSTRAINT "macro_observations_retrieved_after_source" CHECK ("macro_observations"."retrieved_at" >= "macro_observations"."source_timestamp" - interval '1 hour')
);
--> statement-breakpoint
CREATE TABLE "market_candles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"asset_id" uuid NOT NULL,
	"timeframe" text NOT NULL,
	"open_time" timestamp with time zone NOT NULL,
	"open" numeric(20, 8) NOT NULL,
	"high" numeric(20, 8) NOT NULL,
	"low" numeric(20, 8) NOT NULL,
	"close" numeric(20, 8) NOT NULL,
	"volume" numeric(24, 8),
	"instrument_kind" text NOT NULL,
	"source_provider" text NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text,
	"source_tier" smallint NOT NULL,
	"source_timestamp" timestamp with time zone NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"freshness" "freshness_status" NOT NULL,
	"quality_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_candles_source_tier_valid" CHECK ("market_candles"."source_tier" between 1 and 4),
	CONSTRAINT "market_candles_retrieved_after_source" CHECK ("market_candles"."retrieved_at" >= "market_candles"."source_timestamp" - interval '1 hour'),
	CONSTRAINT "market_candles_ohlc_coherent" CHECK ("market_candles"."high" >= "market_candles"."low"
        and "market_candles"."high" >= "market_candles"."open" and "market_candles"."high" >= "market_candles"."close"
        and "market_candles"."low" <= "market_candles"."open" and "market_candles"."low" <= "market_candles"."close"
        and "market_candles"."low" > 0)
);
--> statement-breakpoint
CREATE TABLE "market_quotes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"asset_id" uuid NOT NULL,
	"price" numeric(20, 8) NOT NULL,
	"instrument_kind" text NOT NULL,
	"provider_symbol" text,
	"source_provider" text NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text,
	"source_tier" smallint NOT NULL,
	"source_timestamp" timestamp with time zone NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"freshness" "freshness_status" NOT NULL,
	"quality_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_quotes_source_tier_valid" CHECK ("market_quotes"."source_tier" between 1 and 4),
	CONSTRAINT "market_quotes_retrieved_after_source" CHECK ("market_quotes"."retrieved_at" >= "market_quotes"."source_timestamp" - interval '1 hour'),
	CONSTRAINT "market_quotes_price_positive" CHECK ("market_quotes"."price" > 0)
);
--> statement-breakpoint
CREATE TABLE "news_article_assets" (
	"article_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"currency" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "news_articles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"canonical_url" text NOT NULL,
	"content_hash" text NOT NULL,
	"title" text NOT NULL,
	"summary" text,
	"published_at" timestamp with time zone NOT NULL,
	"category" "news_category" DEFAULT 'OTHER' NOT NULL,
	"classifier_version" text NOT NULL,
	"source_provider" text NOT NULL,
	"source_name" text NOT NULL,
	"source_url" text,
	"source_tier" smallint NOT NULL,
	"source_timestamp" timestamp with time zone NOT NULL,
	"retrieved_at" timestamp with time zone NOT NULL,
	"freshness" "freshness_status" NOT NULL,
	"quality_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_articles_source_tier_valid" CHECK ("news_articles"."source_tier" between 1 and 4),
	CONSTRAINT "news_articles_retrieved_after_source" CHECK ("news_articles"."retrieved_at" >= "news_articles"."source_timestamp" - interval '1 hour')
);
--> statement-breakpoint
CREATE TABLE "news_sentiment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"article_id" uuid NOT NULL,
	"polarity" real NOT NULL,
	"positive_count" integer DEFAULT 0 NOT NULL,
	"negative_count" integer DEFAULT 0 NOT NULL,
	"matched_terms" text[] DEFAULT '{}'::text[] NOT NULL,
	"method_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "news_sentiment_polarity_range" CHECK ("news_sentiment"."polarity" between -1 and 1)
);
--> statement-breakpoint
CREATE TABLE "ai_generations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"analysis_id" uuid,
	"provider_id" text NOT NULL,
	"model" text NOT NULL,
	"prompt_name" text NOT NULL,
	"prompt_version" text NOT NULL,
	"outcome" "ai_validation_outcome" NOT NULL,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"validation_errors" jsonb,
	"guard_version" text,
	"raw_response" jsonb,
	"prompt_tokens" integer,
	"response_tokens" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analyses" (
	"id" uuid PRIMARY KEY NOT NULL,
	"asset_id" uuid NOT NULL,
	"mode" "analysis_mode" NOT NULL,
	"status" "analysis_status" NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"config_profile_id" uuid NOT NULL,
	"fundamental_score" real,
	"news_score" real,
	"technical_score" real,
	"overall_score" real,
	"fundamental_bias" "bias_direction",
	"technical_bias" "bias_direction",
	"overall_bias" "bias_direction",
	"confidence" "confidence_level",
	"confidence_score" real,
	"confidence_breakdown" jsonb,
	"coverage" real,
	"regime" text,
	"evidence_bundle" jsonb,
	"unavailable_inputs" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analyses_fundamental_score_range" CHECK ("analyses"."fundamental_score" is null or "analyses"."fundamental_score" between -100 and 100),
	CONSTRAINT "analyses_news_score_range" CHECK ("analyses"."news_score" is null or "analyses"."news_score" between -100 and 100),
	CONSTRAINT "analyses_technical_score_range" CHECK ("analyses"."technical_score" is null or "analyses"."technical_score" between -100 and 100),
	CONSTRAINT "analyses_overall_score_range" CHECK ("analyses"."overall_score" is null or "analyses"."overall_score" between -100 and 100),
	CONSTRAINT "analyses_coverage_range" CHECK ("analyses"."coverage" is null or "analyses"."coverage" between 0 and 1),
	CONSTRAINT "analyses_insufficient_has_no_score" CHECK ("analyses"."status" <> 'INSUFFICIENT_DATA' or "analyses"."fundamental_score" is null)
);
--> statement-breakpoint
CREATE TABLE "analysis_statements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"analysis_id" uuid NOT NULL,
	"layer" "statement_layer" NOT NULL,
	"ordinal" integer NOT NULL,
	"body" text NOT NULL,
	"fact_table" text,
	"fact_id" uuid,
	"source_provider" text,
	"source_name" text,
	"source_url" text,
	"source_tier" smallint,
	"source_timestamp" timestamp with time zone,
	"retrieved_at" timestamp with time zone,
	"freshness" "freshness_status",
	"derived_from" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"ai_generation_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fact_requires_provenance" CHECK ("analysis_statements"."layer" <> 'FACT' or (
        "analysis_statements"."fact_table" is not null and "analysis_statements"."fact_id" is not null
        and "analysis_statements"."source_provider" is not null and "analysis_statements"."source_name" is not null
        and "analysis_statements"."source_tier" is not null and "analysis_statements"."source_timestamp" is not null
        and "analysis_statements"."retrieved_at" is not null and "analysis_statements"."freshness" is not null
      )),
	CONSTRAINT "fact_has_no_derivation" CHECK ("analysis_statements"."layer" <> 'FACT' or cardinality("analysis_statements"."derived_from") = 0),
	CONSTRAINT "derived_requires_parents" CHECK ("analysis_statements"."layer" = 'FACT' or cardinality("analysis_statements"."derived_from") >= 1),
	CONSTRAINT "ai_requires_generation" CHECK ("analysis_statements"."layer" <> 'AI_ASSESSMENT' or "analysis_statements"."ai_generation_id" is not null),
	CONSTRAINT "non_ai_has_no_generation" CHECK ("analysis_statements"."layer" = 'AI_ASSESSMENT' or "analysis_statements"."ai_generation_id" is null),
	CONSTRAINT "statement_source_tier_valid" CHECK ("analysis_statements"."source_tier" is null or "analysis_statements"."source_tier" between 1 and 4)
);
--> statement-breakpoint
CREATE TABLE "fundamental_factors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"analysis_id" uuid NOT NULL,
	"factor_id" text NOT NULL,
	"factor_name" text NOT NULL,
	"direction" "factor_direction" NOT NULL,
	"score" real,
	"raw_signal" jsonb,
	"z_score" real,
	"weight" real NOT NULL,
	"effective_weight" real NOT NULL,
	"confidence" real NOT NULL,
	"freshness" "freshness_status" NOT NULL,
	"explanation" text NOT NULL,
	"fact_refs" jsonb NOT NULL,
	"abstained_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "fundamental_factors_score_range" CHECK ("fundamental_factors"."score" is null or "fundamental_factors"."score" between -100 and 100),
	CONSTRAINT "fundamental_factors_weight_range" CHECK ("fundamental_factors"."weight" between 0 and 1),
	CONSTRAINT "fundamental_factors_confidence_range" CHECK ("fundamental_factors"."confidence" between 0 and 1),
	CONSTRAINT "fundamental_factors_abstain_coherent" CHECK (("fundamental_factors"."abstained_reason" is null and "fundamental_factors"."score" is not null)
        or ("fundamental_factors"."abstained_reason" is not null and "fundamental_factors"."score" is null and "fundamental_factors"."effective_weight" = 0))
);
--> statement-breakpoint
CREATE TABLE "alert_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"rule_type" text NOT NULL,
	"channel" "notification_channel" DEFAULT 'EMAIL' NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cooldown_seconds" integer DEFAULT 3600 NOT NULL,
	"last_fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"alert_rule_id" uuid,
	"report_id" uuid,
	"channel" "notification_channel" NOT NULL,
	"status" "notification_status" DEFAULT 'PENDING' NOT NULL,
	"template_name" text NOT NULL,
	"subject" text,
	"recipient" text NOT NULL,
	"provider_message_id" text,
	"provider_id" text,
	"error_code" text,
	"error_message" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"suppressed_reason" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_assets" (
	"report_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"analysis_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"report_date" text NOT NULL,
	"kind" text DEFAULT 'DAILY_BRIEFING' NOT NULL,
	"title" text NOT NULL,
	"content_html" text NOT NULL,
	"content_text" text NOT NULL,
	"payload" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_quality_incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"subject_table" text NOT NULL,
	"subject_id" text,
	"provider_id" text,
	"flag" text NOT NULL,
	"detail" text NOT NULL,
	"observed_value" jsonb,
	"resolved_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_logs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"level" text NOT NULL,
	"event" text NOT NULL,
	"message" text NOT NULL,
	"correlation_id" text,
	"context" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_base_currency_currencies_code_fk" FOREIGN KEY ("base_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_quote_currency_currencies_code_fk" FOREIGN KEY ("quote_currency") REFERENCES "public"."currencies"("code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "economic_releases" ADD CONSTRAINT "economic_releases_event_id_economic_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."economic_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "macro_observations" ADD CONSTRAINT "macro_observations_series_row_id_macro_series_id_fk" FOREIGN KEY ("series_row_id") REFERENCES "public"."macro_series"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_candles" ADD CONSTRAINT "market_candles_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_quotes" ADD CONSTRAINT "market_quotes_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_article_assets" ADD CONSTRAINT "news_article_assets_article_id_news_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_article_assets" ADD CONSTRAINT "news_article_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "news_sentiment" ADD CONSTRAINT "news_sentiment_article_id_news_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."news_articles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_generations" ADD CONSTRAINT "ai_generations_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analyses" ADD CONSTRAINT "analyses_config_profile_id_config_profiles_id_fk" FOREIGN KEY ("config_profile_id") REFERENCES "public"."config_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_statements" ADD CONSTRAINT "analysis_statements_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_statements" ADD CONSTRAINT "analysis_statements_ai_generation_id_ai_generations_id_fk" FOREIGN KEY ("ai_generation_id") REFERENCES "public"."ai_generations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fundamental_factors" ADD CONSTRAINT "fundamental_factors_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD CONSTRAINT "alert_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_alert_rule_id_alert_rules_id_fk" FOREIGN KEY ("alert_rule_id") REFERENCES "public"."alert_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_assets" ADD CONSTRAINT "report_assets_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_assets" ADD CONSTRAINT "report_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_assets" ADD CONSTRAINT "report_assets_analysis_id_analyses_id_fk" FOREIGN KEY ("analysis_id") REFERENCES "public"."analyses"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_user_time_idx" ON "audit_events" USING btree ("user_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_events_type_time_idx" ON "audit_events" USING btree ("event_type","occurred_at");--> statement-breakpoint
CREATE INDEX "login_attempts_identifier_time_idx" ON "login_attempts" USING btree ("identifier","attempted_at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_time_idx" ON "login_attempts" USING btree ("ip_address","attempted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_idx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "assets_symbol_idx" ON "assets" USING btree ("symbol");--> statement-breakpoint
CREATE UNIQUE INDEX "config_profiles_name_idx" ON "config_profiles" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "config_profiles_single_active_idx" ON "config_profiles" USING btree ("is_active") WHERE "config_profiles"."is_active";--> statement-breakpoint
CREATE UNIQUE INDEX "event_importance_country_pattern_idx" ON "event_importance_rules" USING btree ("country","event_pattern");--> statement-breakpoint
CREATE UNIQUE INDEX "macro_series_provider_series_idx" ON "macro_series" USING btree ("provider","series_id");--> statement-breakpoint
CREATE UNIQUE INDEX "news_sources_feed_url_idx" ON "news_sources" USING btree ("feed_url");--> statement-breakpoint
CREATE INDEX "news_sources_tier_idx" ON "news_sources" USING btree ("tier");--> statement-breakpoint
CREATE UNIQUE INDEX "job_runs_name_slot_idx" ON "job_runs" USING btree ("job_name","scheduled_for");--> statement-breakpoint
CREATE INDEX "job_runs_name_time_idx" ON "job_runs" USING btree ("job_name","scheduled_for" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "job_runs_status_idx" ON "job_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "provider_cache_expires_at_idx" ON "provider_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "provider_responses_provider_time_idx" ON "provider_responses" USING btree ("provider_id","retrieved_at");--> statement-breakpoint
CREATE INDEX "provider_responses_retrieved_at_idx" ON "provider_responses" USING btree ("retrieved_at");--> statement-breakpoint
CREATE UNIQUE INDEX "provider_responses_hash_operation_idx" ON "provider_responses" USING btree ("payload_hash","operation");--> statement-breakpoint
CREATE INDEX "provider_status_domain_idx" ON "provider_status" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "economic_events_unique_idx" ON "economic_events" USING btree ("country","normalised_name");--> statement-breakpoint
CREATE INDEX "economic_releases_source_timestamp_idx" ON "economic_releases" USING btree ("source_timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "economic_releases_unique_idx" ON "economic_releases" USING btree ("event_id","scheduled_at");--> statement-breakpoint
CREATE INDEX "economic_releases_scheduled_idx" ON "economic_releases" USING btree ("scheduled_at");--> statement-breakpoint
CREATE INDEX "macro_observations_source_timestamp_idx" ON "macro_observations" USING btree ("source_timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "macro_observations_unique_idx" ON "macro_observations" USING btree ("series_row_id","observation_date","vintage");--> statement-breakpoint
CREATE INDEX "macro_observations_series_date_idx" ON "macro_observations" USING btree ("series_row_id","observation_date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "market_candles_source_timestamp_idx" ON "market_candles" USING btree ("source_timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "market_candles_unique_idx" ON "market_candles" USING btree ("asset_id","timeframe","open_time","source_provider");--> statement-breakpoint
CREATE INDEX "market_candles_asset_tf_time_idx" ON "market_candles" USING btree ("asset_id","timeframe","open_time" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "market_quotes_source_timestamp_idx" ON "market_quotes" USING btree ("source_timestamp");--> statement-breakpoint
CREATE INDEX "market_quotes_asset_time_idx" ON "market_quotes" USING btree ("asset_id","source_timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "news_article_assets_pk" ON "news_article_assets" USING btree ("article_id","asset_id");--> statement-breakpoint
CREATE INDEX "news_article_assets_asset_idx" ON "news_article_assets" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "news_articles_source_timestamp_idx" ON "news_articles" USING btree ("source_timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "news_articles_canonical_url_idx" ON "news_articles" USING btree ("canonical_url");--> statement-breakpoint
CREATE INDEX "news_articles_content_hash_idx" ON "news_articles" USING btree ("content_hash");--> statement-breakpoint
CREATE INDEX "news_articles_published_idx" ON "news_articles" USING btree ("published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "news_articles_category_published_idx" ON "news_articles" USING btree ("category","published_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "news_sentiment_article_method_idx" ON "news_sentiment" USING btree ("article_id","method_version");--> statement-breakpoint
CREATE INDEX "ai_generations_analysis_idx" ON "ai_generations" USING btree ("analysis_id");--> statement-breakpoint
CREATE INDEX "ai_generations_outcome_idx" ON "ai_generations" USING btree ("outcome");--> statement-breakpoint
CREATE INDEX "analyses_asset_run_idx" ON "analyses" USING btree ("asset_id","run_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "analyses_status_idx" ON "analyses" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_statements_order_idx" ON "analysis_statements" USING btree ("analysis_id","layer","ordinal");--> statement-breakpoint
CREATE INDEX "analysis_statements_analysis_idx" ON "analysis_statements" USING btree ("analysis_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fundamental_factors_analysis_factor_idx" ON "fundamental_factors" USING btree ("analysis_id","factor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alert_rules_user_type_channel_idx" ON "alert_rules" USING btree ("user_id","rule_type","channel");--> statement-breakpoint
CREATE INDEX "notifications_status_idx" ON "notifications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "report_assets_pk" ON "report_assets" USING btree ("report_id","asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_date_kind_idx" ON "reports" USING btree ("report_date","kind");--> statement-breakpoint
CREATE INDEX "reports_generated_idx" ON "reports" USING btree ("generated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "data_quality_subject_idx" ON "data_quality_incidents" USING btree ("subject_table","detected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "data_quality_flag_idx" ON "data_quality_incidents" USING btree ("flag");--> statement-breakpoint
CREATE INDEX "data_quality_unresolved_idx" ON "data_quality_incidents" USING btree ("detected_at") WHERE "data_quality_incidents"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "system_logs_occurred_idx" ON "system_logs" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "system_logs_level_time_idx" ON "system_logs" USING btree ("level","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "system_logs_event_idx" ON "system_logs" USING btree ("event");