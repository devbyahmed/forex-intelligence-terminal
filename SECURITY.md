# SECURITY

Security decisions for the AI Trading Intelligence Terminal, and the reasoning behind
them. Covers master PRD §3, §41, §42, §53 and §54.

**Last reviewed:** 2026-08-30 (Phase 3 of V1)

---

## 1. Password hashing

**Algorithm: Argon2id. Parameters: m=47104 (46 MiB), t=1, p=1.**

Implementation: [`@node-rs/argon2`](https://www.npmjs.com/package/@node-rs/argon2), a
Rust binding shipping prebuilt binaries. Pure-JavaScript implementations are far too
slow to run at safe parameters, and `node-argon2` requires a native toolchain — which
fails on a stock Windows machine and complicates serverless bundling.

### Why these parameters

The OWASP Password Storage Cheat Sheet lists five configurations of **equivalent
strength**, trading memory against iterations:

| Memory | Iterations | Parallelism |
|---|---|---|
| **47104 KiB (46 MiB)** | **1** | **1** | ← chosen |
| 19456 KiB (19 MiB) | 2 | 1 |
| 12288 KiB (12 MiB) | 3 | 1 |
| 9216 KiB (9 MiB) | 4 | 1 |
| 7168 KiB (7 MiB) | 5 | 1 |

We took the high-memory, single-pass option rather than the more commonly quoted
19 MiB / t=2 baseline, for two reasons specific to this deployment:

1. **Memory is the attacker's bottleneck.** Argon2's resistance to GPU and ASIC
   cracking comes from memory hardness, not iteration count. At equivalent defender
   cost, 46 MiB is the harder target to parallelise on commodity cracking hardware.
2. **The primary target bills CPU, not memory.** Vercel functions are provisioned at
   2 GB regardless of use and charge for active CPU time. Spending RAM already paid
   for to buy back CPU is strictly better here, and it lowers login latency on a
   cold start.

The architecture document originally specified m=19456, t=2, p=1. That is still a
valid OWASP configuration; the change was made after verifying current guidance
directly rather than carrying forward a number from a draft.

### Operational properties

- **Salts** are generated per hash by the library. Two identical passwords produce
  different hashes.
- **Parameters live inside the hash** (PHC string format), so raising cost later is
  safe: `needsRehash()` detects an out-of-date hash and the login path silently
  upgrades it. **Raising cost never requires a password reset.**
- **No pepper.** A pepper is a shared secret that must be stored outside the database
  and can never be rotated without resetting every password. For a single-tenant
  private tool where the application secret and the database live on the same
  infrastructure, it adds key-management risk without a meaningful threat reduction.
  Revisit if the database is ever hosted somewhere the application secrets are not.
- **Input bounds:** minimum 12 characters, maximum 1024 bytes. The maximum is a
  denial-of-service control — hashing is deliberately expensive, so unbounded input is
  a cheap way to burn CPU.
- Verification **fails closed** on a malformed hash rather than throwing, so a corrupt
  row cannot surface a stack trace from the login endpoint.

---

## 2. Account enumeration resistance

A login endpoint that behaves differently for "no such account" and "wrong password"
is an account enumerator. Knowing which addresses are registered is the first step of
a credential-stuffing campaign, so both are made indistinguishable in **three**
respects:

| Signal | Control |
|---|---|
| **Message** | Both return the identical `AuthError` text: *"Invalid email or password."* |
| **Status code** | Both return the same error code and HTTP status. |
| **Timing** | When no account matches, the submitted password is verified against a **precomputed dummy hash** at the same parameters. Both branches perform exactly one Argon2 verification. |

**A deactivated account is treated the same way** — same message, and the hash work is
still performed — so deactivation is not observable from outside either.

Both properties are tested explicitly, including a timing test comparing the
unknown-account and wrong-password paths as a ratio.

---

## 3. Sessions

- **Opaque random tokens**, 256 bits from `crypto.randomBytes`, base64url-encoded.
  Not JWTs: a self-validating token cannot be revoked before it expires, and immediate
  revocation matters more here than saving one query per request.
- **Only the SHA-256 hash is stored.** A database leak yields no usable session.
  SHA-256 rather than Argon2 because the input is already 256 bits of entropy — there
  is nothing to brute-force, and paying a KDF cost on every request would be waste.
- **Lookup is by hash on a unique index**, so there is no timing signal from
  comparison, and the raw token never appears in a query.
- **Cookie attributes:** `HttpOnly` (out of reach of XSS), `Secure` (never sent over
  plaintext; omitted only for local HTTP development), `SameSite=Lax`, `Path=/`.

### Expiry — three independent rules

| Rule | Value | Purpose |
|---|---|---|
| Sliding idle expiry | 7 days, refreshed on use | Ends abandoned sessions |
| **Absolute cap** | **30 days from issue, never extended** | Ensures "sliding" does not mean "never expires" |
| `session_epoch` | Bumped on any credential change | Invalidates everything issued earlier |

The sliding refresh is throttled to once per hour: refreshing an expiry that is days
away buys no security and costs a write against a metered compute budget.

Validation is a **single query** joining sessions to users and checking revocation,
idle expiry, absolute cap, user activation and epoch together. That is both cheaper
(one round trip on a database that may be waking from scale-to-zero) and safer — one
predicate cannot be partially applied by a future caller.

### Password change rotates the session

On a password change, **every session is revoked and a new one is issued** for the
caller, rather than sparing the current session in place.

1. Rotating the token on a credential change is standard defence against session
   fixation — if the old token had leaked, changing the password should retire it.
2. `session_epoch` then has no exceptions. Sparing the current session would make the
   rule "every session issued before the epoch is invalid, *except this one*", and an
   authentication rule with a carve-out is where bugs live.

The user stays logged in — the cookie is replaced in the same response. Other devices
are logged out, which is the point.

---

## 4. Rate limiting and lockout

**All state lives in Postgres.** Nothing is held in process memory, and nothing is
derived from anything the client controls beyond the identifier it is attacking.

This is not a stylistic choice. The primary deployment target is serverless: there is
no long-lived process, every request may land on a fresh instance, and an in-memory
limiter would reset constantly — giving an attacker effectively unlimited attempts
while passing every local test. The persistence requirement is covered by a test that
opens a **second connection**, standing in for a cold instance, and asserts the
lockout is still in force.

Two independent limits, stricter wins:

| Limit | Default | Prevents |
|---|---|---|
| Per account | 5 failures / 15 min | One account ground down from many addresses |
| Per IP address | 20 failures / 15 min | One host spraying many accounts |

- **Progressive lockout**: 60 s, doubling per additional threshold-worth of failures,
  capped at 1 hour. A fixed delay is trivially waited out; unbounded growth would let
  one bad typing streak lock the owner out for days.
- **Successes are recorded too, and reset the count.** Without that, the limiter
  cannot distinguish an attack from ordinary use and would never clear.
- **Identifiers are normalised** (trimmed, lowercased) so casing cannot dodge the limit.
- The limit is checked **before** any password verification, so an attacker cannot
  force us to perform Argon2 work.
- Attempt history is pruned on a retention window.

---

## 5. CSRF

Double-submit token, **HMAC-signed** with `CSRF_SECRET`:

- Issued in a non-`HttpOnly` cookie (the frontend must read it) and echoed in the
  `x-csrf-token` header.
- Both halves must match, compared in constant time, **and** the signature must verify.
- Signing matters: without it, an attacker who can set cookies on the domain — via a
  subdomain takeover, say — could pair a forged cookie with a matching header. Without
  the server secret they cannot mint a token we accept.
- Required on every unsafe method, alongside `Origin` / `Sec-Fetch-Site` checks
  (added with the HTTP layer in Phase 10).

---

## 6. Constant-time comparison

Every secret comparison uses `crypto.timingSafeEqual`. `===` on a secret returns at
the first differing byte, which leaks its contents one character at a time to an
attacker who can measure response time.

Lengths are compared first and short-circuited — a length difference is not secret,
and `timingSafeEqual` throws on mismatched buffers.

Applies to: session tokens (implicitly, via hash lookup), CSRF tokens, and any future
API key or webhook signature.

---

## 7. Secrets

- Every secret lives in an environment variable, read **only** in `packages/config`.
  An ESLint rule fails the build on `process.env` anywhere else.
- `SESSION_SECRET` and `CSRF_SECRET` must be at least 32 characters and, in
  production, must differ from one another.
- `.env` is git-ignored. CI has two guards: **gitleaks over full history**, and a check
  that fails the build if any tracked file matches `.env` other than `.env.example`.
  The repository is public, so a committed secret is irreversible the moment it is
  pushed.
- **No `NEXT_PUBLIC_*` variable ever holds a credential.**
- Logging redaction is configured once in `packages/config/logger.ts` by path —
  `password`, `token`, `apiKey`, `authorization`, `cookie`, and each named secret —
  rather than left to call-site discipline. `safeUrl()` strips credentials and
  key-like query parameters before a URL is logged, because provider URLs routinely
  carry the API key inline.

---

## 8. Third-party data handling

- **Gemini free tier uses submitted content to improve Google's products.** Evidence
  bundles contain only public market data — prices, official statistics, published
  news — and no personal information. Accepted deliberately; recorded here so the
  trade-off is explicit rather than assumed.
- Provider responses are archived for auditability but are **never echoed to a
  client**, since an error body can contain a key sent back verbatim.

---

## 9. Error handling

Every error carries two messages: `userMessage` (safe to return over HTTP) and
`detail` (logs only). The split is structural — leaking a connection string to a
client requires deliberately reaching for the wrong field. Unrecognised throws are
normalised to a generic internal error, so a stray provider exception cannot leak its
message.

---

## 10. Still to come

| Control | Phase |
|---|---|
| `Origin` / `Sec-Fetch-Site` checks, security headers, CSP | 10 |
| HTTPS enforcement and HSTS at the proxy | 12 |
| Dependency audit in CI | 12 |
| Full penetration checklist against master PRD §53 | 12 |
| Chrome extension isolation (no keys, CORS pinned to extension id) | V7 |

---

## 11. Reporting

This is a private single-user tool with no public sign-up. If you find a problem,
open an issue on the repository — no sensitive data is expected to be involved, but
avoid including live tokens or connection strings in the report.
