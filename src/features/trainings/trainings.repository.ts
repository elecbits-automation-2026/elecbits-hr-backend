import { and, eq, sql } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import {
  auditLog,
  remindersSent,
  trainingCertificates,
  trainings,
} from '../../db/schema/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';
import type { TrainingStream } from './trainings.schema.js';

export type TrainingRow = typeof trainings.$inferSelect;

export interface ActorContext {
  actorUserId: string | null;
  actorEmployeeId: string | null;
}

export interface Bell {
  to: string[];
  event: NotificationEvent;
  /** Also send this bell as an email (email service) — decided where the bell is built. */
  email?: boolean;
  /** Queue the email at most once per key + recipient (retries, double clicks). */
  dedupeKey?: string;
}

/** A training joined with the names the screens show. */
export interface TrainingListRow {
  id: string;
  employee_id: string;
  employee_name: string;
  department_name: string | null;
  title: string;
  stream: TrainingStream;
  description: string | null;
  link: string | null;
  due_on: string | null;
  status: 'assigned' | 'completed' | 'cancelled';
  assigned_by: string;
  assigned_by_name: string;
  assigned_at: Date;
  completed_at: Date | null;
  completion_note: string | null;
  cancelled_at: Date | null;
  cert_file_name: string | null;
  cert_size: number | null;
}

const SELECT = `SELECT t.id, t.employee_id, e.name AS employee_name, d.name AS department_name,
                       t.title, t.stream, t.description, t.link, t.due_on::text AS due_on,
                       t.status, t.assigned_by, a.name AS assigned_by_name, t.assigned_at,
                       t.completed_at, t.completion_note, t.cancelled_at,
                       c.file_name AS cert_file_name, c.size_bytes AS cert_size
                  FROM org.trainings t
                  JOIN org.employees e ON e.id = t.employee_id
                  LEFT JOIN org.departments d ON d.id = e.department_id
                  JOIN org.employees a ON a.id = t.assigned_by
                  LEFT JOIN org.training_certificates c ON c.training_id = t.id`;
const ORDER = `ORDER BY (t.status = 'assigned') DESC, t.due_on NULLS LAST, t.assigned_at DESC`;

const audit = (
  tx: DbClient,
  actor: ActorContext,
  action: string,
  trainingId: string,
  detail?: Record<string, unknown>,
) =>
  tx.orm.insert(auditLog).values({
    actorUserId: actor.actorUserId,
    action,
    subject: `trainings:${trainingId}`,
    detail: detail ? JSON.stringify(detail) : null,
  });

const ring = async (tx: DbClient, bells: Bell[]) => {
  for (const b of bells)
    await insertNotifications(tx, b.to, b.event, {
      email: b.email,
      dedupeKey: b.dedupeKey,
    });
};

