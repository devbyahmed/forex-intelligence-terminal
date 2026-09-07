/**
 * Error taxonomy (master PRD 41).
 *
 * Every error carries two messages: `userMessage`, safe to render or return over
 * HTTP, and `detail`, for logs only. The split is structural so that leaking a
 * provider response body or a connection string to a client requires deliberately
 * reaching for the wrong field.
 */

export const ERROR_CODES = [
  'PROVIDER_ERROR',
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_CIRCUIT_OPEN',
  'DATA_UNAVAILABLE',
  'VALIDATION_ERROR',
  'AI_VALIDATION_ERROR',
  'AI_PROVIDER_ERROR',
  'AUTH_ERROR',
  'FORBIDDEN',
  'RATE_LIMITED',
  'NOT_FOUND',
  'DATABASE_ERROR',
  'CONFIG_ERROR',
  'NOT_AVAILABLE_IN_VERSION',
  'INTERNAL_ERROR',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppErrorOptions {
  /** Log-only context. Never sent to a client. */
  readonly detail?: string;
  readonly cause?: unknown;
  /** Structured log fields. Must not contain secrets. */
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly httpStatus?: number;
}

const DEFAULT_STATUS: Readonly<Record<ErrorCode, number>> = {
  PROVIDER_ERROR: 502,
  PROVIDER_RATE_LIMITED: 429,
  PROVIDER_CIRCUIT_OPEN: 503,
  DATA_UNAVAILABLE: 503,
  VALIDATION_ERROR: 400,
  AI_VALIDATION_ERROR: 502,
  AI_PROVIDER_ERROR: 502,
  AUTH_ERROR: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  NOT_FOUND: 404,
  DATABASE_ERROR: 500,
  CONFIG_ERROR: 500,
  NOT_AVAILABLE_IN_VERSION: 501,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  /** Safe to show a user. */
  readonly userMessage: string;
  /** Log-only. */
  readonly detail: string | undefined;
  readonly meta: Readonly<Record<string, unknown>> | undefined;
  readonly httpStatus: number;

  constructor(code: ErrorCode, userMessage: string, options: AppErrorOptions = {}) {
    super(userMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.userMessage = userMessage;
    this.detail = options.detail;
    this.meta = options.meta;
    this.httpStatus = options.httpStatus ?? DEFAULT_STATUS[code];
  }

  /** The only shape that may cross an HTTP boundary. */
  toPublicJSON(): { error: { code: ErrorCode; message: string } } {
    return { error: { code: this.code, message: this.userMessage } };
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

// ── Convenience constructors ────────────────────────────────────────────────

export const providerError = (userMessage: string, o?: AppErrorOptions): AppError =>
  new AppError('PROVIDER_ERROR', userMessage, o);

export const dataUnavailable = (userMessage: string, o?: AppErrorOptions): AppError =>
  new AppError('DATA_UNAVAILABLE', userMessage, o);

export const validationError = (userMessage: string, o?: AppErrorOptions): AppError =>
  new AppError('VALIDATION_ERROR', userMessage, o);

export const aiValidationError = (userMessage: string, o?: AppErrorOptions): AppError =>
  new AppError('AI_VALIDATION_ERROR', userMessage, o);

export const authError = (o?: AppErrorOptions): AppError =>
  // Deliberately uniform: never reveals whether the account exists.
  new AppError('AUTH_ERROR', 'Invalid email or password.', o);

export const configError = (userMessage: string, o?: AppErrorOptions): AppError =>
  new AppError('CONFIG_ERROR', userMessage, o);

export const notAvailableInVersion = (what: string, arrivesIn: string): AppError =>
  new AppError(
    'NOT_AVAILABLE_IN_VERSION',
    `${what} is not available in this version. Planned for ${arrivesIn}.`,
  );

/**
 * Normalise an unknown thrown value. Unrecognised errors become a generic internal
 * error so that a stray provider exception cannot leak its message to a client.
 */
export function toAppError(e: unknown): AppError {
  if (isAppError(e)) return e;
  if (e instanceof Error) {
    return new AppError('INTERNAL_ERROR', 'An unexpected error occurred.', {
      detail: e.message,
      cause: e,
    });
  }
  return new AppError('INTERNAL_ERROR', 'An unexpected error occurred.', {
    detail: `Non-Error thrown: ${String(e)}`,
  });
}
