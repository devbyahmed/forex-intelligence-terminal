/**
 * The sending-identity guard.
 *
 * Two allowlists of one. The `from` rule stops this project borrowing the sending
 * identity of an unrelated project that shares the Resend account; the `to` rule keeps
 * delivery to the single address an unverified sender is permitted to reach.
 *
 * Both are tested here rather than empirically, and deliberately so: verifying the
 * `from` rule by actually sending from the other project's domain would perform the
 * exact action the guard exists to prevent, and verifying the `to` rule by sending to a
 * disallowed address would deliver the message the guard exists to stop.
 *
 * **Every address below is a placeholder.** This repository is public, so no real
 * address appears in it. The guard's behaviour does not depend on which addresses are
 * used — both rules are equality against a configured value.
 */

import { describe, expect, it } from 'vitest';
import {
  PERMITTED_FROM_ADDRESS,
  SendingIdentityError,
  assertSendingIdentity,
  checkSendingIdentity,
} from './sendingIdentity.js';

/** Stands in for the Resend account signup address, which lives in `.env`. */
const ACCOUNT_ADDRESS = 'account-signup@example.invalid';

const valid = {
  from: PERMITTED_FROM_ADDRESS,
  to: ACCOUNT_ADDRESS,
  permittedTo: ACCOUNT_ADDRESS,
};

describe('the permitted path', () => {
  it('accepts the sandbox sender and the account signup address', () => {
    expect(checkSendingIdentity(valid)).toEqual({ ok: true });
  });

  it('is case- and whitespace-insensitive', () => {
    // A trailing space on a pasted env value must not turn a valid configuration into a
    // refusal — this project has already lost time to exactly that class of bug.
    expect(
      checkSendingIdentity({
        from: ' Onboarding@Resend.dev ',
        to: ' Account-Signup@Example.INVALID ',
        permittedTo: ACCOUNT_ADDRESS,
      }).ok,
    ).toBe(true);
  });

  it('does not throw on the permitted path', () => {
    expect(() => {
      assertSendingIdentity(valid);
    }).not.toThrow();
  });
});

describe('the sender is an allowlist of one', () => {
  it('refuses any address other than the sandbox sender', () => {
    // Not a blocklist of the one domain we happen to know about — that would pass the
    // next domain added to the shared account.
    for (const from of [
      'reports@other-project.example',
      'noreply@forex-terminal.example',
      'a@b.example',
      // A lookalike that a substring check would wave through.
      'onboarding@resend.dev.attacker.example',
    ]) {
      const result = checkSendingIdentity({ ...valid, from });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('FROM_NOT_PERMITTED');
    }
  });

  it('explains the consequence, not just the rule', () => {
    // A refusal that says only "not permitted" invites someone to widen the check. One
    // that names whose reputation is at stake does not.
    const result = checkSendingIdentity({ ...valid, from: 'reports@other-project.example' });
    if (result.ok) throw new Error('expected refusal');

    expect(result.message).toContain('shared with an unrelated project');
    expect(result.message).toContain('reputation');
    expect(result.message).toContain('Resend itself will not stop this');
    expect(result.message).toContain('separate Resend account');
    expect(result.message).toContain('do not widen this check');
  });

  it('throws rather than silently correcting the sender', () => {
    // Quietly rewriting a bad `from` would be worse than refusing: the operator would
    // believe a custom domain was working.
    expect(() => {
      assertSendingIdentity({ ...valid, from: 'reports@other-project.example' });
    }).toThrow(SendingIdentityError);
  });
});

describe('the recipient is an allowlist of one', () => {
  it('refuses any address that is not the configured account address', () => {
    /*
     * The replacement for a blocklist. A blocklist stops only the addresses somebody
     * remembered to add, and its failure mode is silent delivery to the wrong person.
     * This refuses everything not explicitly permitted, including addresses nobody
     * thought about.
     */
    for (const to of [
      'someone-else@example.invalid',
      'colleague@company.example',
      'account-signup@example.com', // right local part, wrong domain
      'account-signup@sub.example.invalid',
    ]) {
      const result = checkSendingIdentity({ ...valid, to });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('TO_NOT_PERMITTED');
    }
  });

  it('says why an allowlist rather than telling the operator to add an exception', () => {
    const result = checkSendingIdentity({ ...valid, to: 'someone-else@example.invalid' });
    if (result.ok) throw new Error('expected refusal');

    expect(result.message).toContain('allowlist rather than a blocklist');
    expect(result.message).toContain('quietly reaching the wrong person');
    expect(result.message).toContain('do not add exceptions here');
  });

  it('does not leak the permitted address in the refusal', () => {
    // The message goes into logs and possibly into an alert. It explains the rule
    // without restating the address the operator is not allowed to reach.
    const result = checkSendingIdentity({ ...valid, to: 'someone-else@example.invalid' });
    if (result.ok) throw new Error('expected refusal');
    expect(result.message).not.toContain(ACCOUNT_ADDRESS);
  });
});

describe('an unconfigured guard fails closed', () => {
  it('refuses when no allowlist is configured at all', () => {
    /*
     * The tempting alternative — skip the recipient check when nothing is configured —
     * would let a missing environment variable silently disable the guard. That is the
     * precise failure mode an allowlist exists to avoid, so it fails closed instead.
     */
    const result = checkSendingIdentity({ ...valid, permittedTo: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('ALLOWLIST_MISSING');
    expect(result.message).toContain('rather than treating an unconfigured guard');
  });

  it('refuses an empty sender rather than defaulting', () => {
    const result = checkSendingIdentity({ ...valid, from: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('FROM_MISSING');
    expect(result.message).toContain('set it explicitly');
  });

  it('refuses an empty recipient rather than defaulting', () => {
    const result = checkSendingIdentity({ ...valid, to: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('TO_MISSING');
  });
});

describe('no real address appears in this file', () => {
  it('uses only reserved placeholder domains', () => {
    // `.invalid` and `.example` are reserved by RFC 2606 and RFC 6761 — they can never
    // be registered, so a placeholder here can never become someone's real address.
    // Asserted rather than trusted to review, because this repository is public.
    for (const address of [ACCOUNT_ADDRESS, PERMITTED_FROM_ADDRESS]) {
      const domain = address.slice(address.lastIndexOf('@') + 1);
      const reserved = /\.(invalid|example|test|localhost)$/.test(domain);
      // `resend.dev` is the one real domain here, and it is a vendor sandbox sender
      // rather than anybody's mailbox.
      expect(reserved || domain === 'resend.dev').toBe(true);
    }
  });
});
