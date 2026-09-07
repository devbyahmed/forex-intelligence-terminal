/**
 * Email delivery and the fallback chain.
 *
 * The behaviour that matters most here is not "does it send" — it is **what happens
 * when it must not**. A refusal has to stop the chain, or the SMTP fallback would
 * deliver exactly the message Resend refused and the sending-identity guard would be
 * decorative.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ResendEmailProvider,
  SmtpEmailProvider,
  sendWithFallback,
  type EmailMessage,
  type EmailProvider,
  type EmailResult,
} from './emailProvider.js';
import { PERMITTED_FROM_ADDRESS } from './sendingIdentity.js';

const MESSAGE: EmailMessage = {
  from: PERMITTED_FROM_ADDRESS,
  to: 'account-signup@example.invalid',
  subject: 'XAUUSD daily report',
  text: 'Fundamental conditions read -14.6.',
};

const jsonResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ResendEmailProvider', () => {
  it('sends and returns the message id', async () => {
    // Shape taken from the real 2026-09-06 response: HTTP 200 with `{ id }`.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'abc-123' }));
    const provider = new ResendEmailProvider({ apiKey: 'k', permittedTo: 'account-signup@example.invalid', fetchImpl: fetchImpl as typeof fetch });

    const result = await provider.send(MESSAGE);
    expect(result).toEqual({ kind: 'SENT', providerId: 'resend', messageId: 'abc-123' });
  });

  it('refuses a forbidden sender without making a network call', async () => {
    // The guard runs first. If this ever calls fetch, a misconfiguration reaches the
    // API and the shared account's domain is in play.
    const fetchImpl = vi.fn();
    const provider = new ResendEmailProvider({ apiKey: 'k', permittedTo: 'account-signup@example.invalid', fetchImpl: fetchImpl as typeof fetch });

    const result = await provider.send({ ...MESSAGE, from: 'reports@other-project.example' });
    expect(result.kind).toBe('REFUSED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refuses a recipient that is not on the allowlist, without a network call', async () => {
    const fetchImpl = vi.fn();
    const provider = new ResendEmailProvider({ apiKey: 'k', permittedTo: 'account-signup@example.invalid', fetchImpl: fetchImpl as typeof fetch });

    const result = await provider.send({ ...MESSAGE, to: 'someone-else@example.invalid' });
    expect(result.kind).toBe('REFUSED');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('treats a 4xx as non-retryable', async () => {
    // Retrying a configuration error just burns quota and delays the real fix.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(422, { message: 'You can only send to your own address' }));
    const provider = new ResendEmailProvider({ apiKey: 'k', permittedTo: 'account-signup@example.invalid', fetchImpl: fetchImpl as typeof fetch });

    const result = await provider.send(MESSAGE);
    expect(result).toMatchObject({ kind: 'FAILED', retryable: false });
    if (result.kind !== 'FAILED') return;
    // The provider's own explanation is preserved — far more useful than the status.
    expect(result.reason).toContain('own address');
  });

  it('treats 429 and 5xx as retryable', async () => {
    for (const status of [429, 500, 503]) {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(status, { message: 'later' }));
      const provider = new ResendEmailProvider({
        apiKey: 'k',
        permittedTo: 'account-signup@example.invalid',
        fetchImpl: fetchImpl as typeof fetch,
      });
      expect(await provider.send(MESSAGE)).toMatchObject({ kind: 'FAILED', retryable: true });
    }
  });

  it('treats a transport error as retryable', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const provider = new ResendEmailProvider({ apiKey: 'k', permittedTo: 'account-signup@example.invalid', fetchImpl: fetchImpl as typeof fetch });
    expect(await provider.send(MESSAGE)).toMatchObject({ kind: 'FAILED', retryable: true });
  });

  it('reports a missing key as a configuration failure, not a transport one', async () => {
    const provider = new ResendEmailProvider({ apiKey: '', permittedTo: 'account-signup@example.invalid' });
    expect(await provider.send(MESSAGE)).toMatchObject({
      kind: 'FAILED',
      reason: 'NOT_CONFIGURED',
      retryable: false,
    });
  });
});

describe('SmtpEmailProvider', () => {
  it('sends through the injected transport', async () => {
    // The fallback must work on its own — "not coupled to Resend" is only true if this
    // path has actually been exercised.
    const transport = vi.fn().mockResolvedValue('<smtp-id@host>');
    const provider = new SmtpEmailProvider({ url: 'smtps://user:pw@host:465', permittedTo: 'account-signup@example.invalid', transport });

    expect(await provider.send(MESSAGE)).toEqual({
      kind: 'SENT',
      providerId: 'smtp',
      messageId: '<smtp-id@host>',
    });
    expect(transport).toHaveBeenCalledOnce();
  });

  it('carries the same sending-identity guard', async () => {
    // The guard is about this project's identity, not about the transport carrying it.
    const transport = vi.fn();
    const provider = new SmtpEmailProvider({ url: 'smtps://host', permittedTo: 'account-signup@example.invalid', transport });

    const result = await provider.send({ ...MESSAGE, from: 'reports@other-project.example' });
    expect(result.kind).toBe('REFUSED');
    expect(transport).not.toHaveBeenCalled();
  });

  it('reports an unconfigured transport rather than pretending to send', async () => {
    const provider = new SmtpEmailProvider({ url: '', permittedTo: 'account-signup@example.invalid' });
    expect(await provider.send(MESSAGE)).toMatchObject({ kind: 'FAILED', reason: 'NOT_CONFIGURED' });
  });
});

describe('the fallback chain', () => {
  /**
   * Returns the spy alongside the provider.
   *
   * Asserting on `provider.send` directly detaches the method from its object, which
   * is the thing `@typescript-eslint/unbound-method` warns about — and the warning is
   * right: a method read off an object is a different value from the method called on
   * it, and a stub that happened to use `this` would behave differently under each.
   */
  const stub = (id: string, result: EmailResult) => {
    const send = vi.fn().mockResolvedValue(result);
    const provider: EmailProvider = { id, isConfigured: () => true, send };
    return { provider, send };
  };

  it('falls through to SMTP when Resend fails', async () => {
    const { provider: resend } = stub('resend', {
      kind: 'FAILED',
      providerId: 'resend',
      reason: 'HTTP_503',
      retryable: true,
    });
    const { provider: smtp } = stub('smtp', { kind: 'SENT', providerId: 'smtp', messageId: 'x' });

    const { result, attempts } = await sendWithFallback([resend, smtp], MESSAGE);
    expect(result.kind).toBe('SENT');
    expect(attempts).toHaveLength(2);
  });

  it('STOPS on a refusal instead of falling through', async () => {
    /*
     * The most important test in this file.
     *
     * Refusal is a property of the *message*, not the transport. Falling through would
     * deliver exactly the message the first provider refused — a forbidden sending
     * identity or a blocked recipient — which would make the guard decorative while
     * appearing to work.
     */
    const { provider: resend } = stub('resend', {
      kind: 'REFUSED',
      providerId: 'resend',
      reason: 'from address not permitted',
    });
    const { provider: smtp, send: smtpSend } = stub('smtp', { kind: 'SENT', providerId: 'smtp', messageId: 'x' });

    const { result, attempts } = await sendWithFallback([resend, smtp], MESSAGE);
    expect(result.kind).toBe('REFUSED');
    expect(attempts).toHaveLength(1);
    expect(smtpSend).not.toHaveBeenCalled();
  });

  it('stops at the first success', async () => {
    const { provider: resend } = stub('resend', { kind: 'SENT', providerId: 'resend', messageId: 'a' });
    const { provider: smtp, send: smtpSend } = stub('smtp', { kind: 'SENT', providerId: 'smtp', messageId: 'b' });

    const { attempts } = await sendWithFallback([resend, smtp], MESSAGE);
    expect(attempts).toHaveLength(1);
    expect(smtpSend).not.toHaveBeenCalled();
  });

  it('reports the last failure when every provider fails', async () => {
    const { provider: resend } = stub('resend', {
      kind: 'FAILED',
      providerId: 'resend',
      reason: 'HTTP_503',
      retryable: true,
    });
    const { provider: smtp } = stub('smtp', {
      kind: 'FAILED',
      providerId: 'smtp',
      reason: 'ECONNREFUSED',
      retryable: true,
    });

    const { result, attempts } = await sendWithFallback([resend, smtp], MESSAGE);
    expect(result).toMatchObject({ providerId: 'smtp', reason: 'ECONNREFUSED' });
    expect(attempts).toHaveLength(2);
  });

  it('reports a useful failure when nothing is configured at all', async () => {
    const { result } = await sendWithFallback([], MESSAGE);
    expect(result).toMatchObject({ kind: 'FAILED', reason: 'No email provider is configured' });
  });
});
