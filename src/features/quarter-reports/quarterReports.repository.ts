import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbClient } from '../../db/client.js';
import {
  auditLog,
  departments,
  employees,
  goals,
  orgOwner,
  quarterReports,
  reviewCycles,
} from '../../db/schema/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';

export type CycleRow = typeof reviewCycles.$inferSelect;
export type QuarterReportRow = typeof quarterReports.$inferSelect;
export type QuarterReportInsert = typeof quarterReports.$inferInsert;

/** Who performed the mutation — for the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

const rm = alias(employees, 'report_rm');
const adjuster = alias(employees, 'report_adjuster');
const closer = alias(employees, 'cycle_closer');

/** The only place the quarter-reports feature touches the database. */
export const createQuarterReportsRepository = (db: DbClient) => ({
  ensureCycle: async (
    name: string,
    startDate: string,
    endDate: string,
  ): Promise<CycleRow> => {
    await db.orm
      .insert(reviewCycles)
      .values({ name, startDate, endDate })
      .onConflictDoNothing();
    return (
      await db.orm.select().from(reviewCycles).where(eq(reviewCycles.name, name))
    )[0]!;
  },

  /** Every quarter on record, newest first, with its report count and closer. */
  listCycles: async () =>
    db.orm
      .select({
        cycle: reviewCycles,
        closedByName: closer.name,
        reportCount: sql<number>`(SELECT count(*)::int FROM org.quarter_reports q WHERE q.cycle_id = ${reviewCycles.id})`,
      })
      .from(reviewCycles)
      .leftJoin(closer, eq(reviewCycles.closedBy, closer.id))
      .orderBy(desc(reviewCycles.startDate)),

  /** Everyone a quarter report is written for: live, not the Owner, joined by the end. */
  listPeople: async (endDate: string) =>
    db.orm
      .select({
        id: employees.id,
        name: employees.name,
        dateOfJoining: employees.dateOfJoining,
        reportsTo: employees.reportsTo,
        leaveApprover: employees.leaveApprover,
        departmentName: departments.name,
      })
      .from(employees)
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .leftJoin(orgOwner, eq(orgOwner.employeeId, employees.id))
      .where(
        and(
          inArray(employees.status, ['active', 'exiting']),
          isNull(orgOwner.employeeId),
          sql`(${employees.dateOfJoining} IS NULL OR ${employees.dateOfJoining} <= ${endDate})`,
        ),
      ),

  goalsForCycle: async (cycleId: string) =>
    db.orm.select().from(goals).where(eq(goals.cycleId, cycleId)),

  /** Distinct days with an update that counts (on the day, or an approved late entry). */
  updateDays: async (from: string, to: string): Promise<Map<string, number>> => {
    const rows = await db.query<{ employee_id: string; days: number }>(
      `SELECT employee_id, count(DISTINCT date)::int AS days FROM org.work_updates
        WHERE date BETWEEN $1 AND $2 AND (late_status IS NULL OR late_status = 'approved')
        GROUP BY employee_id`,
      [from, to],
    );
    return new Map(rows.map((r) => [r.employee_id, r.days]));
  },

  /** Months in the quarter a person went over the work-update miss allowance. */
  missFlagMonths: async (months: string[]): Promise<Map<string, number>> => {
    const rows = await db.query<{ employee_id: string; n: number }>(
      `SELECT employee_id, count(*)::int AS n FROM org.work_update_miss_flags
        WHERE month = ANY($1) GROUP BY employee_id`,
      [months],
    );
    return new Map(rows.map((r) => [r.employee_id, r.n]));
  },

  recognitionsBetween: async (from: string, to: string): Promise<Map<string, number>> => {
    const rows = await db.query<{ employee_id: string; n: number }>(
      `SELECT employee_id, count(*)::int AS n FROM org.recognitions
        WHERE status = 'approved' AND decided_at::date BETWEEN $1 AND $2
        GROUP BY employee_id`,
      [from, to],
    );
    return new Map(rows.map((r) => [r.employee_id, r.n]));
  },

  feedbackBetween: async (
    from: string,
    to: string,
  ): Promise<Map<string, { appreciation: number; concern: number }>> => {
    const rows = await db.query<{ employee_id: string; type: string; n: number }>(
      `SELECT employee_id, type::text AS type, count(*)::int AS n FROM org.feedback_notes
        WHERE created_at::date BETWEEN $1 AND $2 GROUP BY employee_id, type`,
      [from, to],
    );
    const map = new Map<string, { appreciation: number; concern: number }>();
    for (const r of rows) {
      const e = map.get(r.employee_id) ?? { appreciation: 0, concern: 0 };
      if (r.type === 'appreciation') e.appreciation = r.n;
      else e.concern = r.n;
      map.set(r.employee_id, e);
    }
    return map;
  },

  /**
   * Close + write every report + audit + bells, one transaction. The WHERE
   * on closed_at makes a second close a no-op the service turns into 409.
   */
  closeWithReports: async (
    cycleId: string,
    rows: QuarterReportInsert[],
    actor: ActorContext,
    bells: Array<{ to: string[]; event: NotificationEvent }>,
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const closed = await tx.orm
        .update(reviewCycles)
        .set({ closedAt: new Date(), closedBy: actor.actorEmployeeId })
        .where(and(eq(reviewCycles.id, cycleId), isNull(reviewCycles.closedAt)))
        .returning();
      if (!closed[0]) return false;
      if (rows.length > 0) await tx.orm.insert(quarterReports).values(rows);
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'quarter.closed',
        subject: `review_cycles:${cycleId}`,
        detail: JSON.stringify({ cycle: closed[0].name, reports: rows.length }),
      });
      for (const b of bells) await insertNotifications(tx, b.to, b.event);
      return true;
    }),

  /** Reports with the names the views need. */
  listReports: async (filter: { cycleId?: string; employeeId?: string }) =>
    db.orm
      .select({
        report: quarterReports,
        cycleName: reviewCycles.name,
        employeeName: employees.name,
        employeeCode: employees.employeeCode,
        rmName: rm.name,
        adjustedByName: adjuster.name,
      })
      .from(quarterReports)
      .innerJoin(reviewCycles, eq(quarterReports.cycleId, reviewCycles.id))
      .innerJoin(employees, eq(quarterReports.employeeId, employees.id))
      .leftJoin(rm, eq(quarterReports.rmId, rm.id))
      .leftJoin(adjuster, eq(quarterReports.adjustedBy, adjuster.id))
      .where(
        and(
          filter.cycleId ? eq(quarterReports.cycleId, filter.cycleId) : undefined,
          filter.employeeId
            ? eq(quarterReports.employeeId, filter.employeeId)
            : undefined,
        ),
      )
      .orderBy(desc(reviewCycles.startDate), employees.name),

  findReport: async (id: string): Promise<QuarterReportRow | undefined> =>
    (
      await db.orm.select().from(quarterReports).where(eq(quarterReports.id, id)).limit(1)
    )[0],

  /** The manager's final call + audit + the person's bell. */
  adjust: async (
    id: string,
    patch: { finalScore: number; finalBand: string; adjustReason: string },
    actor: ActorContext,
    bell: { to: string[]; event: NotificationEvent },
  ): Promise<void> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(quarterReports)
        .set({ ...patch, adjustedBy: actor.actorEmployeeId, adjustedAt: new Date() })
        .where(eq(quarterReports.id, id))
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'quarter.score_adjusted',
        subject: `employees:${rows[0]!.employeeId}`,
        detail: JSON.stringify({ reportId: id, finalScore: patch.finalScore }),
      });
      await insertNotifications(tx, bell.to, bell.event);
    }),
});

export type QuarterReportsRepository = ReturnType<typeof createQuarterReportsRepository>;