/** The only place the trainings feature touches the database. */
export const createTrainingsRepository = (db: DbClient) => ({
  listFor: (employeeIds: string[]) =>
    employeeIds.length === 0
      ? Promise.resolve([] as TrainingListRow[])
      : db.query<TrainingListRow>(
          `${SELECT} WHERE t.employee_id = ANY($1::uuid[]) ${ORDER}`,
          [employeeIds],
        ),

  /** Everyone's (HR overview) — leavers' history stays out of the default view. */
  listAll: () =>
    db.query<TrainingListRow>(`${SELECT} WHERE e.status <> 'inactive' ${ORDER}`),

  one: async (id: string): Promise<TrainingListRow | undefined> =>
    (await db.query<TrainingListRow>(`${SELECT} WHERE t.id = $1`, [id]))[0],

  findById: async (id: string): Promise<TrainingRow | undefined> =>
    (await db.orm.select().from(trainings).where(eq(trainings.id, id)).limit(1))[0],

  /** Reports and leave-approvees of a manager — their "team" for trainings. */
  teamIds: async (rmId: string): Promise<string[]> =>
    (
      await db.query<{ id: string }>(
        `SELECT id FROM org.employees
          WHERE (reports_to = $1 OR leave_approver = $1) AND status <> 'inactive' AND id <> $1`,
        [rmId],
      )
    ).map((r) => r.id),

  people: (ids: string[]) =>
    db.query<{ id: string; name: string; status: string; is_owner: boolean }>(
      `SELECT e.id, e.name, e.status,
              EXISTS (SELECT 1 FROM access.org_owner o WHERE o.employee_id = e.id) AS is_owner
         FROM org.employees e WHERE e.id = ANY($1::uuid[])`,
      [ids],
    ),

  /** People who already have this title open — a second copy is skipped. */
  openWithTitle: async (employeeIds: string[], title: string): Promise<Set<string>> =>
    new Set(
      (
        await db.query<{ employee_id: string }>(
          `SELECT employee_id FROM org.trainings
            WHERE employee_id = ANY($1::uuid[]) AND status = 'assigned'
              AND lower(title) = lower($2)`,
          [employeeIds, title],
        )
      ).map((r) => r.employee_id),
    ),

  assign: (
    rows: Array<typeof trainings.$inferInsert>,
    bells: Bell[],
    actor: ActorContext,
  ): Promise<number> =>
    db.transaction(async (tx) => {
      if (rows.length === 0) return 0;
      const inserted = await tx.orm.insert(trainings).values(rows).returning();
      for (const r of inserted) {
        await audit(tx, actor, 'training.assigned', r.id, {
          employeeId: r.employeeId,
          title: r.title,
          stream: r.stream,
          dueOn: r.dueOn,
          batchId: r.batchId,
        });
      }
      await ring(tx, bells);
      return inserted.length;
    }),

  /** Move a training between states, guarded on the state it was read in. */
  transition: (
    id: string,
    from: TrainingRow['status'],
    patch: Partial<typeof trainings.$inferInsert>,
    action: string,
    bells: Bell[],
    actor: ActorContext,
    detail?: Record<string, unknown>,
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(trainings)
        .set(patch)
        .where(and(eq(trainings.id, id), eq(trainings.status, from)))
        .returning();
      if (!rows[0]) return false;
      await audit(tx, actor, action, id, detail);
      await ring(tx, bells);
      return true;
    }),

  upsertCertificate: (
    file: { trainingId: string; fileName: string; contentType: string; data: Buffer },
    actor: ActorContext,
  ) =>
    db.transaction(async (tx) => {
      const values = {
        trainingId: file.trainingId,
        fileName: file.fileName,
        contentType: file.contentType,
        sizeBytes: file.data.length,
        data: file.data,
        uploadedBy: actor.actorEmployeeId!,
      };
      await tx.orm
        .insert(trainingCertificates)
        .values(values)
        .onConflictDoUpdate({
          target: trainingCertificates.trainingId,
          set: { ...values, uploadedAt: sql`now()` },
        });
      await audit(tx, actor, 'training.certificate_uploaded', file.trainingId, {
        fileName: file.fileName,
        sizeBytes: file.data.length,
      });
    }),

  certificate: async (trainingId: string) =>
    (
      await db.orm
        .select()
        .from(trainingCertificates)
        .where(eq(trainingCertificates.trainingId, trainingId))
        .limit(1)
    )[0],

  /** Open trainings with a due date — what the reminder job looks at. */
  openWithDueDate: () =>
    db.query<{
      id: string;
      employee_id: string;
      assigned_by: string;
      title: string;
      due_on: string;
    }>(
      `SELECT t.id, t.employee_id, t.assigned_by, t.title, t.due_on::text AS due_on
         FROM org.trainings t JOIN org.employees e ON e.id = t.employee_id
        WHERE t.status = 'assigned' AND t.due_on IS NOT NULL AND e.status <> 'inactive'`,
    ),

  reminded: async (kind: string, subjectId: string): Promise<boolean> =>
    (
      await db.query(
        `SELECT 1 FROM ops.reminders_sent WHERE kind = $1 AND subject_id = $2 LIMIT 1`,
        [kind, subjectId],
      )
    ).length > 0,

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
});

export type TrainingsRepository = ReturnType<typeof createTrainingsRepository>;
