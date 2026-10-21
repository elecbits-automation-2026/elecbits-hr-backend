import { and, eq, inArray } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import { auditLog, probationReviews, remindersSent } from '../../db/schema/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';

export type ReviewRow = typeof probationReviews.$inferSelect;

export interface ActorContext {
  actorUserId: string | null;
  actorEmployeeId: string | null;
}

export interface Bell {
  to: string[];
  event: NotificationEvent;
}

/** A review joined to the person and their effective RM. */
export interface ReviewViewRow {
  id: string;
  employee_id: string;
  name: string;
  employee_code: string;
  designation: string | null;
  department: string | null;
  date_of_joining: string | null;
  rm_id: string | null;
  rm_name: string | null;
}

const ring = async (tx: DbClient, bells: Bell[]) => {
  for (const b of bells) await insertNotifications(tx, b.to, b.event);
};

/** The only place the probation feature touches the database. */
export const createProbationRepository = (db: DbClient) => ({
  find: async (id: string): Promise<ReviewRow | undefined> =>
    (
      await db.orm
        .select()
        .from(probationReviews)
        .where(eq(probationReviews.id, id))
        .limit(1)
    )[0],

  ofEmployee: async (employeeId: string): Promise<ReviewRow | undefined> =>
    (
      await db.orm
        .select()
        .from(probationReviews)
        .where(eq(probationReviews.employeeId, employeeId))
        .limit(1)
    )[0],

  /** Open reviews plus those decided in the last 120 days. */
  list: (): Promise<ReviewRow[]> =>
    db
      .query<{ id: string }>(
        `SELECT id FROM org.probation_reviews
        WHERE status IN ('pending','recommended') OR created_at > now() - interval '120 days'`,
      )
      .then((rows) =>
        rows.length
          ? db.orm
              .select()
              .from(probationReviews)
              .where(
                inArray(
                  probationReviews.id,
                  rows.map((r) => r.id),
                ),
              )
          : [],
      ),

  people: async (employeeIds: string[]): Promise<Map<string, ReviewViewRow>> => {
    if (employeeIds.length === 0) return new Map();
    const rows = await db.query<ReviewViewRow>(
      `SELECT e.id AS employee_id, e.id, e.name, e.employee_code, e.designation, d.name AS department,
              e.date_of_joining::text, coalesce(e.leave_approver, e.reports_to) AS rm_id, rm.name AS rm_name
         FROM org.employees e
         LEFT JOIN org.departments d ON d.id = e.department_id
         LEFT JOIN org.employees rm ON rm.id = coalesce(e.leave_approver, e.reports_to)
        WHERE e.id = ANY($1::uuid[])`,
      [employeeIds],
    );
    return new Map(rows.map((r) => [r.employee_id, r]));
  },

  names: async (ids: string[]): Promise<Map<string, string>> => {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const rows = await db.query<{ id: string; name: string }>(
      `SELECT id, name FROM org.employees WHERE id = ANY($1::uuid[])`,
      [unique],
    );
    return new Map(rows.map((r) => [r.id, r.name]));
  },

  /** People whose probation ends within [from, to] and have no review yet. */
  dueToOpen: (from: string, to: string) =>
    db.query<{ id: string; name: string; due_on: string; rm_id: string | null }>(
      `SELECT e.id, e.name, e.confirmation_date::text AS due_on,
              coalesce(e.leave_approver, e.reports_to) AS rm_id
         FROM org.employees e
        WHERE e.status = 'active' AND e.confirmation_date BETWEEN $1::date AND $2::date
          AND NOT EXISTS (SELECT 1 FROM org.probation_reviews r WHERE r.employee_id = e.id)
          AND NOT EXISTS (SELECT 1 FROM access.org_owner o WHERE o.employee_id = e.id)`,
      [from, to],
    ),

  /** Open reviews whose date has passed. */
  openPastDue: (today: string) =>
    db.query<{
      id: string;
      employee_id: string;
      name: string;
      due_on: string;
      rm_id: string | null;
    }>(
      `SELECT r.id, r.employee_id, e.name, r.due_on::text, coalesce(e.leave_approver, e.reports_to) AS rm_id
         FROM org.probation_reviews r JOIN org.employees e ON e.id = r.employee_id
        WHERE r.status IN ('pending', 'recommended') AND r.due_on < $1::date AND e.status = 'active'`,
      [today],
    ),

  holidaysBetween: async (from: string, to: string): Promise<Set<string>> =>
    new Set(
      (
        await db.query<{ date: string }>(
          `SELECT date::text FROM org.holidays WHERE date BETWEEN $1::date AND $2::date`,
          [from, to],
        )
      ).map((r) => r.date),
    ),

  lastReminder: async (kind: string, subjectId: string): Promise<Date | null> =>
    (
      await db.query<{ last: Date | null }>(
        `SELECT max(sent_at) AS last FROM ops.reminders_sent WHERE kind = $1 AND subject_id = $2`,
        [kind, subjectId],
      )
    )[0]?.last ?? null,

  /** Bells that count as reminders (one reminders_sent row per recipient). */
  remind: (kind: string, subjectId: string, bell: Bell): Promise<void> =>
    db.transaction(async (tx) => {
      const to = [...new Set(bell.to)];
      if (to.length) {
        await tx.orm
          .insert(remindersSent)
          .values(to.map((recipientId) => ({ kind, subjectId, recipientId })));
      }
      await ring(tx, [bell]);
    }),

  insert: (
    values: typeof probationReviews.$inferInsert,
    actor: ActorContext,
    bells: Bell[],
  ): Promise<string | null> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .insert(probationReviews)
        .values(values)
        .onConflictDoNothing()
        .returning();
      if (!rows[0]) return null;
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'probation.opened',
        subject: `probation_reviews:${rows[0].id}`,
        detail: JSON.stringify({ dueOn: values.dueOn }),
      });
      await ring(tx, bells);
      return rows[0].id;
    }),

  /** Move a review on from the status(es) it is still in; false = it moved meanwhile. */
  transition: (
    id: string,
    from: ReviewRow['status'][],
    patch: Partial<typeof probationReviews.$inferInsert>,
    actor: ActorContext,
    action: string,
    bells: Bell[],
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(probationReviews)
        .set(patch)
        .where(and(eq(probationReviews.id, id), inArray(probationReviews.status, from)))
        .returning();
      if (!rows[0]) return false;
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action,
        subject: `probation_reviews:${id}`,
        detail: JSON.stringify({ status: rows[0].status }),
      });
      await ring(tx, bells);
      return true;
    }),
});

export type ProbationRepository = ReturnType<typeof createProbationRepository>;
