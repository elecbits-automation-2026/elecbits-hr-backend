import { and, asc, eq, inArray } from 'drizzle-orm';
import createError from 'http-errors';
import type { DbClient } from '../../db/client.js';
import { auditLog, pipCheckins, pips, remindersSent } from '../../db/schema/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';

export type PipRow = typeof pips.$inferSelect;
export type CheckinRow = typeof pipCheckins.$inferSelect;

export interface ActorContext {
  actorUserId: string | null;
  actorEmployeeId: string | null;
}
export interface Bell {
  to: string[];
  event: NotificationEvent;
}

const isUniqueViolation = (err: unknown) =>
  (err as { code?: string }).code === '23505' ||
  (err as { cause?: { code?: string } }).cause?.code === '23505';

/** The only place the PIP feature touches the database. Notes never reach the audit log. */
export const createPipRepository = (db: DbClient) => {
  const ring = async (tx: DbClient, bells: Bell[]) => {
    for (const b of bells) await insertNotifications(tx, b.to, b.event);
  };
  const audit = (tx: DbClient, actor: ActorContext, action: string, id: string) =>
    tx.orm.insert(auditLog).values({
      actorUserId: actor.actorUserId,
      action,
      subject: `pips:${id}`,
    });

  return {
    find: async (id: string): Promise<PipRow | undefined> =>
      (await db.orm.select().from(pips).where(eq(pips.id, id)).limit(1))[0],

    /** Live ones plus those closed in the last year. */
    list: (filter: { employeeId?: string } = {}): Promise<PipRow[]> =>
      db
        .query<{ id: string }>(
          `SELECT id FROM org.pips
          WHERE (status IN ('pending_hr','active') OR created_at > now() - interval '365 days')
            ${filter.employeeId ? 'AND employee_id = $1' : ''}`,
          filter.employeeId ? [filter.employeeId] : [],
        )
        .then((rows) =>
          rows.length
            ? db.orm
                .select()
                .from(pips)
                .where(
                  inArray(
                    pips.id,
                    rows.map((r) => r.id),
                  ),
                )
            : [],
        ),

    checkins: async (pipIds: string[]): Promise<CheckinRow[]> =>
      pipIds.length
        ? db.orm
            .select()
            .from(pipCheckins)
            .where(inArray(pipCheckins.pipId, pipIds))
            .orderBy(asc(pipCheckins.on), asc(pipCheckins.createdAt))
        : [],

    people: async (ids: string[]) => {
      const unique = [...new Set(ids.filter(Boolean))];
      if (unique.length === 0) return new Map<string, PersonRow>();
      const rows = await db.query<PersonRow>(
        `SELECT e.id, e.name, e.employee_code, e.designation, e.status,
                coalesce(e.leave_approver, e.reports_to) AS rm_id
           FROM org.employees e WHERE e.id = ANY($1::uuid[])`,
        [unique],
      );
      return new Map(rows.map((r) => [r.id, r]));
    },

    insert: async (
      values: typeof pips.$inferInsert,
      actor: ActorContext,
      bells: Bell[],
    ): Promise<string> => {
      try {
        return await db.transaction(async (tx) => {
          const rows = await tx.orm.insert(pips).values(values).returning();
          await audit(tx, actor, 'pip.opened', rows[0]!.id);
          await ring(tx, bells);
          return rows[0]!.id;
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw createError(409, 'This person already has a PIP open', {
            code: 'PIP_OPEN',
          });
        }
        throw err;
      }
    },

    transition: (
      id: string,
      from: PipRow['status'][],
      patch: Partial<typeof pips.$inferInsert>,
      actor: ActorContext,
      action: string,
      bells: Bell[],
    ): Promise<boolean> =>
      db.transaction(async (tx) => {
        const rows = await tx.orm
          .update(pips)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(pips.id, id), inArray(pips.status, from)))
          .returning();
        if (!rows[0]) return false;
        await audit(tx, actor, action, id);
        await ring(tx, bells);
        return true;
      }),

    addCheckin: (
      values: typeof pipCheckins.$inferInsert,
      actor: ActorContext,
      bells: Bell[],
    ): Promise<void> =>
      db.transaction(async (tx) => {
        await tx.orm.insert(pipCheckins).values(values);
        await audit(tx, actor, 'pip.checkin', values.pipId);
        await ring(tx, bells);
      }),

    lastReminder: async (kind: string, subjectId: string): Promise<Date | null> =>
      (
        await db.query<{ last: Date | null }>(
          `SELECT max(sent_at) AS last FROM ops.reminders_sent WHERE kind = $1 AND subject_id = $2`,
          [kind, subjectId],
        )
      )[0]?.last ?? null,

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

    holidaysBetween: async (from: string, to: string): Promise<Set<string>> =>
      new Set(
        (
          await db.query<{ date: string }>(
            `SELECT date::text FROM org.holidays WHERE date BETWEEN $1::date AND $2::date`,
            [from, to],
          )
        ).map((r) => r.date),
      ),
  };
};

export interface PersonRow {
  id: string;
  name: string;
  employee_code: string;
  designation: string | null;
  status: string;
  rm_id: string | null;
}

export type PipRepository = ReturnType<typeof createPipRepository>;
