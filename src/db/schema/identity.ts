import { boolean, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { employees } from './employees.js';

/**
 * Sign-in identities. Deliberately separate from `org.employees`: HRBP creates
 * the employee record first (top-down, §5.3), and the person later claims it by
 * signing in with their company email (§5.4) — at which point a `users` row is
 * created and linked. Company-email-only is enforced in the auth service.
 *
 * No Supabase / external IdP: credentials are a local bcrypt hash and sessions
 * are short-lived JWTs. Grants are NOT embedded in the token — they are checked
 * server-side per request so revocation is immediate (§10).
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    // The employee record this identity claimed (§5.4). One-to-one.
    employeeId: uuid('employee_id')
      .notNull()
      .unique()
      .references(() => employees.id),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('users_email_idx').on(t.email)],
);

/**
 * Refresh tokens (refinement plan X1). The access JWT stays short-lived; this
 * long-lived, single-use token renews it. Only the sha256 HASH is stored —
 * the raw token lives in an httpOnly cookie. Every use ROTATES it: the
 * presented row is revoked ('rotated') and a new one joins the same FAMILY
 * (one family = one sign-in). Presenting an already-rotated token outside the
 * short multi-tab grace window is treated as theft and revokes the whole
 * family ('reuse'). Logout revokes the family; deactivation revokes every
 * family of the user.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** 'rotated' | 'logout' | 'reuse' | 'deactivated' */
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    index('refresh_tokens_user_idx').on(t.userId),
    index('refresh_tokens_family_idx').on(t.familyId),
  ],
);
