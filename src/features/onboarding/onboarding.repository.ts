import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import {
  auditLog,
  employees,
  onboardingJourneys,
  onboardingTaskFiles,
  onboardingTasks,
  policies,
  policyAcks,
} from '../../db/schema/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';
import type { TemplateTask } from './onboarding.template.js';

export type JourneyRow = typeof onboardingJourneys.$inferSelect;
export type TaskRow = typeof onboardingTasks.$inferSelect;

/** Who performed the mutation — for the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

/** The only place the onboarding feature touches the database. */
export const createOnboardingRepository = (db: DbClient) => ({
  findEmployee: async (employeeId: string) => {
    const rows = await db.orm
      .select({
        id: employees.id,
        name: employees.name,
        employeeCode: employees.employeeCode,
        status: employees.status,
        dateOfJoining: employees.dateOfJoining,
        reportsTo: employees.reportsTo,
        leaveApprover: employees.leaveApprover,
      })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);
    return rows[0];
  },

  findJourneyByEmployee: async (employeeId: string): Promise<JourneyRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(onboardingJourneys)
      .where(eq(onboardingJourneys.employeeId, employeeId))
      .limit(1);
    return rows[0];
  },

  findJourneyById: async (id: string): Promise<JourneyRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(onboardingJourneys)
      .where(eq(onboardingJourneys.id, id))
      .limit(1);
    return rows[0];
  },

  /** Journey + its copied template tasks + audit, one transaction (§10). */
  /**
   * Steps that finish on their own, worked out from the records: payroll when
   * a CTC and bank account + IFSC are on the salary record; the account step
   * once the joiner has claimed their login. (OPS decides and ticks the asset
   * step itself — there is no designation kit any more, 2026-11-05.)
   */
  autoDone: async (employeeId: string): Promise<{ payroll: boolean; claim: boolean }> => {
    const rows = await db.query<{ payroll: boolean; claim: boolean }>(
      `SELECT coalesce((SELECT ctc IS NOT NULL AND bank_account_no IS NOT NULL AND ifsc_code IS NOT NULL
                           FROM org.employee_salary WHERE employee_id = $1), false) AS payroll,
              EXISTS (SELECT 1 FROM users u WHERE u.employee_id = $1) AS claim`,
      [employeeId],
    );
    return { payroll: rows[0]?.payroll ?? false, claim: rows[0]?.claim ?? false };
  },

  /** Journeys of the people whose effective RM is `rmId` (the RM's Onboarding → My team). */
  journeysForRm: async (rmId: string) =>
    db.orm
      .select({
        row: onboardingJourneys,
        employeeName: employees.name,
        employeeCode: employees.employeeCode,
      })
      .from(onboardingJourneys)
      .innerJoin(employees, eq(onboardingJourneys.employeeId, employees.id))
      .where(
        and(
          sql`coalesce(${employees.leaveApprover}, ${employees.reportsTo}) = ${rmId}`,
          ne(employees.status, 'inactive'),
        ),
      )
      .orderBy(asc(onboardingJourneys.status), asc(onboardingJourneys.dueOn)),

  /** Open journeys' tasks owned by OPS or payroll, with the joiner. */
  teamTasks: (owner: 'ops' | 'payroll') =>
    db.query<{
      task_id: string;
      title: string;
      done_at: Date | null;
      done_note: string | null;
      employee_id: string;
      name: string;
      employee_code: string;
      designation: string | null;
      date_of_joining: string | null;
    }>(
      `SELECT t.id AS task_id, t.title, t.done_at, t.done_note, e.id AS employee_id, e.name, e.employee_code,
              e.designation, e.date_of_joining::text
         FROM org.onboarding_tasks t
         JOIN org.onboarding_journeys j ON j.id = t.journey_id
         JOIN org.employees e ON e.id = j.employee_id
        WHERE t.owner = $1 AND j.status = 'open' AND e.status <> 'inactive'
        ORDER BY e.date_of_joining NULLS LAST, e.name`,
      [owner],
    ),

  insertJourney: async (
    input: { employeeId: string; startedOn: string; dueOn: string },
    template: TemplateTask[],
    actor: ActorContext,
    bells: Array<{ to: string[]; event: NotificationEvent }> = [],
  ): Promise<JourneyRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm.insert(onboardingJourneys).values(input).returning();
      const journey = rows[0]!;
      await tx.orm.insert(onboardingTasks).values(
        template.map((t, i) => ({
          journeyId: journey.id,
          seq: i + 1,
          phase: t.phase,
          taskKey: t.key,
          title: t.title,
          owner: t.owner,
          policyCode: t.policyCode ?? null,
        })),
      );
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'onboarding.started',
        subject: `employees:${input.employeeId}`,
        detail: JSON.stringify({ startedOn: input.startedOn, tasks: template.length }),
      });
      for (const b of bells) await insertNotifications(tx, b.to, b.event);
      return journey;
    });
  },

  listTasks: async (journeyId: string): Promise<TaskRow[]> => {
    return db.orm
      .select()
      .from(onboardingTasks)
      .where(eq(onboardingTasks.journeyId, journeyId))
      .orderBy(asc(onboardingTasks.seq));
  },

  findTask: async (taskId: string): Promise<TaskRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(onboardingTasks)
      .where(eq(onboardingTasks.id, taskId))
      .limit(1);
    return rows[0];
  },

  /** Tick or untick + audit, one transaction. */
  setTaskDone: async (
    task: TaskRow,
    done: boolean,
    note: string | null,
    actor: ActorContext,
  ): Promise<TaskRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(onboardingTasks)
        .set(
          done
            ? { doneAt: new Date(), doneBy: actor.actorEmployeeId, doneNote: note }
            : { doneAt: null, doneBy: null, doneNote: null },
        )
        .where(eq(onboardingTasks.id, task.id))
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'onboarding.task_toggled',
        subject: `onboarding_journeys:${task.journeyId}`,
        detail: JSON.stringify({ taskKey: task.taskKey, done, note }),
      });
      return rows[0]!;
    });
  },

  /** File name / size / when for each task that has one (no bytes). */
  fileMeta: async (
    taskIds: string[],
  ): Promise<Map<string, { fileName: string; sizeBytes: number; uploadedAt: Date }>> => {
    if (taskIds.length === 0) return new Map();
    const rows = await db.orm
      .select({
        taskId: onboardingTaskFiles.taskId,
        fileName: onboardingTaskFiles.fileName,
        sizeBytes: onboardingTaskFiles.sizeBytes,
        uploadedAt: onboardingTaskFiles.uploadedAt,
      })
      .from(onboardingTaskFiles)
      .where(inArray(onboardingTaskFiles.taskId, taskIds));
    return new Map(rows.map(({ taskId, ...m }) => [taskId, m]));
  },

  findTaskFile: async (taskId: string) => {
    const rows = await db.orm
      .select()
      .from(onboardingTaskFiles)
      .where(eq(onboardingTaskFiles.taskId, taskId))
      .limit(1);
    return rows[0];
  },

  /** Store (or replace) the task's file and mark the task done, with audit, in one transaction. */
  saveTaskFile: async (
    task: TaskRow,
    file: { fileName: string; contentType: string; data: Buffer },
    actor: ActorContext,
  ): Promise<void> => {
    await db.transaction(async (tx) => {
      const values = {
        fileName: file.fileName,
        contentType: file.contentType,
        sizeBytes: file.data.length,
        data: file.data,
        uploadedBy: actor.actorEmployeeId,
        uploadedAt: new Date(),
      };
      await tx.orm
        .insert(onboardingTaskFiles)
        .values({ taskId: task.id, ...values })
        .onConflictDoUpdate({ target: onboardingTaskFiles.taskId, set: values });
      await tx.orm
        .update(onboardingTasks)
        .set({ doneAt: new Date(), doneBy: actor.actorEmployeeId })
        .where(eq(onboardingTasks.id, task.id));
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'onboarding.task_file_uploaded',
        subject: `onboarding_journeys:${task.journeyId}`,
        detail: JSON.stringify({ taskKey: task.taskKey, fileName: file.fileName, bytes: file.data.length }),
      });
    });
  },

  setJourneyStatus: async (journeyId: string, status: 'open' | 'done'): Promise<void> => {
    await db.orm
      .update(onboardingJourneys)
      .set({ status, updatedAt: new Date() })
      .where(eq(onboardingJourneys.id, journeyId));
  },

  /** HR queue: every journey with its person. TODO(skeleton): scope filter. */
  listJourneys: async () => {
    return db.orm
      .select({
        row: onboardingJourneys,
        employeeName: employees.name,
        employeeCode: employees.employeeCode,
      })
      .from(onboardingJourneys)
      .innerJoin(employees, eq(onboardingJourneys.employeeId, employees.id))
      .orderBy(asc(onboardingJourneys.status), asc(onboardingJourneys.dueOn));
  },

  tasksForJourneys: async (journeyIds: string[]): Promise<TaskRow[]> => {
    if (journeyIds.length === 0) return [];
    return db.orm
      .select()
      .from(onboardingTasks)
      .where(inArray(onboardingTasks.journeyId, journeyIds))
      .orderBy(asc(onboardingTasks.seq));
  },

  /** Display names for a set of employee ids — done-by decoration. */
  namesByIds: async (ids: string[]): Promise<Map<string, string>> => {
    if (ids.length === 0) return new Map();
    const rows = await db.orm
      .select({ id: employees.id, name: employees.name })
      .from(employees)
      .where(inArray(employees.id, ids));
    return new Map(rows.map((r) => [r.id, r.name]));
  },

  /**
   * Policy-task resolution for ONE employee: for each code, the policy row id
   * and whether this employee has ever acknowledged it (any version — reading
   * it at joining stays done; version currency is the Policies tracker's job).
   * A RETIRED policy no longer needs signing, so its task counts as done.
   */
  policyStates: async (
    employeeId: string,
    codes: string[],
  ): Promise<Map<string, { policyId: string; acked: boolean; ackedAt: Date | null }>> => {
    if (codes.length === 0) return new Map();
    const rows = await db.orm
      .select({ id: policies.id, code: policies.code, retiredAt: policies.retiredAt })
      .from(policies)
      .where(inArray(policies.code, codes));
    const result = new Map<
      string,
      { policyId: string; acked: boolean; ackedAt: Date | null }
    >();
    if (rows.length === 0) return result;
    const acks = await db.orm
      .select({ policyId: policyAcks.policyId, ackedAt: policyAcks.ackedAt })
      .from(policyAcks)
      .where(
        and(
          eq(policyAcks.employeeId, employeeId),
          inArray(
            policyAcks.policyId,
            rows.map((r) => r.id),
          ),
        ),
      );
    const firstAck = new Map<string, Date>();
    for (const a of acks) {
      const prev = firstAck.get(a.policyId);
      if (!prev || a.ackedAt < prev) firstAck.set(a.policyId, a.ackedAt);
    }
    for (const r of rows) {
      const at = firstAck.get(r.id) ?? null;
      result.set(r.code, {
        policyId: r.id,
        acked: at !== null || r.retiredAt !== null,
        ackedAt: at,
      });
    }
    return result;
  },
});

export type OnboardingRepository = ReturnType<typeof createOnboardingRepository>;
