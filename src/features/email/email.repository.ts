import { eq } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import { emailOutbox } from '../../db/schema/index.js';
import { createSettingsRepository } from '../settings/index.js';

export type EmailOutboxRow = typeof emailOutbox.$inferSelect;

/** One email to queue. `recipientId` null = an address with no employee yet. */
export interface QueuedEmail {
  recipientId: string | null;
  toAddress: string;
  type: string;
  subject: string;
  body?: string | null;
  link?: string | null;
  dedupeKey?: string | null;
}

/**
 * Event types that must NEVER become an email (privacy rules, learner
 * 2026-11-14): concerns and complaints, POSH, open-door bookings. Refused
 * loudly — a wiring mistake should fail in testing, not leak in production.
 */
const NEVER_EMAILED = [/^concern\./, /^open_door\./, /posh/i];

export const assertEmailSafe = (type: string): void => {
  if (NEVER_EMAILED.some((re) => re.test(type))) {
    throw new Error(`Email refused for "${type}": this event is never emailed`);
  }
};

/**
 * The WRITE side other features use — call it with the transaction that makes
 * the change, so the email lands (or rolls back) with the event itself, like
 * the bell and the audit row. While the Admin switch is off nothing is
 * queued, so turning it on never sends a backlog. Returns how many queued.
 */
export const enqueueEmails = async (
  db: DbClient,
  emails: QueuedEmail[],
): Promise<number> => {
  if (emails.length === 0) return 0;
  for (const e of emails) assertEmailSafe(e.type);
  const { enabled } = await createSettingsRepository(db).effective('email.delivery');
  if (!enabled) return 0;
  const rows = await db.orm
    .insert(emailOutbox)
    .values(
      emails.map((e) => ({
        recipientId: e.recipientId,
        toAddress: e.toAddress.trim().toLowerCase(),
        type: e.type,
        subject: e.subject,
        body: e.body ?? null,
        link: e.link ?? null,
        dedupeKey: e.dedupeKey ?? null,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: emailOutbox.id });
  return rows.length;
};

/** How long a claimed row stays hidden — a sender that dies mid-send retries after this. */
const CLAIM_LEASE_MINUTES = 10;

/** The only place the email feature touches the database. */
export const createEmailRepository = (db: DbClient) => ({
  /**
   * Claim up to `limit` due rows: SKIP LOCKED so two servers never take the
   * same row, and the lease pushes next_attempt_at ahead so a crash between
   * claim and send makes it due again instead of stuck.
   */
  claimDue: (limit: number): Promise<EmailOutboxRow[]> =>
    db.query<EmailOutboxRow>(
      `UPDATE ops.email_outbox o
          SET attempts = o.attempts + 1,
              next_attempt_at = now() + interval '${CLAIM_LEASE_MINUTES} minutes'
         FROM (SELECT id FROM ops.email_outbox
                WHERE status = 'pending' AND next_attempt_at <= now()
                ORDER BY next_attempt_at
                LIMIT $1
                FOR UPDATE SKIP LOCKED) due
        WHERE o.id = due.id
        RETURNING o.id, o.recipient_id AS "recipientId", o.to_address AS "toAddress",
                  o.type, o.subject, o.body, o.link, o.status, o.attempts,
                  o.next_attempt_at AS "nextAttemptAt", o.last_error AS "lastError",
                  o.dedupe_key AS "dedupeKey", o.created_at AS "createdAt",
                  o.sent_at AS "sentAt"`,
      [limit],
    ),

  markSent: async (id: string): Promise<void> => {
    await db.orm
      .update(emailOutbox)
      .set({ status: 'sent', sentAt: new Date(), lastError: null })
      .where(eq(emailOutbox.id, id));
  },

  /** A failed attempt: try again at `retryAt`, or give up (null = failed). */
  markFailedAttempt: async (id: string, error: string, retryAt: Date | null) => {
    await db.orm
      .update(emailOutbox)
      .set(
        retryAt
          ? { lastError: error, nextAttemptAt: retryAt }
          : { status: 'failed', lastError: error },
      )
      .where(eq(emailOutbox.id, id));
  },

  /** Counts for the Admin card: what waits, what failed, what went out lately. */
  stats: async () =>
    (
      await db.query<{
        pending: number;
        failed: number;
        sent_24h: number;
        sent_30d: number;
      }>(
        `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
                count(*) FILTER (WHERE status = 'failed')::int AS failed,
                count(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '1 day')::int AS sent_24h,
                count(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '30 days')::int AS sent_30d
           FROM ops.email_outbox`,
      )
    )[0]!,

  /** The latest emails that gave up, newest first. */
  recentFailures: (limit = 10) =>
    db.query<{
      id: string;
      to_address: string;
      type: string;
      subject: string;
      attempts: number;
      last_error: string | null;
      created_at: Date;
    }>(
      `SELECT id, to_address, type, subject, attempts, last_error, created_at
         FROM ops.email_outbox
        WHERE status = 'failed'
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit],
    ),

  /** Put every failed email back in the queue with a fresh set of attempts. */
  retryFailed: async (): Promise<number> =>
    (
      await db.query<{ id: string }>(
        `UPDATE ops.email_outbox
            SET status = 'pending', attempts = 0, next_attempt_at = now()
          WHERE status = 'failed'
          RETURNING id`,
      )
    ).length,

  /** The actor's own company address — for the test email. */
  employeeEmail: async (employeeId: string): Promise<string | undefined> =>
    (
      await db.query<{ email: string }>(`SELECT email FROM org.employees WHERE id = $1`, [
        employeeId,
      ])
    )[0]?.email,
});

export type EmailRepository = ReturnType<typeof createEmailRepository>;
