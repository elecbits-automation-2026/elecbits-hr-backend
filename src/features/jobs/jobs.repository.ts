import { desc } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import { remindersSent, scheduledJobRuns } from '../../db/schema/index.js';
import { insertNotifications } from '../notifications/index.js';

export type JobRunRow = typeof scheduledJobRuns.$inferSelect;

/** Who an item belongs to, as every pending query returns it. */
interface Owner {
  employee_id: string;
  name: string;
  effective_rm: string | null;
}

/** One reminder to write: the bell + the reminders_sent row. */
export interface ReminderToSend {
  kind: string;
  subjectId: string;
  recipientId: string;
  title: string;
  link: string;
}

const OWNER_COLUMNS = `e.id AS employee_id, e.name, coalesce(e.leave_approver, e.reports_to) AS effective_rm`;

/** The only place the jobs feature touches the database. */
export const createJobsRepository = (db: DbClient) => ({
  /**
   * Claim (job, runKey). A fresh key inserts and runs; a key whose earlier
   * attempt FAILED more than 30 minutes ago is re-claimed (max 3 attempts);
   * anything else returns undefined — someone already ran it or is running it.
   */
  claimRun: async (job: string, runKey: string): Promise<string | undefined> => {
    const rows = await db.query<{ id: string }>(
      `INSERT INTO ops.scheduled_job_runs (job, run_key, status)
       VALUES ($1, $2, 'running')
       ON CONFLICT (job, run_key) DO UPDATE
          SET status = 'running', attempts = ops.scheduled_job_runs.attempts + 1,
              started_at = now(), finished_at = NULL, error = NULL
        WHERE ops.scheduled_job_runs.status = 'failed'
          AND ops.scheduled_job_runs.attempts < 3
          AND ops.scheduled_job_runs.finished_at < now() - interval '30 minutes'
       RETURNING id`,
      [job, runKey],
    );
    return rows[0]?.id;
  },

  finishRun: async (
    id: string,
    outcome:
      { status: 'succeeded'; summary: unknown } | { status: 'failed'; error: string },
  ): Promise<void> => {
    await db.query(
      `UPDATE ops.scheduled_job_runs
          SET status = $2, finished_at = now(), summary = $3, error = $4
        WHERE id = $1`,
      [
        id,
        outcome.status,
        outcome.status === 'succeeded' ? JSON.stringify(outcome.summary) : null,
        outcome.status === 'failed' ? outcome.error : null,
      ],
    );
  },

  listRuns: async (limit: number): Promise<JobRunRow[]> =>
    db.orm
      .select()
      .from(scheduledJobRuns)
      .orderBy(desc(scheduledJobRuns.startedAt))
      .limit(limit),

  /** Holiday dates in [from, to] — working-day counting. */
  holidaysBetween: async (from: string, to: string): Promise<Set<string>> => {
    const rows = await db.query<{ date: string }>(
      `SELECT date::text AS date FROM org.holidays WHERE date BETWEEN $1 AND $2`,
      [from, to],
    );
    return new Set(rows.map((r) => r.date));
  },

  /** Latest reminder per (kind, subject, recipient). */
  lastReminders: async (): Promise<Map<string, Date>> => {
    const rows = await db.query<{ k: string; last: Date }>(
      `SELECT kind || ':' || subject_id || ':' || recipient_id AS k, max(sent_at) AS last
         FROM ops.reminders_sent GROUP BY kind, subject_id, recipient_id`,
      [],
    );
    return new Map(rows.map((r) => [r.k, new Date(r.last)]));
  },

  // ── Pending items, one query per kind ──────────────────────────────────

  pendingLeaves: async () =>
    db.query<
      Owner & {
        id: string;
        start_date: string;
        end_date: string;
        rm_open: boolean;
        hr_open: boolean;
        since: Date;
      }
    >(
      `SELECT l.id, l.start_date::text, l.end_date::text, ${OWNER_COLUMNS},
              (l.rm_required AND l.rm_approved_by IS NULL) AS rm_open,
              (l.hr_required AND l.hr_approved_by IS NULL) AS hr_open,
              greatest(l.created_at, coalesce(l.rm_approved_at, l.created_at),
                       coalesce(l.hr_approved_at, l.created_at)) AS since
         FROM org.leave_requests l JOIN org.employees e ON e.id = l.employee_id
        WHERE l.status IN ('pending', 'partially_approved')`,
      [],
    ),

  pendingRemoteWork: async () =>
    db.query<
      Owner & {
        id: string;
        start_date: string;
        end_date: string;
        rm_open: boolean;
        hr_open: boolean;
        since: Date;
      }
    >(
      `SELECT w.id, w.start_date::text, w.end_date::text, ${OWNER_COLUMNS},
              (w.rm_approved_by IS NULL) AS rm_open,
              (w.hr_approved_by IS NULL) AS hr_open,
              greatest(w.created_at, coalesce(w.rm_approved_at, w.created_at),
                       coalesce(w.hr_approved_at, w.created_at)) AS since
         FROM org.wfh_requests w JOIN org.employees e ON e.id = w.employee_id
        WHERE w.status IN ('pending', 'partially_approved')`,
      [],
    ),

  pendingRegularizations: async () =>
    db.query<Owner & { id: string; date: string; since: Date }>(
      `SELECT r.id, r.date::text, ${OWNER_COLUMNS}, r.created_at AS since
         FROM org.attendance_regularizations r JOIN org.employees e ON e.id = r.employee_id
        WHERE r.status = 'pending'`,
      [],
    ),

  pendingReimbursements: async () =>
    db.query<Owner & { id: string; status: string; amount: string; since: Date }>(
      `SELECT c.id, c.status::text, c.amount, ${OWNER_COLUMNS},
              coalesce(c.rm_decided_at, c.created_at) AS since
         FROM org.reimbursement_claims c JOIN org.employees e ON e.id = c.employee_id
        WHERE c.status IN ('pending_rm', 'pending_payroll')`,
      [],
    ),

  pendingLateUpdates: async () =>
    db.query<Owner & { id: string; date: string; since: Date }>(
      `SELECT u.id, u.date::text, ${OWNER_COLUMNS}, u.created_at AS since
         FROM org.work_updates u JOIN org.employees e ON e.id = u.employee_id
        WHERE u.late_status = 'pending'`,
      [],
    ),

  pendingAccessRequests: async () =>
    db.query<Owner & { id: string; requested_by: string; since: Date }>(
      `SELECT g.id, g.requested_by, ${OWNER_COLUMNS}, g.created_at AS since
         FROM access.grant_requests g JOIN org.employees e ON e.id = g.employee_id
        WHERE g.status = 'pending'`,
      [],
    ),

  pendingNominations: async () =>
    db.query<
      Owner & { id: string; award_name: string | null; nominated_by: string; since: Date }
    >(
      `SELECT r.id, r.award_name, r.nominated_by, ${OWNER_COLUMNS}, r.created_at AS since
         FROM org.recognitions r JOIN org.employees e ON e.id = r.employee_id
        WHERE r.status = 'pending'`,
      [],
    ),

  /**
   * Items past their return date and not back (OPS asset manager): approved
   * gate passes, and lab loans still held. The holder is the pass's
   * requester / the loan's holder; items that left the register are skipped.
   */
  overdueReturns: async (today: string) =>
    db.query<
      Owner & {
        kind: 'pass' | 'loan';
        subject_id: string;
        due_on: string;
        asset_code: string;
        asset_name: string;
        zone_name: string;
      }
    >(
      `SELECT 'pass' AS kind, p.id AS subject_id, p.return_on::text AS due_on,
              a.asset_code, a.name AS asset_name, z.name AS zone_name, ${OWNER_COLUMNS}
         FROM ops.gate_passes p
         JOIN ops.assets a ON a.id = p.asset_id
         JOIN org.punch_zones z ON z.id = a.zone_id
         JOIN org.employees e ON e.id = p.requested_by
        WHERE p.status = 'approved' AND p.return_on < $1::date
          AND a.status NOT IN ('scrapped', 'gifted', 'lost')
       UNION ALL
       SELECT 'loan', a.id, a.loan_due_on::text,
              a.asset_code, a.name, z.name, ${OWNER_COLUMNS}
         FROM ops.assets a
         JOIN org.punch_zones z ON z.id = a.zone_id
         JOIN org.employees e ON e.id = a.holder_id
        WHERE a.status = 'assigned' AND a.loan_due_on < $1::date`,
      [today],
    ),

  /** Owner + SuperAdmins — who decides access requests. */
  accessDeciders: async (): Promise<string[]> => {
    const rows = await db.query<{ id: string }>(
      `SELECT employee_id AS id FROM access.org_owner
       UNION SELECT employee_id FROM access.superadmins`,
      [],
    );
    return rows.map((r) => r.id);
  },

  /** Every reminder's bell + its reminders_sent row, one transaction. */
  sendReminders: async (items: ReminderToSend[]): Promise<void> => {
    if (items.length === 0) return;
    await db.transaction(async (tx) => {
      await tx.orm
        .insert(remindersSent)
        .values(
          items.map((i) => ({
            kind: i.kind,
            subjectId: i.subjectId,
            recipientId: i.recipientId,
          })),
        );
      for (const i of items) {
        await insertNotifications(tx, [i.recipientId], {
          type: 'reminder.approval',
          title: i.title,
          link: i.link,
        });
      }
    });
  },
});

export type JobsRepository = ReturnType<typeof createJobsRepository>;
