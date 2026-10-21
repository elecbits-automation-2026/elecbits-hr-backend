import { and, asc, desc, eq, gte, inArray, lte, ne, or } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import {
  auditLog,
  employees,
  goals,
  holidays,
  leaveRequests,
  reviewCycles,
  workUpdateMissFlags,
  workUpdates,
} from '../../db/schema/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';

export type CycleRow = typeof reviewCycles.$inferSelect;
export type GoalRow = typeof goals.$inferSelect;
export type WorkUpdateRow = typeof workUpdates.$inferSelect;

/** Who performed the mutation — for the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

/** The only place the performance feature touches the database. */
export const createPerformanceRepository = (db: DbClient) => ({
  /** The quarter's cycle, materialized lazily; unique name is the arbiter. */
  ensureCycle: async (
    name: string,
    startDate: string,
    endDate: string,
  ): Promise<CycleRow> => {
    await db.orm
      .insert(reviewCycles)
      .values({ name, startDate, endDate })
      .onConflictDoNothing();
    const rows = await db.orm
      .select()
      .from(reviewCycles)
      .where(eq(reviewCycles.name, name));
    return rows[0]!;
  },

  findEmployee: async (employeeId: string) => {
    const rows = await db.orm
      .select({
        id: employees.id,
        name: employees.name,
        employeeCode: employees.employeeCode,
        status: employees.status,
        reportsTo: employees.reportsTo,
        leaveApprover: employees.leaveApprover,
      })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);
    return rows[0];
  },

  listGoals: async (employeeId: string, cycleId: string): Promise<GoalRow[]> => {
    return db.orm
      .select()
      .from(goals)
      .where(and(eq(goals.employeeId, employeeId), eq(goals.cycleId, cycleId)))
      .orderBy(desc(goals.weight), asc(goals.createdAt));
  },

  goalsForEmployees: async (
    employeeIds: string[],
    cycleId: string,
  ): Promise<GoalRow[]> => {
    if (employeeIds.length === 0) return [];
    return db.orm
      .select()
      .from(goals)
      .where(and(inArray(goals.employeeId, employeeIds), eq(goals.cycleId, cycleId)));
  },

  findGoal: async (id: string): Promise<GoalRow | undefined> => {
    const rows = await db.orm.select().from(goals).where(eq(goals.id, id)).limit(1);
    return rows[0];
  },

  insertGoal: async (
    values: typeof goals.$inferInsert,
    actor: ActorContext,
  ): Promise<GoalRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm.insert(goals).values(values).returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'goal.created',
        subject: `employees:${values.employeeId}`,
        detail: JSON.stringify({ title: values.title, weight: values.weight }),
      });
      return rows[0]!;
    });
  },

  /** Edit a goal's definition + audit (which fields changed), one transaction. */
  updateGoal: async (
    id: string,
    patch: Partial<typeof goals.$inferInsert>,
    actor: ActorContext,
  ): Promise<GoalRow | undefined> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(goals)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(goals.id, id))
        .returning();
      if (!rows[0]) return undefined;
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'goal.updated',
        subject: `goals:${id}`,
        detail: JSON.stringify({ fields: Object.keys(patch) }),
      });
      return rows[0];
    });
  },

  /** Remove a goal + audit (its title and owner kept in the audit detail). */
  deleteGoal: async (goal: GoalRow, actor: ActorContext): Promise<boolean> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm.delete(goals).where(eq(goals.id, goal.id)).returning();
      if (rows.length === 0) return false;
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'goal.deleted',
        subject: `employees:${goal.employeeId}`,
        detail: JSON.stringify({
          goalId: goal.id,
          title: goal.title,
          weight: goal.weight,
        }),
      });
      return true;
    });
  },

  /** Progress moves are frequent and owner-only — audited without the title. */
  updateProgress: async (
    id: string,
    progress: number,
    actor: ActorContext,
  ): Promise<GoalRow | undefined> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(goals)
        .set({ progress, updatedAt: new Date() })
        .where(eq(goals.id, id))
        .returning();
      if (!rows[0]) return undefined;
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'goal.progress',
        subject: `goals:${id}`,
        detail: JSON.stringify({ progress }),
      });
      return rows[0];
    });
  },

  /** The caller's direct chain (reports_to OR leave_approver), like /me/team. */
  listChain: async (rmId: string) => {
    return db.orm
      .select({
        id: employees.id,
        name: employees.name,
        employeeCode: employees.employeeCode,
      })
      .from(employees)
      .where(
        and(
          or(eq(employees.reportsTo, rmId), eq(employees.leaveApprover, rmId)),
          ne(employees.status, 'inactive'),
        ),
      )
      .orderBy(asc(employees.name));
  },

  /** Insert or same-day replace; the unique (employee, date) is the arbiter. */
  upsertUpdate: async (
    employeeId: string,
    date: string,
    note: string,
    scored: { score: number; feedback: string; kpiHits: string[] } | null,
    actor: ActorContext,
    goalIds: string[] | null = null,
  ): Promise<WorkUpdateRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .insert(workUpdates)
        .values({
          employeeId,
          date,
          note,
          score: scored?.score ?? null,
          feedback: scored?.feedback ?? null,
          kpiHits: scored?.kpiHits ?? null,
          goalIds,
        })
        .onConflictDoUpdate({
          target: [workUpdates.employeeId, workUpdates.date],
          set: {
            note,
            score: scored?.score ?? null,
            feedback: scored?.feedback ?? null,
            kpiHits: scored?.kpiHits ?? null,
            goalIds,
            updatedAt: new Date(),
          },
        })
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'work_update.submitted',
        // The note itself stays out of the audit log (§10 style).
        subject: `employees:${employeeId}`,
        detail: JSON.stringify({ date, scored: scored !== null }),
      });
      return rows[0]!;
    });
  },

  listUpdates: async (employeeId: string, fromDate: string): Promise<WorkUpdateRow[]> => {
    return db.orm
      .select()
      .from(workUpdates)
      .where(and(eq(workUpdates.employeeId, employeeId), gte(workUpdates.date, fromDate)))
      .orderBy(desc(workUpdates.date));
  },

  updatesForEmployees: async (
    employeeIds: string[],
    fromDate: string,
  ): Promise<WorkUpdateRow[]> => {
    if (employeeIds.length === 0) return [];
    return db.orm
      .select()
      .from(workUpdates)
      .where(
        and(
          inArray(workUpdates.employeeId, employeeIds),
          gte(workUpdates.date, fromDate),
        ),
      )
      .orderBy(desc(workUpdates.date));
  },

  /**
   * A LATE entry for a missed day — inserted, never replacing (an existing
   * entry for that day is a 409 for the service). Born 'pending', or
   * 'approved' for a self-governing person. Audited; the bell goes to the RM.
   */
  insertLateUpdate: async (
    values: {
      employeeId: string;
      date: string;
      note: string;
      goalIds: string[] | null;
      lateStatus: 'pending' | 'approved';
    },
    actor: ActorContext,
    notify: { recipientIds: string[]; event: NotificationEvent } | null,
  ): Promise<WorkUpdateRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .insert(workUpdates)
        .values({
          ...values,
          ...(values.lateStatus === 'approved'
            ? { lateDecidedBy: values.employeeId, lateDecidedAt: new Date() }
            : {}),
        })
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'work_update.late_entered',
        subject: `employees:${values.employeeId}`,
        detail: JSON.stringify({ date: values.date, lateStatus: values.lateStatus }),
      });
      if (notify) await insertNotifications(tx, notify.recipientIds, notify.event);
      return rows[0]!;
    });
  },

  findUpdate: async (id: string): Promise<WorkUpdateRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(workUpdates)
      .where(eq(workUpdates.id, id))
      .limit(1);
    return rows[0];
  },

  /** Approve/decline a pending late entry + audit + bell; null if already decided. */
  decideLate: async (
    id: string,
    status: 'approved' | 'declined',
    actor: ActorContext,
    notify: { recipientIds: string[]; event: NotificationEvent },
  ): Promise<WorkUpdateRow | undefined> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(workUpdates)
        .set({
          lateStatus: status,
          lateDecidedBy: actor.actorEmployeeId,
          lateDecidedAt: new Date(),
        })
        .where(and(eq(workUpdates.id, id), eq(workUpdates.lateStatus, 'pending')))
        .returning();
      if (!rows[0]) return undefined;
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: `work_update.late_${status}`,
        subject: `employees:${rows[0].employeeId}`,
        detail: JSON.stringify({ date: rows[0].date }),
      });
      await insertNotifications(tx, notify.recipientIds, notify.event);
      return rows[0];
    });
  },

  /** Pending late entries for a set of people (an RM's queue). */
  listPendingLate: async (employeeIds: string[]): Promise<WorkUpdateRow[]> => {
    if (employeeIds.length === 0) return [];
    return db.orm
      .select()
      .from(workUpdates)
      .where(
        and(
          inArray(workUpdates.employeeId, employeeIds),
          eq(workUpdates.lateStatus, 'pending'),
        ),
      )
      .orderBy(asc(workUpdates.date));
  },

  /** Who manages each person + their joining date — strip and approval inputs. */
  findLines: async (employeeIds: string[]) => {
    if (employeeIds.length === 0) return [];
    return db.orm
      .select({
        id: employees.id,
        name: employees.name,
        reportsTo: employees.reportsTo,
        leaveApprover: employees.leaveApprover,
        dateOfJoining: employees.dateOfJoining,
      })
      .from(employees)
      .where(inArray(employees.id, employeeIds));
  },

  holidayDates: async (from: string, to: string): Promise<Set<string>> => {
    const rows = await db.orm
      .select({ date: holidays.date })
      .from(holidays)
      .where(and(gte(holidays.date, from), lte(holidays.date, to)));
    return new Set(rows.map((r) => r.date));
  },

  /** Approved FULL-day leave overlapping [from, to] — those days are never a miss. */
  fullLeaveRanges: async (employeeIds: string[], from: string, to: string) => {
    if (employeeIds.length === 0) return [];
    return db.orm
      .select({
        employeeId: leaveRequests.employeeId,
        startDate: leaveRequests.startDate,
        endDate: leaveRequests.endDate,
      })
      .from(leaveRequests)
      .where(
        and(
          inArray(leaveRequests.employeeId, employeeIds),
          eq(leaveRequests.status, 'approved'),
          eq(leaveRequests.dayPart, 'full'),
          lte(leaveRequests.startDate, to),
          gte(leaveRequests.endDate, from),
        ),
      );
  },

  /**
   * Flag a month as over the miss allowance. Returns true only for the FIRST
   * flag of that month — the caller notifies the RM exactly once.
   */
  flagMonth: async (
    employeeId: string,
    month: string,
    misses: number,
  ): Promise<boolean> => {
    const rows = await db.orm
      .insert(workUpdateMissFlags)
      .values({ employeeId, month, misses })
      .onConflictDoNothing()
      .returning({ id: workUpdateMissFlags.id });
    return rows.length > 0;
  },

  notify: async (recipientIds: string[], event: NotificationEvent): Promise<void> => {
    await insertNotifications(db, recipientIds, event);
  },

  namesByIds: async (ids: string[]): Promise<Map<string, string>> => {
    if (ids.length === 0) return new Map();
    const rows = await db.orm
      .select({ id: employees.id, name: employees.name })
      .from(employees)
      .where(inArray(employees.id, ids));
    return new Map(rows.map((r) => [r.id, r.name]));
  },
});

export type PerformanceRepository = ReturnType<typeof createPerformanceRepository>;
