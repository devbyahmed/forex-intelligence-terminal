import { describe, expect, it } from 'vitest';
import {
  AppError,
  authError,
  isAppError,
  notAvailableInVersion,
  toAppError,
  validationError,
} from './errors.js';

describe('AppError', () => {
  it('keeps log-only detail out of the public payload', () => {
    // The whole point of the split: a connection string in `detail` must not be
    // reachable through the shape that crosses an HTTP boundary.
    const e = new AppError('DATABASE_ERROR', 'Something went wrong.', {
      detail: 'postgresql://forex:hunter2@db:5432/forex_agent timed out',
    });
    const publicJson = e.toPublicJSON();
    expect(publicJson.error.message).toBe('Something went wrong.');
    expect(JSON.stringify(publicJson)).not.toContain('hunter2');
    expect(JSON.stringify(publicJson)).not.toContain('postgresql://');
  });

  it('assigns a sensible default HTTP status per code', () => {
    expect(new AppError('NOT_FOUND', 'x').httpStatus).toBe(404);
    expect(new AppError('AUTH_ERROR', 'x').httpStatus).toBe(401);
    expect(new AppError('RATE_LIMITED', 'x').httpStatus).toBe(429);
    expect(new AppError('DATA_UNAVAILABLE', 'x').httpStatus).toBe(503);
  });

  it('allows the status to be overridden', () => {
    expect(new AppError('VALIDATION_ERROR', 'x', { httpStatus: 422 }).httpStatus).toBe(422);
  });

  it('is recognisable via the type guard', () => {
    expect(isAppError(validationError('bad input'))).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
    expect(isAppError('not an error')).toBe(false);
  });
});

describe('authError', () => {
  it('uses one uniform message so it cannot reveal whether an account exists', () => {
    // Two different messages here would turn login into an account enumerator.
    expect(authError().userMessage).toBe('Invalid email or password.');
    expect(authError({ detail: 'user not found' }).userMessage).toBe(
      authError({ detail: 'wrong password' }).userMessage,
    );
  });
});

describe('notAvailableInVersion', () => {
  it('says plainly that a capability is absent rather than faking it', () => {
    const e = notAvailableInVersion('Technical analysis', 'V2');
    expect(e.code).toBe('NOT_AVAILABLE_IN_VERSION');
    expect(e.httpStatus).toBe(501);
    expect(e.userMessage).toContain('V2');
  });
});

describe('toAppError', () => {
  it('passes an AppError through unchanged', () => {
    const original = validationError('bad');
    expect(toAppError(original)).toBe(original);
  });

  it('wraps a plain Error without leaking its message to the user', () => {
    const e = toAppError(new Error('ECONNREFUSED 10.0.0.5:5432'));
    expect(e.code).toBe('INTERNAL_ERROR');
    expect(e.userMessage).toBe('An unexpected error occurred.');
    expect(e.detail).toContain('ECONNREFUSED');
    expect(JSON.stringify(e.toPublicJSON())).not.toContain('ECONNREFUSED');
  });

  it('handles a non-Error throw', () => {
    const e = toAppError({ weird: true });
    expect(e.code).toBe('INTERNAL_ERROR');
    expect(e.detail).toContain('Non-Error thrown');
  });
});
