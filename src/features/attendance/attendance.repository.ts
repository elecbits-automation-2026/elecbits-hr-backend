import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import {
  attendance,
  attendanceRegularizations,
  auditLog,
  departments,
  employees,
  holidays,
  leaveRequests,
  orgOwner,
  punchZones,
  wfhRequests,
} from '../../db/schema/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';

/** Who performed the mutation — for the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

export type AttendanceRow = typeof attendance.$inferSelect;
export type HolidayRow = typeof holidays.$inferSelect;
export type RegularizationRow = typeof attendanceRegularizations.$inferSelect;
export type WfhRow = typeof wfhRequests.$inferSelect;

type Joined<T> = T & { employeeName: string; employeeCode: string };

/** The RM-chain filter: a named leave approver JOINS the chain alongside the
 *  reporting manager (user decision) — both see the queues. */
const effectiveRmIs = (rmId: string) =>
  or(eq(employees.leaveApprover, rmId), eq(employees.reportsTo, rmId));

/** The only place the attendance feature touches the database. */
export const createAttendanceRepository = (db: DbClient) => ({
  // --- punches --------------------------------------------------------------

  findPunch: async (
    employeeId: string,
    date: string,
  ): Promise<AttendanceRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(attendance)
      .where(and(eq(attendance.employeeId, employeeId), eq(attendance.date, date)))
      .limit(1);
    return rows[0];
  },

  insertPunch: async (values: typeof attendance.$inferInsert): Promise<AttendanceRow> => {
    const rows = await db.orm.insert(attendance).values(values).returning();
    return rows[0]!;
  },

  setPunchOut: async (
    id: string,
    checkOutAt: Date,
    checkOutIp: string | null,
    coords: { lat: number; lng: number } | null,
  ) => {
    const rows = await db.orm
      .update(attendance)
      .set({
        checkOutAt,
        checkOutIp,
        checkOutLat: coords ? String(coords.lat) : null,
        checkOutLng: coords ? String(coords.lng) : null,
      })
      .where(eq(attendance.id, id))
      .returning();
    return rows[0];
  },

  listPunches: async (employeeIds: string[], from: string, to: string) => {
    if (employeeIds.length === 0) return [];
    return db.orm
      .select()
      .from(attendance)
      .where(
        and(
          inArray(attendance.employeeId, employeeIds),
          gte(attendance.date, from),
          lte(attendance.date, to),
        ),
      );
  },

  // --- punch zones (Admin-managed) -----------------------------------------

  listZones: async () => {
    return db.orm.select().from(punchZones).orderBy(asc(punchZones.name));
  },

  insertZone: async (
    values: {
      name: string;
      lat: string;
      lng: string;
      radiusM: number;
      workStart: string | null;
      workEnd: string | null;
    },
    actor: ActorContext,
  ) => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm.insert(punchZones).values(values).returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'zone.added',
        subject: `punch_zones:${rows[0]!.id}`,
        detail: JSON.stringify(values),
      });
      return rows[0]!;
    });
  },

  findZone: async (id: string) => {
    const rows = await db.orm
      .select()
      .from(punchZones)
      .where(eq(punchZones.id, id))
      .limit(1);
    return rows[0];
  },

  deleteZone: async (
    row: { id: string; name: string },
    actor: ActorContext,
  ): Promise<void> => {
    await db.transaction(async (tx) => {
      await tx.orm.delete(punchZones).where(eq(punchZones.id, row.id));
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'zone.removed',
        subject: `punch_zones:${row.id}`,
        detail: JSON.stringify({ name: row.name }),
      });
    });
  },

  // --- calendar inputs ------------------------------------------------------

  listHolidays: async (from: string, to: string): Promise<HolidayRow[]> => {
    return db.orm
      .select()
      .from(holidays)
      .where(and(gte(holidays.date, from), lte(holidays.date, to)))
      .orderBy(asc(holidays.date));
  },

  insertHoliday: async (values: { date: string; name: string }, actor: ActorContext) => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm.insert(holidays).values(values).returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'holiday.added',
        subject: `holidays:${rows[0]!.id}`,
        detail: JSON.stringify(values),
      });
      return rows[0]!;
    });
  },

  findHoliday: async (id: string): Promise<HolidayRow | undefined> => {
    const rows = await db.orm.select().from(holidays).where(eq(holidays.id, id)).limit(1);
    return rows[0];
  },

  deleteHoliday: async (row: HolidayRow, actor: ActorContext): Promise<void> => {
    await db.transaction(async (tx) => {
      await tx.orm.delete(holidays).where(eq(holidays.id, row.id));
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'holiday.removed',
        subject: `holidays:${row.id}`,
        detail: JSON.stringify({ date: row.date, name: row.name }),
      });
    });
  },

  /** Each person's zone working hours (null = env defaults) — classifier input. */
  listSchedules: async (employeeIds: string[]) => {
    if (employeeIds.length === 0) return [];
    return db.orm
      .select({
        employeeId: employees.id,
        // A personal schedule (HR-set) wins over the base zone's hours.
        workStart: sql<
          string | null
        >`COALESCE(${employees.workStart}, ${punchZones.workStart})`,
        workEnd: sql<
          string | null
        >`COALESCE(${employees.workEnd}, ${punchZones.workEnd})`,
      })
      .from(employees)
      .leftJoin(punchZones, eq(employees.baseZoneId, punchZones.id))
      .where(inArray(employees.id, employeeIds));
  },

  /** Approved leaves overlapping [from, to] — classifier input. */
  listApprovedLeaves: async (employeeIds: string[], from: string, to: string) => {
    if (employeeIds.length === 0) return [];
    return db.orm
      .select({
        employeeId: leaveRequests.employeeId,
        type: leaveRequests.type,
        startDate: leaveRequests.startDate,
        endDate: leaveRequests.endDate,
        dayPart: leaveRequests.dayPart,
      })
      .from(leaveRequests)
      .where(
        and(
          inArray(leaveRequests.employeeId, employeeIds),
          eq(leaveRequests.status, 'approved'),
          lte(leaveRequests.startDate, to),
          gte(leaveRequests.endDate, from),
        ),
      );
  },

  /** Approved WFH ranges overlapping [from, to] — classifier input. */
  listApprovedWfh: async (employeeIds: string[], from: string, to: string) => {
    if (employeeIds.length === 0) return [];
    return db.orm
      .select({
        employeeId: wfhRequests.employeeId,
        startDate: wfhRequests.startDate,
        endDate: wfhRequests.endDate,
      })
      .from(wfhRequests)
      .where(
        and(
          inArray(wfhRequests.employeeId, employeeIds),
          eq(wfhRequests.status, 'approved'),
          lte(wfhRequests.startDate, to),
          gte(wfhRequests.endDate, from),
        ),
      );
  },

  // --- people ---------------------------------------------------------------

  /**
   * The Owner-linked account (admin@) is the ADMINISTRATION concept, not a
   * person (user decision): it manages the system but has no attendance,
   * leave or payroll existence of its own.
   */
  isSystemAccount: async (employeeId: string): Promise<boolean> => {
    const rows = await db.orm
      .select()
      .from(orgOwner)
      .where(eq(orgOwner.employeeId, employeeId))
      .limit(1);
    return rows.length > 0;
  },

  findEmployeeApprovers: async (employeeId: string) => {
    const rows = await db.orm
      .select({
        id: employees.id,
        name: employees.name,
        employeeCode: employees.employeeCode,
        reportsTo: employees.reportsTo,
        leaveApprover: employees.leaveApprover,
      })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);
    return rows[0];
  },

  /** The people whose effective RM is `rmId` (team views). */
  listReports: async (rmId: string) => {
    return db.orm
      .select({
        id: employees.id,
        name: employees.name,
        employeeCode: employees.employeeCode,
      })
      .from(employees)
      .where(and(effectiveRmIs(rmId), eq(employees.status, 'active')))
      .orderBy(asc(employees.name));
  },

  /** Export rows: active PEOPLE (system account excluded) with departments. */
  listActiveWithDepartment: async (
    departmentId: string | null,
    zoneId: string | null,
  ) => {
    return db.orm
      .select({
        id: employees.id,
        name: employees.name,
        employeeCode: employees.employeeCode,
        department: departments.name,
      })
      .from(employees)
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .leftJoin(orgOwner, eq(orgOwner.employeeId, employees.id))
      .where(
        and(
          eq(employees.status, 'active'),
          isNull(orgOwner.employeeId),
          departmentId ? eq(employees.departmentId, departmentId) : undefined,
          zoneId ? eq(employees.baseZoneId, zoneId) : undefined,
        ),
      )
      .orderBy(asc(employees.name));
  },

  /** Joining dates — a joiner's days before them are never absence. */
  joiningDates: async (employeeIds: string[]): Promise<Map<string, string | null>> => {
    if (employeeIds.length === 0) return new Map();
    const rows = await db.query<{ id: string; doj: string | null }>(
      `SELECT id, date_of_joining::text AS doj FROM org.employees WHERE id = ANY($1::uuid[])`,
      [employeeIds],
    );
    return new Map(rows.map((r) => [r.id, r.doj]));
  },

  /**
   * Everyone active for the org view — minus the administration account,
   * which has no attendance; optionally one base location.
   * TODO(skeleton): scope-filter like other lists.
   */
  listActiveEmployees: async (
    zoneId: string | null = null,
    departmentId: string | null = null,
  ) => {
    return db.orm
      .select({
        id: employees.id,
        name: employees.name,
        employeeCode: employees.employeeCode,
      })
      .from(employees)
      .leftJoin(orgOwner, eq(orgOwner.employeeId, employees.id))
      .where(
        and(
          eq(employees.status, 'active'),
          isNull(orgOwner.employeeId),
          zoneId ? eq(employees.baseZoneId, zoneId) : undefined,
          departmentId ? eq(employees.departmentId, departmentId) : undefined,
        ),
      )
      .orderBy(asc(employees.name));
  },

  // --- regularizations ------------------------------------------------------

  findRegularization: async (id: string): Promise<RegularizationRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(attendanceRegularizations)
      .where(eq(attendanceRegularizations.id, id))
      .limit(1);
    return rows[0];
  },

  findPendingRegularizationForDate: async (employeeId: string, date: string) => {
    const rows = await db.orm
      .select()
      .from(attendanceRegularizations)
      .where(
        and(
          eq(attendanceRegularizations.employeeId, employeeId),
          eq(attendanceRegularizations.date, date),
          eq(attendanceRegularizations.status, 'pending'),
        ),
      )
      .limit(1);
    return rows[0];
  },

  /**
   * A SELF-GOVERNED regularization (refinement plan, Phase 2): born approved
   * by its owner, the punch written in the same transaction as the row and
   * its audit — exactly what an RM approval would have done.
   */
  /** Bell rows for an attendance event (e.g. a short day). */
  notify: async (recipientIds: string[], event: NotificationEvent): Promise<void> => {
    await insertNotifications(db, recipientIds, event);
  },

  insertRegularizationSelfApproved: async (
    values: Omit<typeof attendanceRegularizations.$inferInsert, 'status'>,
    actor: ActorContext,
  ): Promise<RegularizationRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .insert(attendanceRegularizations)
        .values({
          ...values,
          status: 'approved',
          decidedBy: values.employeeId,
          decidedAt: new Date(),
        })
        .returning();
      const row = rows[0]!;
      await tx.orm
        .insert(attendance)
        .values({
          employeeId: row.employeeId,
          date: row.date,
          checkInAt: row.proposedIn,
          checkOutAt: row.proposedOut,
          source: 'regularized',
        })
        .onConflictDoUpdate({
          target: [attendance.employeeId, attendance.date],
          set: {
            checkInAt: row.proposedIn,
            checkOutAt: row.proposedOut,
            source: 'regularized',
          },
        });
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'attendance.regularized',
        subject: `attendance_regularizations:${row.id}`,
        detail: JSON.stringify({ date: row.date, selfApproved: true }),
      });
      return row;
    });
  },

  insertRegularization: async (values: typeof attendanceRegularizations.$inferInsert) => {
    const rows = await db.orm
      .insert(attendanceRegularizations)
      .values(values)
      .returning();
    return rows[0]!;
  },

  listRegularizationsByEmployee: async (employeeId: string) => {
    const rows = await db.orm
      .select({
        row: attendanceRegularizations,
        employeeName: employees.name,
        employeeCode: employees.employeeCode,
      })
      .from(attendanceRegularizations)
      .innerJoin(employees, eq(attendanceRegularizations.employeeId, employees.id))
      .where(eq(attendanceRegularizations.employeeId, employeeId))
      .orderBy(desc(attendanceRegularizations.createdAt));
    return rows.map((r): Joined<RegularizationRow> => ({
      ...r.row,
      employeeName: r.employeeName,
      employeeCode: r.employeeCode,
    }));
  },

  listRegularizationsForRm: async (rmId: string) => {
    const rows = await db.orm
      .select({
        row: attendanceRegularizations,
        employeeName: employees.name,
        employeeCode: employees.employeeCode,
      })
      .from(attendanceRegularizations)
      .innerJoin(employees, eq(attendanceRegularizations.employeeId, employees.id))
      .where(effectiveRmIs(rmId))
      .orderBy(desc(attendanceRegularizations.createdAt));
    return rows.map((r): Joined<RegularizationRow> => ({
      ...r.row,
      employeeName: r.employeeName,
      employeeCode: r.employeeCode,
    }));
  },

  /**
   * HR marks a day directly (user decision): the punch lands as
   * `regularized` with no approval loop. Any SINGLE-DAY approved leave on
   * that date is revoked with its balance refunded in the same transaction;
   * a multi-day leave covering the date aborts (HR must adjust the leave
   * first — a range cannot be split here).
   */
  hrMarkAttendance: async (
    input: { employeeId: string; date: string; checkInAt: Date; checkOutAt: Date },
    actor: ActorContext,
  ) => {
    return db.transaction(async (tx) => {
      const covering = await tx.orm
        .select()
        .from(leaveRequests)
        .where(
          and(
            eq(leaveRequests.employeeId, input.employeeId),
            eq(leaveRequests.status, 'approved'),
            lte(leaveRequests.startDate, input.date),
            gte(leaveRequests.endDate, input.date),
          ),
        );
      for (const leave of covering) {
        if (leave.startDate !== leave.endDate) {
          throw Object.assign(new Error('Date is inside a multi-day leave'), {
            code: 'MULTI_DAY_LEAVE',
          });
        }
        await tx.orm
          .update(leaveRequests)
          .set({
            status: 'cancelled',
            decidedBy: actor.actorEmployeeId,
            decisionReason: 'HR marked attendance for this day',
            decidedAt: new Date(),
          })
          .where(eq(leaveRequests.id, leave.id));
        if (['casual', 'sick', 'earned'].includes(leave.type)) {
          const refunded = await tx.query<{ id: string }>(
            `UPDATE org.leave_balances
                SET used = used - $1
              WHERE employee_id = $2 AND type = $3 AND year = $4 AND used >= $1
              RETURNING id`,
            [
              Number(leave.days),
              leave.employeeId,
              leave.type,
              Number(leave.startDate.slice(0, 4)),
            ],
          );
          if (refunded.length === 0) {
            throw Object.assign(new Error('Balance refund failed'), {
              code: 'REFUND_FAILED',
            });
          }
        }
        await tx.orm.insert(auditLog).values({
          actorUserId: actor.actorUserId,
          action: 'leave.revoked',
          subject: `leave_requests:${leave.id}`,
          detail: JSON.stringify({ type: leave.type, days: leave.days, by: 'hr_mark' }),
        });
      }

      const rows = await tx.orm
        .insert(attendance)
        .values({
          employeeId: input.employeeId,
          date: input.date,
          checkInAt: input.checkInAt,
          checkOutAt: input.checkOutAt,
          source: 'regularized',
        })
        .onConflictDoUpdate({
          target: [attendance.employeeId, attendance.date],
          set: {
            checkInAt: input.checkInAt,
            checkOutAt: input.checkOutAt,
            source: 'regularized',
          },
        })
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'attendance.hr_marked',
        subject: `attendance:${rows[0]!.id}`,
        detail: JSON.stringify({ employeeId: input.employeeId, date: input.date }),
      });
      return rows[0]!;
    });
  },

  /**
   * Decide a regularization; on approval the attendance row is written (or
   * overwritten — the proposed times are the correction) in the SAME
   * transaction as the status change and the audit row.
   */
  applyRegularizationDecision: async (
    row: RegularizationRow,
    patch: Partial<RegularizationRow>,
    writePunch: boolean,
    audit: { action: string; detail: Record<string, unknown> },
    actor: ActorContext,
  ): Promise<RegularizationRow> => {
    return db.transaction(async (tx) => {
      // Decisions only ever move a PENDING request; asserting that in the
      // WHERE makes a concurrent cancel/decide lose cleanly (zero rows →
      // conflict) instead of overwriting it — and the punch below can never
      // be written for a request that was already withdrawn.
      const rows = await tx.orm
        .update(attendanceRegularizations)
        .set(patch)
        .where(
          and(
            eq(attendanceRegularizations.id, row.id),
            eq(attendanceRegularizations.status, 'pending'),
          ),
        )
        .returning();
      if (!rows[0]) {
        throw Object.assign(new Error('Request changed concurrently'), {
          code: 'DECISION_CONFLICT',
        });
      }
      if (writePunch) {
        await tx.orm
          .insert(attendance)
          .values({
            employeeId: row.employeeId,
            date: row.date,
            checkInAt: row.proposedIn,
            checkOutAt: row.proposedOut,
            source: 'regularized',
          })
          .onConflictDoUpdate({
            target: [attendance.employeeId, attendance.date],
            set: {
              checkInAt: row.proposedIn,
              checkOutAt: row.proposedOut,
              source: 'regularized',
            },
          });
      }
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: audit.action,
        subject: `attendance_regularizations:${row.id}`,
        detail: JSON.stringify(audit.detail),
      });
      return rows[0]!;
    });
  },

  cancelRegularization: async (id: string, decidedBy: string) => {
    const rows = await db.orm
      .update(attendanceRegularizations)
      .set({ status: 'cancelled', decidedBy, decidedAt: new Date() })
      .where(
        and(
          eq(attendanceRegularizations.id, id),
          eq(attendanceRegularizations.status, 'pending'),
        ),
      )
      .returning();
    return rows[0];
  },

  // --- WFH ------------------------------------------------------------------

  findWfh: async (id: string): Promise<WfhRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(wfhRequests)
      .where(eq(wfhRequests.id, id))
      .limit(1);
    return rows[0];
  },

  /** A SELF-GOVERNED remote request: born approved, audited, no slot to fill. */
  insertWfhSelfApproved: async (
    values: Omit<typeof wfhRequests.$inferInsert, 'status'>,
    actor: ActorContext,
  ): Promise<WfhRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .insert(wfhRequests)
        .values({
          ...values,
          status: 'approved',
          decidedBy: values.employeeId,
          decidedAt: new Date(),
        })
        .returning();
      const row = rows[0]!;
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'remote.self_approved',
        subject: `wfh_requests:${row.id}`,
        detail: JSON.stringify({ startDate: row.startDate, endDate: row.endDate }),
      });
      return row;
    });
  },

  insertWfh: async (values: typeof wfhRequests.$inferInsert) => {
    const rows = await db.orm.insert(wfhRequests).values(values).returning();
    return rows[0]!;
  },

  listWfhByEmployee: async (employeeId: string) => {
    const rows = await db.orm
      .select({
        row: wfhRequests,
        employeeName: employees.name,
        employeeCode: employees.employeeCode,
      })
      .from(wfhRequests)
      .innerJoin(employees, eq(wfhRequests.employeeId, employees.id))
      .where(eq(wfhRequests.employeeId, employeeId))
      .orderBy(desc(wfhRequests.createdAt));
    return rows.map((r): Joined<WfhRow> => ({
      ...r.row,
      employeeName: r.employeeName,
      employeeCode: r.employeeCode,
    }));
  },

  /** Org-wide live remote requests — the HR half of the dual approval. */
  listWfhPendingAll: async () => {
    const rows = await db.orm
      .select({
        row: wfhRequests,
        employeeName: employees.name,
        employeeCode: employees.employeeCode,
      })
      .from(wfhRequests)
      .innerJoin(employees, eq(wfhRequests.employeeId, employees.id))
      .where(inArray(wfhRequests.status, ['pending', 'partially_approved']))
      .orderBy(desc(wfhRequests.createdAt));
    return rows.map((r): Joined<WfhRow> => ({
      ...r.row,
      employeeName: r.employeeName,
      employeeCode: r.employeeCode,
    }));
  },

  /** Partially-approved remote requests FULLY inside [from, to] — sweep (M7). */
  listPartiallyApprovedWfhWithin: async (from: string, to: string) => {
    return db.orm
      .select()
      .from(wfhRequests)
      .where(
        and(
          eq(wfhRequests.status, 'partially_approved'),
          gte(wfhRequests.startDate, from),
          lte(wfhRequests.endDate, to),
        ),
      );
  },

  /**
   * Partially-approved remote requests OVERLAPPING [from, to] — payroll's
   * finalize guard. Overlap, not fully-inside: a month-spanning request is
   * invisible to the sweep, so only this wider net stops finalize from
   * classifying its days absent.
   */
  listPartiallyApprovedWfhOverlapping: async (from: string, to: string) => {
    return db.orm
      .select()
      .from(wfhRequests)
      .where(
        and(
          eq(wfhRequests.status, 'partially_approved'),
          lte(wfhRequests.startDate, to),
          gte(wfhRequests.endDate, from),
        ),
      );
  },

  /** Display names for a set of employee ids — approver-name decoration. */
  namesByIds: async (ids: string[]): Promise<Map<string, string>> => {
    if (ids.length === 0) return new Map();
    const rows = await db.orm
      .select({ id: employees.id, name: employees.name })
      .from(employees)
      .where(inArray(employees.id, ids));
    return new Map(rows.map((r) => [r.id, r.name]));
  },

  listWfhForRm: async (rmId: string) => {
    const rows = await db.orm
      .select({
        row: wfhRequests,
        employeeName: employees.name,
        employeeCode: employees.employeeCode,
      })
      .from(wfhRequests)
      .innerJoin(employees, eq(wfhRequests.employeeId, employees.id))
      .where(effectiveRmIs(rmId))
      .orderBy(desc(wfhRequests.createdAt));
    return rows.map((r): Joined<WfhRow> => ({
      ...r.row,
      employeeName: r.employeeName,
      employeeCode: r.employeeCode,
    }));
  },

  applyWfhDecision: async (
    id: string,
    patch: Partial<WfhRow>,
    audit: { action: string; detail: Record<string, unknown> },
    actor: ActorContext,
    /** Snapshot the service decided on — re-asserted in the WHERE (see leaves). */
    expected: {
      status: WfhRow['status'];
      rmApprovedBy: string | null;
      hrApprovedBy: string | null;
    },
  ): Promise<WfhRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(wfhRequests)
        .set(patch)
        .where(
          and(
            eq(wfhRequests.id, id),
            eq(wfhRequests.status, expected.status),
            sql`${wfhRequests.rmApprovedBy} IS NOT DISTINCT FROM ${expected.rmApprovedBy}`,
            sql`${wfhRequests.hrApprovedBy} IS NOT DISTINCT FROM ${expected.hrApprovedBy}`,
          ),
        )
        .returning();
      if (!rows[0]) {
        throw Object.assign(new Error('Request changed concurrently'), {
          code: 'DECISION_CONFLICT',
        });
      }
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: audit.action,
        subject: `wfh_requests:${id}`,
        detail: JSON.stringify(audit.detail),
      });
      return rows[0]!;
    });
  },

  cancelWfh: async (id: string, decidedBy: string) => {
    const rows = await db.orm
      .update(wfhRequests)
      .set({ status: 'cancelled', decidedBy, decidedAt: new Date() })
      .where(
        and(
          eq(wfhRequests.id, id),
          inArray(wfhRequests.status, ['pending', 'partially_approved']),
        ),
      )
      .returning();
    return rows[0];
  },
});

export type AttendanceRepository = ReturnType<typeof createAttendanceRepository>;
export type { Joined };
