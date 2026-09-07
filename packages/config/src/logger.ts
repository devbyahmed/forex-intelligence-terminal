/**
 * Structured logging (master PRD 42).
 *
 * Passwords, keys and tokens must never be logged. Rather than trusting every call
 * site to remember that, redaction is configured once here and applied by pino to
 * every record, including nested objects and error causes.
 */

import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Redaction paths. pino matches these literally, so each shape a secret might
 * arrive in needs its own entry — hence the wildcards at several depths.
 */
export const REDACT_PATHS: readonly string[] = [
  'password',
  '*.password',
  '*.*.password',
  'newPassword',
  '*.newPassword',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  '*.*.token',
  'sessionToken',
  '*.sessionToken',
  'apiKey',
  '*.apiKey',
  '*.*.apiKey',
  'api_key',
  '*.api_key',
  'secret',
  '*.secret',
  'authorization',
  '*.authorization',
  'cookie',
  '*.cookie',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'DATABASE_URL',
  '*.DATABASE_URL',
  'GEMINI_API_KEY',
  '*.GEMINI_API_KEY',
  'FRED_API_KEY',
  '*.FRED_API_KEY',
  'RESEND_API_KEY',
  '*.RESEND_API_KEY',
  'SESSION_SECRET',
  '*.SESSION_SECRET',
  'CSRF_SECRET',
  '*.CSRF_SECRET',
];

/** Re-exported so consumers can annotate a logger without depending on pino directly. */
export type { Logger };

export interface LoggerConfig {
  readonly level: string;
  readonly pretty: boolean;
  readonly name?: string;
}

export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
    // ISO timestamps: log correlation across services is painful with epoch millis.
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    ...(config.name === undefined ? {} : { name: config.name }),
    ...(config.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : {}),
  };
  return pino(options);
}

/**
 * Strip a URL down to something safe to log. Connection strings and API-keyed
 * request URLs are among the easiest ways to leak a credential into a log file.
 */
export function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.password !== '') url.password = 'REDACTED';
    if (url.username !== '') url.username = 'REDACTED';
    for (const key of [...url.searchParams.keys()]) {
      if (/key|token|secret|password|auth/i.test(key)) {
        url.searchParams.set(key, 'REDACTED');
      }
    }
    return url.toString();
  } catch {
    return '[unparseable url]';
  }
}
