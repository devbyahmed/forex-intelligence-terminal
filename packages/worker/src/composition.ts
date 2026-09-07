/**
 * Composition for the scheduled tick.
 *
 * One place that turns validated configuration into the providers, the job list and the
 * email chain. Both the deployed HTTP trigger and the local tick script go through it,
 * so "it worked locally" is evidence about production rather than about a second
 * assembly that happens to look similar.
 *
 * Configuration arrives through `getEnv()` rather than `process.env`, per ARCHITECTURE
 * P7. That is not bureaucracy: the schema is where a missing `JOB_TRIGGER_SECRET` or an
 * accidentally pooled `DIRECT_DATABASE_URL` is caught, and a module that reads the raw
 * environment reads around every one of those checks.
 *
 * Everything here reads configuration and constructs objects. Nothing decides policy:
 * cadences live in the job registry, thresholds in the runtime config, and the sending
 * allowlist in the email provider. A composition root that also made decisions would be
 * a fourth place to look when a cadence is wrong.
 */

import { DEFAULT_RUNTIME_CONFIG, getEnv, type Env, type RuntimeConfig } from '@forex-agent/config';
import {
  ForexFactoryCalendarProvider,
  FredCalendarProvider,
  FredMacroProvider,
  ResendEmailProvider,
  SmtpEmailProvider,
  TwelveDataProvider,
  YahooFinanceProvider,
  type EmailProvider,
} from '@forex-agent/providers';
import { allJobs } from './jobs/registry.js';
import type { JobDefinition } from './runner.js';

/**
 * A value the schema treats as optional but this composition cannot run without.
 *
 * The distinction is real: the app serves pages without a FRED key, and the tick cannot
 * ingest without one. Failing here, by name, beats a provider returning UNAVAILABLE for
 * a reason that looks like an outage.
 */
function demand(value: string | undefined, name: string): string {
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set. The scheduled tick cannot run without it.`);
  }
  return value;
}

/**
 * The email transports, most authoritative first.
 *
 * Both are constructed when both are configured. `sendWithFallback` stops on a refusal —
 * a message the allowlist rejects is refused by every transport, because the refusal is
 * a property of the message, not of the connection — so the chain only ever retries
 * genuine transport failures.
 */
export function emailProviders(env: Env = getEnv()): readonly EmailProvider[] {
  // Empty when unset, which makes the allowlist fail closed rather than open. The env
  // schema requires it alongside a Resend key, so an empty value here means neither is
  // configured and nothing will be sent anyway.
  const permittedTo = env.RESEND_ACCOUNT_ADDRESS ?? '';
  const providers: EmailProvider[] = [];

  if (env.RESEND_API_KEY !== undefined) {
    providers.push(new ResendEmailProvider({ apiKey: env.RESEND_API_KEY, permittedTo }));
  }
  if (env.SMTP_URL !== undefined) {
    providers.push(new SmtpEmailProvider({ url: env.SMTP_URL, permittedTo }));
  }

  return providers;
}

export interface TickComposition {
  readonly jobs: readonly JobDefinition[];
  readonly config: RuntimeConfig;
}

export function buildTick(
  config: RuntimeConfig = DEFAULT_RUNTIME_CONFIG,
  env: Env = getEnv(),
): TickComposition {
  const fredKey = demand(env.FRED_API_KEY, 'FRED_API_KEY');

  const marketChain = [
    new TwelveDataProvider({
      apiKey: demand(env.TWELVEDATA_API_KEY, 'TWELVEDATA_API_KEY'),
      thresholds: config.freshness.spotQuote,
    }),
    // Second by authority, not by preference: a labelled proxy, used only when the
    // verified spot source is unavailable.
    new YahooFinanceProvider({ thresholds: config.freshness.spotQuote }),
  ];

  return {
    config,
    jobs: allJobs({
      config,
      marketChain,
      fredMacro: new FredMacroProvider({
        apiKey: fredKey,
        thresholds: config.freshness.dailyMacro,
      }),
      fredCalendar: new FredCalendarProvider({
        apiKey: fredKey,
        thresholds: config.freshness.economicCalendar,
      }),
      forexFactory: new ForexFactoryCalendarProvider({
        thresholds: config.freshness.economicCalendar,
      }),
      analysis: {
        // Absent means the deterministic layers run alone, which is a complete
        // analysis — not a degraded one.
        ...(env.GEMINI_API_KEY === undefined
          ? {}
          : {
              gemini: {
                apiKey: env.GEMINI_API_KEY,
                model: env.GEMINI_MODEL,
                fallbackModel: env.GEMINI_FALLBACK_MODEL,
              },
            }),
      },
      report: {
        providers: emailProviders(env),
        from: demand(env.REPORT_FROM_EMAIL, 'REPORT_FROM_EMAIL'),
        to: demand(env.REPORT_TO_EMAIL, 'REPORT_TO_EMAIL'),
        appBaseUrl: env.APP_BASE_URL,
        timeZone: env.REPORT_TIMEZONE,
      },
    }),
  };
}
