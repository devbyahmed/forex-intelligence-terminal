/**
 * Who this project may send as, and who it may send to.
 *
 * Both are **allowlists of exactly one**, and that shape is the point.
 *
 * An earlier version guarded the recipient with a blocklist. A blocklist is only as
 * good as the addresses somebody remembered to add, and its failure mode is silent
 * delivery to the wrong place — the message goes out, nothing errors, and nobody
 * notices until the wrong person replies. An allowlist fails the other way: an address
 * nobody thought about is refused, loudly, before any network call.
 *
 * The real invariant is narrow and easy to state:
 *
 * > **While no domain is verified for this project, mail may only be sent as the Resend
 * > sandbox sender, and only to the Resend account's own signup address.**
 *
 * That is Resend's own restriction on an unverified sender, and encoding it here means
 * the system refuses a misconfiguration rather than discovering it from a bounce — or
 * worse, from a successful delivery to somebody who should never have received it.
 *
 * **The `from` rule matters independently.** The Resend account is shared with an
 * unrelated project that owns a verified domain. A request sending as that domain may
 * well be *accepted*, because the API cannot tell which project issued it — so the only
 * thing standing between a config typo and this project borrowing another project's
 * sending reputation is this check. It fails closed and never falls back to a default,
 * because a silent correction would leave an operator believing a custom sender worked.
 *
 * No real address appears in this file or its tests. The permitted recipient is
 * supplied by configuration, and this repository is public.
 */

/** The sandbox sender Resend gives every account. The only sender this project owns. */
export const PERMITTED_FROM_ADDRESS = 'onboarding@resend.dev';

export const SENDING_IDENTITY_FAILURES = [
  'FROM_NOT_PERMITTED',
  'FROM_MISSING',
  'TO_MISSING',
  'TO_NOT_PERMITTED',
  'ALLOWLIST_MISSING',
] as const;
export type SendingIdentityFailure = (typeof SENDING_IDENTITY_FAILURES)[number];

export type SendingIdentityCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: SendingIdentityFailure; readonly message: string };

function normalise(address: string): string {
  return address.trim().toLowerCase();
}

/** The domain part, or an empty string when the address is malformed. */
function domainOf(address: string): string {
  const at = address.lastIndexOf('@');
  return at === -1 ? '' : address.slice(at + 1);
}

export interface SendingIdentityParams {
  readonly from: string;
  readonly to: string;
  /**
   * The Resend account's signup address — the only recipient an unverified sender may
   * reach. Supplied from `RESEND_ACCOUNT_ADDRESS`.
   *
   * Deliberately a **separate** configuration value from `REPORT_TO_EMAIL`. If the
   * guard read the same variable it is guarding, it would compare a value against
   * itself and pass every time; requiring two values means changing where reports go
   * takes a deliberate, visible edit in two places rather than one slip.
   */
  readonly permittedTo: string;
}

/**
 * Check a from/to pair before any network call.
 *
 * A pure function of configuration, so both failures it prevents are caught without
 * touching the network. A check that only runs when a send is attempted is a check that
 * first fires in production.
 */
export function checkSendingIdentity(params: SendingIdentityParams): SendingIdentityCheck {
  const from = normalise(params.from);
  const to = normalise(params.to);
  const permittedTo = normalise(params.permittedTo);

  if (from === '') {
    return {
      ok: false,
      reason: 'FROM_MISSING',
      message:
        'REPORT_FROM_EMAIL is not set. This project sends only as ' +
        `${PERMITTED_FROM_ADDRESS}; set it explicitly rather than relying on a default.`,
    };
  }

  if (to === '') {
    return {
      ok: false,
      reason: 'TO_MISSING',
      message:
        'REPORT_TO_EMAIL is not set. On the restricted sending path there is exactly one ' +
        'valid recipient, so there is no default to fall back to.',
    };
  }

  if (permittedTo === '') {
    /*
     * An empty allowlist must fail closed.
     *
     * The tempting alternative — skip the recipient check when no allowlist is
     * configured — would mean a missing environment variable silently disables the
     * guard, which is the exact failure mode allowlists exist to avoid.
     */
    return {
      ok: false,
      reason: 'ALLOWLIST_MISSING',
      message:
        'RESEND_ACCOUNT_ADDRESS is not set, so there is no allowlist to check the recipient ' +
        'against. Refusing to send rather than treating an unconfigured guard as an absent ' +
        'restriction. Set it to the Resend account\'s signup address — while no domain is ' +
        'verified, that is the only address Resend will deliver to.',
    };
  }

  if (from !== PERMITTED_FROM_ADDRESS) {
    const domain = domainOf(from);
    return {
      ok: false,
      reason: 'FROM_NOT_PERMITTED',
      message:
        `Refusing to send: REPORT_FROM_EMAIL is "${params.from}", but this project may only ` +
        `send as ${PERMITTED_FROM_ADDRESS}.\n\n` +
        'The Resend account is shared with an unrelated project that owns a verified domain. ' +
        `Sending as ${domain === '' ? 'a custom address' : `"${domain}"`} would use that ` +
        "project's sending identity — its domain reputation, its DMARC alignment and its " +
        'bounce history — for mail this project generated. Resend itself will not stop this, ' +
        'because the API cannot tell which project issued the request.\n\n' +
        'The restricted path is deliberate. If this project needs its own sending domain, ' +
        'verify one on a separate Resend account and update PERMITTED_FROM_ADDRESS with that ' +
        'decision recorded — do not widen this check to make a config change work.',
    };
  }

  if (to !== permittedTo) {
    return {
      ok: false,
      reason: 'TO_NOT_PERMITTED',
      message:
        'Refusing to send: the configured recipient is not the Resend account signup ' +
        'address.\n\n' +
        'While no domain is verified for this project, Resend delivers only to the account ' +
        'signup address, and this check enforces the same rule before the request is made. ' +
        'An allowlist rather than a blocklist, deliberately: a blocklist only stops the ' +
        'addresses somebody remembered to add, and its failure mode is a message quietly ' +
        'reaching the wrong person.\n\n' +
        'To send elsewhere, verify a domain on a Resend account belonging to this project ' +
        'and record that decision — do not add exceptions here.',
    };
  }

  return { ok: true };
}

export class SendingIdentityError extends Error {
  readonly reason: SendingIdentityFailure;

  constructor(check: Extract<SendingIdentityCheck, { ok: false }>) {
    super(check.message);
    this.name = 'SendingIdentityError';
    this.reason = check.reason;
  }
}

/** Throwing form, for the send path. */
export function assertSendingIdentity(params: SendingIdentityParams): void {
  const check = checkSendingIdentity(params);
  if (!check.ok) throw new SendingIdentityError(check);
}
