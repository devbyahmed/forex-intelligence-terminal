/**
 * Email delivery, behind an interface.
 *
 * Master §28 names Resend as preferred and explicitly requires that we are not coupled
 * to it. So `EmailProvider` is the contract, `ResendEmailProvider` is one
 * implementation, and `SmtpEmailProvider` is another that shares no code with it —
 * **independently working, not a wrapper that degrades to the same failure.**
 *
 * The sending-identity check runs inside every implementation rather than in the caller.
 * A guard the caller must remember is a guard that is missing from the second call site,
 * and this particular guard exists to stop this project borrowing another project's
 * verified domain.
 */

import {
  assertSendingIdentity,
  SendingIdentityError,
} from './sendingIdentity.js';

export interface EmailMessage {
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}


/**
 * The one recipient an unverified sender may reach.
 *
 * Carried on the provider rather than on the message, so a caller cannot widen the
 * allowlist per send. It comes from `RESEND_ACCOUNT_ADDRESS`, which is deliberately a
 * different variable from `REPORT_TO_EMAIL` — a guard that reads the value it is
 * guarding compares a thing to itself and passes every time.
 */
export interface SendingPolicy {
  readonly permittedTo: string;
}

export type EmailResult =
  | { readonly kind: 'SENT'; readonly providerId: string; readonly messageId: string | null }
  | {
      readonly kind: 'REFUSED';
      readonly providerId: string;
      /** Our own precondition refused it. No network call was made. */
      readonly reason: string;
    }
  | {
      readonly kind: 'FAILED';
      readonly providerId: string;
      readonly reason: string;
      /** True when a retry might succeed — a 5xx or a transport error. */
      readonly retryable: boolean;
    };

export interface EmailProvider {
  readonly id: string;
  isConfigured(): boolean;
  send(message: EmailMessage): Promise<EmailResult>;
}

// ── Resend ──────────────────────────────────────────────────────────────────

export interface ResendOptions extends SendingPolicy {
  readonly apiKey: string;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Observed 2026-09-06 against the live API:
 *
 * - A send returns **HTTP 200** with `{ id }`.
 * - Rate limit headers report **10 requests per second** (`ratelimit-limit: 10`,
 *   `ratelimit-reset: 1`), not the 2/s the docs describe. The daily report sends one
 *   message, so the limit is not a constraint — it is recorded because a future digest
 *   or alert fan-out would meet it.
 * - `GET /domains` returns **401** with this key: it is scoped to sending only. That is
 *   a useful property — the key cannot enumerate or alter the shared account's domains
 *   — and it is why the sending-identity guard cannot be implemented by asking Resend
 *   what is verified.
 */
export class ResendEmailProvider implements EmailProvider {
  readonly id = 'resend';
  private readonly options: ResendOptions;

  constructor(options: ResendOptions) {
    this.options = options;
  }

