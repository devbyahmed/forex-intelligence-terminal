/**
 * @forex-agent/auth — password hashing, sessions, CSRF, rate limiting.
 *
 * Framework-agnostic on purpose: the HTTP glue lives in apps/web (Phase 10), but
 * every security decision is made and tested here, without needing a server running.
 */

export * from './password.js';
export * from './tokens.js';
export * from './rateLimit.js';
export * from './session.js';
export * from './login.js';
