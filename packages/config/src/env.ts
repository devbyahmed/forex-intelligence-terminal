/**
 * Environment parsing (master PRD 54, Principle P7).
 *
 * This module is the ONLY place in the codebase permitted to read `process.env`.
 * An ESLint boundary rule enforces that everywhere else, which is what keeps a
 * credential from drifting into a component that gets bundled for the browser.
 *
 * Parsing happens once, at boot, and fails loudly. A missing secret discovered at
 * startup is an inconvenience; the same secret discovered as `undefined` inside a
 * signing function at 3am is a security incident.
 */

import { z } from 'zod';
import { assertValidTimeZone } from '@forex-agent/core';

const nonEmpty = (label: string): z.ZodString =>
  z
    .string({ error: `${label} is required` })
    // .trim() first: a value pasted into .env on Windows carries a trailing CR,
    // which otherwise reaches the provider and returns a confusing 400.
    .trim()
    .min(1, `${label} must not be empty`);

/** Secrets used for signing must be long enough to be worth signing with. */
const secret = (label: string): z.ZodString =>
  nonEmpty(label).min(32, `${label} must be at least 32 characters`);

/**
 * Treat a blank .env line as absent rather than as an empty credential.
 *
 * Preprocessing (rather than `.or(z.literal(''))`) is what makes a whitespace-only
 * value work: the fallback branch would otherwise compare the untrimmed original and
 * let `'  '` through as a validation failure instead of an omission.
 */
const blankAsUndefined = <T extends z.ZodType>(inner: T): z.ZodPipe<z.ZodTransform, T> =>
  z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    inner,
  ) as unknown as z.ZodPipe<z.ZodTransform, T>;