  isConfigured(): boolean {
    return this.options.apiKey.trim() !== '';
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    try {
      assertSendingIdentity({
        from: message.from,
        to: message.to,
        permittedTo: this.options.permittedTo,
      });
    } catch (error) {
      if (error instanceof SendingIdentityError) {
        // REFUSED, not FAILED: nothing was attempted, and a retry would refuse again.
        return { kind: 'REFUSED', providerId: this.id, reason: error.message };
      }
      throw error;
    }

    if (!this.isConfigured()) {
      return { kind: 'FAILED', providerId: this.id, reason: 'NOT_CONFIGURED', retryable: false };
    }

    const fetchImpl = this.options.fetchImpl ?? fetch;
    const baseUrl = this.options.baseUrl ?? 'https://api.resend.com';

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/emails`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
    } catch (error) {
      return {
        kind: 'FAILED',
        providerId: this.id,
        reason: `TRANSPORT: ${error instanceof Error ? error.message : 'unknown'}`,
        retryable: true,
      };
    }

    const body = await response.text();

    if (!response.ok) {
      return {
        kind: 'FAILED',
        providerId: this.id,
        // The body carries Resend's own explanation — a restricted-path violation says
        // so explicitly — and it is far more useful than the status alone.
        reason: `HTTP_${String(response.status)}: ${body.slice(0, 300)}`,
        // 4xx is a configuration problem; retrying it just burns quota.
        retryable: response.status >= 500 || response.status === 429,
      };
    }

    let messageId: string | null = null;
    try {
      const parsed = JSON.parse(body) as { id?: unknown };
      messageId = typeof parsed.id === 'string' ? parsed.id : null;
    } catch {
      // A 200 with an unparseable body still delivered; the id is for the audit trail.
    }

    return { kind: 'SENT', providerId: this.id, messageId };
  }
}

// ── SMTP ────────────────────────────────────────────────────────────────────

export interface SmtpOptions extends SendingPolicy {
  /** Full URL, e.g. `smtps://user:pass@host:465`. */
  readonly url: string;
  readonly timeoutMs?: number;
  /**
   * Injected so this provider is testable without a mail server, and so the SMTP
   * client stays a runtime dependency of the deployment rather than of the package.
   */
  readonly transport?: (options: {
    url: string;
    message: EmailMessage;
    timeoutMs: number;
  }) => Promise<string | null>;
}

/**
 * The fallback path, independent of Resend.
 *
 * "Not coupled to Resend" is only true if this works on its own — a fallback that has
 * never been exercised is an assumption. It carries the same sending-identity guard,
 * because the reason for that guard is about *this project's* identity, not about
 * whichever transport happens to carry the message.
 */
export class SmtpEmailProvider implements EmailProvider {
  readonly id = 'smtp';
  private readonly options: SmtpOptions;

  constructor(options: SmtpOptions) {
    this.options = options;
  }

  isConfigured(): boolean {
    return this.options.url.trim() !== '' && this.options.transport !== undefined;
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    try {
      assertSendingIdentity({
        from: message.from,
        to: message.to,
        permittedTo: this.options.permittedTo,
      });
    } catch (error) {
      if (error instanceof SendingIdentityError) {
        return { kind: 'REFUSED', providerId: this.id, reason: error.message };
      }
      throw error;
    }

    const transport = this.options.transport;
    if (transport === undefined || this.options.url.trim() === '') {
      return { kind: 'FAILED', providerId: this.id, reason: 'NOT_CONFIGURED', retryable: false };
    }

    try {
      const messageId = await transport({
        url: this.options.url,
        message,
        timeoutMs: this.options.timeoutMs ?? 20_000,
      });
      return { kind: 'SENT', providerId: this.id, messageId };
    } catch (error) {
      return {
        kind: 'FAILED',
        providerId: this.id,
        reason: error instanceof Error ? error.message : 'unknown',
        retryable: true,
      };
    }
  }
}

// ── Chain ───────────────────────────────────────────────────────────────────

/**
 * Try providers in order until one sends.
 *
 * **A `REFUSED` result stops the chain.** Refusal means our own precondition rejected
 * the message — a forbidden sending identity or a blocked recipient — and those are
 * properties of the message, not of the transport. Falling through to SMTP would send
 * exactly the message the first provider refused, which would make the guard
 * decorative.
 */
export async function sendWithFallback(
  providers: readonly EmailProvider[],
  message: EmailMessage,
): Promise<{ readonly result: EmailResult; readonly attempts: readonly EmailResult[] }> {
  const attempts: EmailResult[] = [];

  for (const provider of providers) {
    const result = await provider.send(message);
    attempts.push(result);

    if (result.kind === 'SENT') return { result, attempts };
    if (result.kind === 'REFUSED') return { result, attempts };
  }

  const last = attempts[attempts.length - 1] ?? {
    kind: 'FAILED' as const,
    providerId: 'none',
    reason: 'No email provider is configured',
    retryable: false,
  };
  return { result: last, attempts };
}
