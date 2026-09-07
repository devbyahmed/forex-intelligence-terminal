/**
 * HTTP client for provider calls.
 *
 * The single place `fetch` is permitted to reach a third party. Everything here
 * exists because a provider call is the least trustworthy thing the system does:
 * it can hang, lie about its content type, echo our API key back in an error, or
 * silently start returning HTML where JSON used to be.
 */

import { safeUrl } from '@forex-agent/config';

export interface HttpRequest {
  readonly url: string;
  readonly method?: 'GET' | 'POST';
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  /** Conditional GET, so an unchanged feed costs a 304 rather than a full body. */
  readonly etag?: string | null | undefined;
  readonly lastModified?: string | null | undefined;
}

export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly notModified: boolean;
  readonly body: string;
  readonly etag: string | null;
  readonly lastModified: string | null;
  readonly retryAfterMs: number | null;
  readonly durationMs: number;
  readonly contentType: string | null;
}

export class HttpError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly durationMs: number;

  constructor(code: string, message: string, status: number | null, durationMs: number) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.status = status;
    this.durationMs = durationMs;
  }
}

/**
 * Cap on a response body.
 *
 * A provider that starts streaming something enormous should fail fast rather than
 * exhaust a 2 GB serverless function. 8 MB is far above any legitimate response here
 * and far below anything that would hurt.
 */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const USER_AGENT =
  'forex-intelligence-terminal/0.1 (+https://github.com/devbyahmed/forex-intelligence-terminal)';

/**
 * Parse `Retry-After`, which may be seconds or an HTTP date.
 *
 * Honouring it matters: ignoring a vendor's explicit backoff instruction is how a
 * temporary throttle becomes a ban.
 */
export function parseRetryAfter(value: string | null, now: Date): number | null {
  if (value === null || value.trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now.getTime());
}

export async function httpRequest(
  request: HttpRequest,
  now: Date = new Date(),
): Promise<HttpResponse> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, request.timeoutMs);

  const headers: Record<string, string> = {
    // Identifies us to feed operators so a problem can be reported rather than
    // silently blocked.
    'user-agent': USER_AGENT,
    accept: 'application/json, text/xml, application/xml, text/plain;q=0.9, */*;q=0.8',
    ...request.headers,
  };
  if (request.etag != null && request.etag !== '') headers['if-none-match'] = request.etag;
  if (request.lastModified != null && request.lastModified !== '') {
    headers['if-modified-since'] = request.lastModified;
  }

  try {
    const response = await fetch(request.url, {
      method: request.method ?? 'GET',
      headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      signal: controller.signal,
      redirect: 'follow',
    });

    const durationMs = Date.now() - started;

    if (response.status === 304) {
      return {
        status: 304,
        ok: true,
        notModified: true,
        body: '',
        etag: request.etag ?? null,
        lastModified: request.lastModified ?? null,
        retryAfterMs: null,
        durationMs,
        contentType: response.headers.get('content-type'),
      };
    }

    const body = await readCappedBody(response);

    return {
      status: response.status,
      ok: response.ok,
      notModified: false,
      body,
      etag: response.headers.get('etag'),
      lastModified: response.headers.get('last-modified'),
      retryAfterMs: parseRetryAfter(response.headers.get('retry-after'), now),
      durationMs,
      contentType: response.headers.get('content-type'),
    };
  } catch (e) {
    const durationMs = Date.now() - started;
    if (e instanceof Error && e.name === 'AbortError') {
      throw new HttpError(
        'TIMEOUT',
        `Request to ${safeUrl(request.url)} timed out after ${String(request.timeoutMs)}ms`,
        null,
        durationMs,
      );
    }
    throw new HttpError(
      'NETWORK_ERROR',
      // safeUrl strips credentials and key-like query parameters: provider URLs
      // routinely carry the API key inline, and this message reaches the logs.
      `Request to ${safeUrl(request.url)} failed: ${e instanceof Error ? e.message : String(e)}`,
      null,
      durationMs,
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readCappedBody(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return response.text();

  const reader: ReadableStreamDefaultReader<Uint8Array> = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    const value: Uint8Array = chunk.value;

    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new HttpError(
        'BODY_TOO_LARGE',
        `Response exceeded ${String(MAX_BODY_BYTES)} bytes`,
        response.status,
        0,
      );
    }
    chunks.push(value);
  }

  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Parse JSON, refusing to guess.
 *
 * A provider returning an HTML error page with a 200 is common enough that treating
 * "it parsed" as "it is what we asked for" is a real source of corrupt data.
 */
export function parseJson(response: HttpResponse): unknown {
  const type = response.contentType ?? '';
  if (type !== '' && !type.includes('json') && !type.includes('text')) {
    throw new HttpError(
      'UNEXPECTED_CONTENT_TYPE',
      `Expected JSON, got ${type}`,
      response.status,
      response.durationMs,
    );
  }
  try {
    return JSON.parse(response.body);
  } catch {
    const preview = response.body.slice(0, 120).replace(/\s+/g, ' ');
    throw new HttpError(
      'INVALID_JSON',
      `Response was not valid JSON (starts: ${preview})`,
      response.status,
      response.durationMs,
    );
  }
}

/** SHA-256 of a payload, for deduplicating the raw archive. */
export async function payloadHash(body: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(body, 'utf8').digest('hex');
}