const optionalNonEmpty = blankAsUndefined(z.string().trim().min(1).optional());
const optionalEmail = blankAsUndefined(z.email().optional());

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),

    DATABASE_URL: nonEmpty('DATABASE_URL').refine(
      (v) => v.startsWith('postgres://') || v.startsWith('postgresql://'),
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
    ),

    APP_BASE_URL: z.url({ error: 'APP_BASE_URL must be a valid URL' }),
    SESSION_SECRET: secret('SESSION_SECRET'),
    CSRF_SECRET: secret('CSRF_SECRET'),

    // AI — an AI Studio API key. A consumer Gemini subscription will not work here.
    GEMINI_API_KEY: optionalNonEmpty,
    // Verified 2026-08-30: gemini-3.7-flash returned 503 on 4/4 attempts and
    // gemini-2.5-flash returns 404 despite appearing in the model list. 3.5 and 3.6
    // are both 4/4 available with working responseSchema; 3.5 is the faster of the
    // two (8s vs 33s). Promote 3.7 here when it stabilises — that is the whole
    // reason these are configuration rather than constants.
    GEMINI_MODEL: z.string().trim().min(1).default('gemini-3.5-flash'),
    GEMINI_FALLBACK_MODEL: z.string().trim().min(1).default('gemini-3.6-flash'),

    FRED_API_KEY: optionalNonEmpty,

    TWELVEDATA_API_KEY: optionalNonEmpty,
    NASDAQ_DATA_LINK_API_KEY: optionalNonEmpty,

    /**
     * The non-pooled Neon endpoint, for migrations only.
     *
     * The `-pooler` check lives here rather than in the deploy script alone: a rule
     * with two definitions is a rule that drifts, and this one is only useful if it
     * holds wherever the variable is read.
     */
    DIRECT_DATABASE_URL: blankAsUndefined(
      z
        .string()
        .trim()
        .min(1)
        .refine((v) => !v.includes('-pooler'), {
          message:
            'DIRECT_DATABASE_URL must be the direct (non-pooled) endpoint. A pooled string ' +
            'here silently defeats the only reason the variable exists — DDL through ' +
            'PgBouncer in transaction mode can misbehave. See DEPLOY.md.',
        })
        .optional(),
    ),

    /**
     * Shared secret for the scheduled tick endpoint.
     *
     * Optional locally, mandatory in production: an unset secret makes the endpoint
     * fail closed, which is correct but silent, and a deployment whose scheduler can
     * never authenticate looks exactly like a scheduler that is not running.
     */
    JOB_TRIGGER_SECRET: blankAsUndefined(secret('JOB_TRIGGER_SECRET').optional()),

    RESEND_API_KEY: optionalNonEmpty,
    /**
     * The one address this project may send to.
     *
     * Deliberately separate from REPORT_TO_EMAIL: a guard that reads the value it is
     * guarding compares a thing to itself and passes every time.
     */
    RESEND_ACCOUNT_ADDRESS: optionalEmail,
    SMTP_URL: optionalNonEmpty,
    REPORT_FROM_EMAIL: optionalEmail,
    REPORT_TO_EMAIL: optionalEmail,
    /*
     * The calendar the report's day boundary follows. Trimmed because a pasted value
     * carrying a trailing space is rejected by ICU, and validated because an
     * unrecognised zone would otherwise date every report in whatever zone the host
     * happens to run in — a report off by a day with nothing to signal it.
     */
    REPORT_TIMEZONE: z
      .string()
      .trim()
      .min(1)
      .default('UTC')
      .refine(
        (tz) => {
          try {
            assertValidTimeZone(tz);
            return true;
          } catch {
            return false;
          }
        },
        { message: 'REPORT_TIMEZONE must be an IANA time zone, such as America/New_York' },
      ),
  })
  .superRefine((env, ctx) => {
    // Production must not run on placeholder secrets.
    if (env.NODE_ENV === 'production') {
      if (env.APP_BASE_URL.startsWith('http://') && !env.APP_BASE_URL.includes('localhost')) {
        ctx.addIssue({
          code: 'custom',
          path: ['APP_BASE_URL'],
          message: 'APP_BASE_URL must use HTTPS in production (master PRD 53)',
        });
      }
      if (env.JOB_TRIGGER_SECRET === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['JOB_TRIGGER_SECRET'],
          message:
            'JOB_TRIGGER_SECRET is required in production — without it the scheduled tick endpoint refuses every call and nothing ever runs',
        });
      }
      // The sending allowlist fails closed on an empty value, so a production deploy
      // with a Resend key and no allowlist would refuse every report it generated.
      if (env.RESEND_API_KEY !== undefined && env.RESEND_ACCOUNT_ADDRESS === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['RESEND_ACCOUNT_ADDRESS'],
          message:
            'RESEND_ACCOUNT_ADDRESS is required whenever RESEND_API_KEY is set — it is the recipient allowlist, and an empty allowlist refuses every send',
        });
      }
      if (env.SESSION_SECRET === env.CSRF_SECRET) {
        ctx.addIssue({
          code: 'custom',
          path: ['CSRF_SECRET'],
          message: 'CSRF_SECRET must differ from SESSION_SECRET',
        });
      }
    }
    // Exactly one email transport, or none at all — never an ambiguous pair.
    if (env.RESEND_API_KEY !== undefined && env.SMTP_URL !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['SMTP_URL'],
        message:
          'Set RESEND_API_KEY or SMTP_URL, not both — the active email transport must be unambiguous',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Names treated as secret for redaction and for the "is it configured" report. */
export const SECRET_ENV_KEYS = [
  'SESSION_SECRET',
  'CSRF_SECRET',
  'GEMINI_API_KEY',
  'FRED_API_KEY',
  'TWELVEDATA_API_KEY',
  'NASDAQ_DATA_LINK_API_KEY',
  'RESEND_API_KEY',
  'SMTP_URL',
  'DATABASE_URL',
] as const satisfies readonly (keyof Env)[];

export class EnvValidationError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(
      `Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}\n\n` +
        `See .env.example for the full list of variables.`,
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => {
      const path = i.path.join('.') || '(root)';
      return `${path}: ${i.message}`;
    });
    throw new EnvValidationError(issues);
  }
  return result.data;
}

let cached: Env | null = null;

/** Parse once and reuse. Throws on first call if the environment is invalid. */
export function getEnv(): Env {
  cached ??= parseEnv();
  return cached;
}

/** Test-only: clear the memoised environment. */
export function resetEnvCache(): void {
  cached = null;
}

/**
 * Which optional capabilities are actually configured. Used by the system status
 * panel to say "AI unavailable: no API key" instead of failing opaquely at call time.
 */
export interface CapabilityReport {
  readonly ai: boolean;
  readonly macro: boolean;
  readonly marketData: boolean;
  readonly marketDataFallback: boolean;
  readonly email: boolean;
}

export function capabilities(env: Env): CapabilityReport {
  return {
    ai: env.GEMINI_API_KEY !== undefined,
    macro: env.FRED_API_KEY !== undefined,
    marketData: env.TWELVEDATA_API_KEY !== undefined,
    marketDataFallback: env.NASDAQ_DATA_LINK_API_KEY !== undefined,
    email:
      (env.RESEND_API_KEY !== undefined || env.SMTP_URL !== undefined) &&
      env.REPORT_FROM_EMAIL !== undefined &&
      env.REPORT_TO_EMAIL !== undefined,
  };
}
