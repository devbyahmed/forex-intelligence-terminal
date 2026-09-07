import { describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import { pino, type Logger } from 'pino';
import { REDACT_PATHS, safeUrl } from './logger.js';

/** Capture what pino actually writes, so redaction is verified on real output. */
function captureLogs(fn: (log: Logger) => void): string {
  let output = '';
  const sink = new Writable({
    write(chunk, _enc, cb) {
      output += String(chunk);
      cb();
    },
  });
  const log = pino(
    { level: 'info', redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' } },
    sink,
  );
  fn(log);
  return output;
}

describe('log redaction', () => {
  it('redacts a password at the top level', () => {
    const out = captureLogs((log) => {
      log.info({ password: 'hunter2' }, 'login attempt');
    });
    expect(out).not.toContain('hunter2');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts credentials nested one and two levels deep', () => {
    const out = captureLogs((log) => {
      log.info({ user: { password: 'hunter2' }, req: { headers: { cookie: 'session=abc' } } });
    });
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('session=abc');
  });

  it('redacts API keys under several naming conventions', () => {
    const out = captureLogs((log) => {
      log.info({
        apiKey: 'AIza-secret-1',
        api_key: 'AIza-secret-2',
        config: { apiKey: 'AIza-secret-3' },
      });
    });
    for (const secret of ['AIza-secret-1', 'AIza-secret-2', 'AIza-secret-3']) {
      expect(out).not.toContain(secret);
    }
  });

  it('redacts named environment secrets', () => {
    const out = captureLogs((log) => {
      log.info({ GEMINI_API_KEY: 'gk-live', DATABASE_URL: 'postgresql://u:p@h/db' });
    });
    expect(out).not.toContain('gk-live');
    expect(out).not.toContain('postgresql://u:p@h/db');
  });

  it('redacts an authorization header', () => {
    const out = captureLogs((log) => {
      log.info({ headers: { authorization: 'Bearer super-secret-token' } });
    });
    expect(out).not.toContain('super-secret-token');
  });

  it('leaves ordinary diagnostic fields intact', () => {
    // Over-redaction would make logs useless; the operational fields must survive.
    const out = captureLogs((log) => {
      log.info({ providerId: 'fred', durationMs: 812, httpStatus: 429 }, 'provider attempt');
    });
    expect(out).toContain('fred');
    expect(out).toContain('812');
    expect(out).toContain('provider attempt');
  });
});

describe('safeUrl', () => {
  it('strips credentials from a connection string', () => {
    const safe = safeUrl('postgresql://forex:hunter2@db:5432/forex_agent');
    expect(safe).not.toContain('hunter2');
    expect(safe).toContain('db:5432');
  });

  it('redacts key-like query parameters', () => {
    // Provider URLs routinely carry the API key inline; logging one verbatim is a
    // credential leak into every log aggregator downstream.
    const safe = safeUrl('https://api.stlouisfed.org/fred/series?series_id=DGS10&api_key=abc123');
    expect(safe).not.toContain('abc123');
    expect(safe).toContain('series_id=DGS10');
  });

  it('redacts token and secret parameters regardless of case', () => {
    const safe = safeUrl('https://example.com/x?AccessToken=t1&client_secret=s1&Password=p1');
    expect(safe).not.toContain('t1');
    expect(safe).not.toContain('s1');
    expect(safe).not.toContain('p1');
  });

  it('leaves a clean URL unchanged', () => {
    const url = 'https://api.gdeltproject.org/api/v2/doc/doc?query=gold&format=json';
    expect(safeUrl(url)).toBe(url);
  });

  it('does not throw on an unparseable input', () => {
    expect(safeUrl('not a url at all')).toBe('[unparseable url]');
  });
});
