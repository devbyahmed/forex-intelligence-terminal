import { describe, expect, it } from 'vitest';
import { EnvValidationError, capabilities, parseEnv } from './env.js';

const SECRET_A = 'a'.repeat(48);
const SECRET_B = 'b'.repeat(48);

const valid = {
  DATABASE_URL: 'postgresql://forex:forex@localhost:5432/forex_agent',
  APP_BASE_URL: 'http://localhost:3000',
  SESSION_SECRET: SECRET_A,
  CSRF_SECRET: SECRET_B,
} satisfies NodeJS.ProcessEnv;

describe('parseEnv', () => {
  it('accepts a minimal valid environment and applies defaults', () => {
    const env = parseEnv({ ...valid });
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    // Verified empirically 2026-08-30: 3.7-flash was 503 on 4/4 attempts and
    // 2.5-flash 404s despite being listed. 3.5 and 3.6 both work with responseSchema.
    expect(env.GEMINI_MODEL).toBe('gemini-3.5-flash');
    expect(env.GEMINI_FALLBACK_MODEL).toBe('gemini-3.6-flash');
    expect(env.REPORT_TIMEZONE).toBe('UTC');
  });

  it('fails fast when a required variable is missing', () => {
    // Boot-time failure is the whole point: an undefined signing secret must never
    // reach a signing function.
    const { SESSION_SECRET: _omitted, ...withoutSecret } = valid;
    expect(() => parseEnv(withoutSecret)).toThrow(EnvValidationError);
  });

  it('names every offending variable in the error', () => {
    const { DATABASE_URL: _a, SESSION_SECRET: _b, ...partial } = valid;
    try {
      parseEnv(partial);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(EnvValidationError);
      const issues = (e as EnvValidationError).issues.join('\n');
      expect(issues).toContain('DATABASE_URL');
      expect(issues).toContain('SESSION_SECRET');
    }
  });

  it('rejects a short signing secret', () => {
    expect(() => parseEnv({ ...valid, SESSION_SECRET: 'too-short' })).toThrow(EnvValidationError);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    expect(() => parseEnv({ ...valid, DATABASE_URL: 'mysql://localhost/db' })).toThrow(
      EnvValidationError,
    );
  });

  it('rejects a malformed APP_BASE_URL', () => {
    expect(() => parseEnv({ ...valid, APP_BASE_URL: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('trims a trailing carriage return from a pasted key', () => {
    // A key pasted into .env on Windows carries a CR. Untrimmed it reaches the
    // provider and returns a confusing 400 that looks like an invalid key —
    // observed for real during the FRED verification.
    const env = parseEnv({
      ...valid,
      FRED_API_KEY: 'abc123' + String.fromCharCode(13),
      DATABASE_URL: valid.DATABASE_URL + String.fromCharCode(13),
    });
    expect(env.FRED_API_KEY).toBe('abc123');
    expect(env.DATABASE_URL.endsWith('forex_agent')).toBe(true);
  });

  it('treats an empty optional value as absent rather than as an empty credential', () => {
    // A blank line in .env must not become an empty-string API key that then fails
    // deep inside a provider call with a confusing 401.
    const env = parseEnv({ ...valid, GEMINI_API_KEY: '', FRED_API_KEY: '  ' });
    expect(env.GEMINI_API_KEY).toBeUndefined();
    expect(env.FRED_API_KEY).toBeUndefined();
  });

  it('rejects two configured email transports as ambiguous', () => {
    expect(() =>
      parseEnv({ ...valid, RESEND_API_KEY: 're_123', SMTP_URL: 'smtp://localhost:1025' }),
    ).toThrow(EnvValidationError);
  });

  describe('production hardening', () => {
    /*
     * A deployable production environment, not merely a parseable one.
     *
     * `JOB_TRIGGER_SECRET` belongs in the baseline because without it the scheduled
     * endpoint refuses every call — a deployment that boots, serves pages and never
     * runs a job, which looks identical to a scheduler that is not firing.
     */
    const prod = {
      ...valid,
      NODE_ENV: 'production',
      JOB_TRIGGER_SECRET: SECRET_B,
    } satisfies NodeJS.ProcessEnv;

    it('requires HTTPS for a non-local base URL', () => {
      expect(() => parseEnv({ ...prod, APP_BASE_URL: 'http://terminal.example.com' })).toThrow(
        EnvValidationError,
      );
    });

    it('accepts HTTPS in production', () => {
      expect(() =>
        parseEnv({ ...prod, APP_BASE_URL: 'https://terminal.example.com' }),
      ).not.toThrow();
    });

    it('requires a job-trigger secret in production', () => {
      // The failure is silent by design: the endpoint fails closed. That is correct
      // and invisible, so the environment has to demand the secret instead.
      const { JOB_TRIGGER_SECRET: _omitted, ...withoutSecret } = prod;
      expect(() =>
        parseEnv({ ...withoutSecret, APP_BASE_URL: 'https://terminal.example.com' }),
      ).toThrow(/JOB_TRIGGER_SECRET/);
    });

    it('requires the recipient allowlist whenever Resend is configured', () => {
      // An empty allowlist fails closed, so this combination would generate reports
      // every day and refuse to send every one of them.
      expect(() =>
        parseEnv({
          ...prod,
          APP_BASE_URL: 'https://terminal.example.com',
          RESEND_API_KEY: 're_123',
        }),
      ).toThrow(/RESEND_ACCOUNT_ADDRESS/);
    });

    it('rejects a pooled connection string in DIRECT_DATABASE_URL', () => {
      /*
       * The variable exists only to carry the non-pooled endpoint for migrations. A
       * pooled string here defeats its entire purpose while looking correct, and the
       * damage — DDL through a transaction-mode pooler — shows up mid-deploy.
       */
      expect(() =>
        parseEnv({
          ...prod,
          APP_BASE_URL: 'https://terminal.example.com',
          DIRECT_DATABASE_URL: 'postgresql://u:p@ep-x-pooler.db.example.invalid/db',
        }),
      ).toThrow(/DIRECT_DATABASE_URL/);
    });

    it('accepts the direct endpoint', () => {
      expect(() =>
        parseEnv({
          ...prod,
          APP_BASE_URL: 'https://terminal.example.com',
          DIRECT_DATABASE_URL: 'postgresql://u:p@ep-x.db.example.invalid/db',
        }),
      ).not.toThrow();
    });
    it('rejects reuse of one secret for both session and CSRF', () => {
      expect(() =>
        parseEnv({
          ...prod,
          APP_BASE_URL: 'https://terminal.example.com',
          CSRF_SECRET: SECRET_A,
        }),
      ).toThrow(EnvValidationError);
    });

    it('does not impose the HTTPS rule in development', () => {
      expect(() => parseEnv({ ...valid })).not.toThrow();
    });
  });
});

describe('capabilities', () => {
  it('reports everything absent on a minimal environment', () => {
    // The system must be able to say "AI unavailable: no API key" rather than
    // failing opaquely when the call is finally attempted.
    const caps = capabilities(parseEnv({ ...valid }));
    expect(caps).toEqual({
      ai: false,
      macro: false,
      marketData: false,
      marketDataFallback: false,
      email: false,
    });
  });

  it('reports configured capabilities', () => {
    const caps = capabilities(
      parseEnv({
        ...valid,
        GEMINI_API_KEY: 'AIza-test',
        FRED_API_KEY: 'fred-test',
        RESEND_API_KEY: 're_test',
        REPORT_FROM_EMAIL: 'terminal@example.com',
        REPORT_TO_EMAIL: 'me@example.com',
      }),
    );
    expect(caps.ai).toBe(true);
    expect(caps.macro).toBe(true);
    expect(caps.email).toBe(true);
    expect(caps.marketData).toBe(false);
  });

  it('does not report email as configured without both addresses', () => {
    const caps = capabilities(parseEnv({ ...valid, RESEND_API_KEY: 're_test' }));
    expect(caps.email).toBe(false);
  });
});
