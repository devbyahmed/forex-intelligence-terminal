/**
 * Identity and access (master PRD §3, §53).
 *
 * Multi-user from the first migration even though V1 ships one account, so adding a
 * trusted friend is an INSERT rather than a migration.
 */

import { sql } from 'drizzle-orm';
import { boolean, index, inet, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { fkId, primaryId, timestamps } from './columns.js';

export const users = pgTable(
  'users',
  {
    id: primaryId(),
    email: text('email').notNull(),
    /** argon2id. The plaintext password never exists outside the request that set it. */
    passwordHash: text('password_hash').notNull(),
    displayName: text('display_name'),
    isActive: boolean('is_active').notNull().default(true),
    /** Bumped on password change to invalidate every other session at once. */
    sessionEpoch: timestamp('session_epoch', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    // Case-insensitive uniqueness: Sam@example.invalid and sam@example.invalid are one account, and
    // allowing both would let an attacker register a near-duplicate of a real user.
    uniqueIndex('users_email_lower_idx').on(sql`lower(${t.email})`),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: primaryId(),
    userId: fkId('user_id', () => users.id)
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /**
     * SHA-256 of the opaque session token. The token itself is never stored, so a
     * database leak does not hand over live sessions.
     */
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** Sliding expiry is capped by this, so a session cannot live forever. */
    absoluteExpiresAt: timestamp('absolute_expires_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_idx').on(t.tokenHash),
    index('sessions_user_id_idx').on(t.userId),
    index('sessions_expires_at_idx').on(t.expiresAt),
  ],
);

/**
 * Login attempt ledger, for rate limiting and lockout (master PRD §3).
 *
 * Attempts are recorded against both the identifier and the IP so neither a single
 * account nor a single source can be hammered. Successful attempts are recorded too
 * — a lockout that ignores them cannot distinguish a burst of failures from normal use.
 */
export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: primaryId(),
    /** Lowercased email as submitted. Never the password, not even hashed. */
    identifier: text('identifier').notNull(),
    ipAddress: inet('ip_address'),
    succeeded: boolean('succeeded').notNull(),
    attemptedAt: timestamp('attempted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('login_attempts_identifier_time_idx').on(t.identifier, t.attemptedAt),
    index('login_attempts_ip_time_idx').on(t.ipAddress, t.attemptedAt),
  ],
);

/** Security-relevant events (master PRD §42). Never contains credentials. */
export const auditEvents = pgTable(
  'audit_events',
  {
    id: primaryId(),
    userId: fkId('user_id', () => users.id).references(() => users.id, { onDelete: 'set null' }),
    /** 'LOGIN' | 'LOGOUT' | 'PASSWORD_CHANGE' | 'SESSION_REVOKED' | ... */
    eventType: text('event_type').notNull(),
    ipAddress: inet('ip_address'),
    userAgent: text('user_agent'),
    /** Structured context. Redacted before write; must never hold a secret. */
    detail: text('detail'),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('audit_events_user_time_idx').on(t.userId, t.occurredAt),
    index('audit_events_type_time_idx').on(t.eventType, t.occurredAt),
  ],
);
