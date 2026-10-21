import { and, desc, eq, gte, inArray, lte, ne, or, sql } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import {
  auditLog,
  employees,
  holidays,
  leaveBalances,
  leaveCertificates,
  leaveRequests,
  orgOwner,
} from '../../db/schema/index.js';
import {
  EL_BALANCE_CAP,
  accruedAllocation,
  type CappedLeaveType,
} from '../../shared/constants/constants.js';

/** Who performed the mutation — for the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

export type LeaveRequestRow = typeof leaveRequests.$inferSelect;

/** A request row joined with the owner's display identity. */
export type LeaveRequestJoinedRow = LeaveRequestRow & {
  employeeName: string;
  employeeCode: string;
};

/** The three states a request can still move from / that block overlaps. */
const BLOCKING_STATUSES = ['pending', 'partially_approved', 'approved'] as const;

const joinedSelection = {
  req: leaveRequests,
  employeeName: employees.name,
  employeeCode: employees.employeeCode,
};

const flatten = (
  rows: Array<{ req: LeaveRequestRow; employeeName: string; employeeCode: string }>,
) =>
  rows.map((r) => ({
    ...r.req,
    employeeName: r.employeeName,
    employeeCode: r.employeeCode,
  }));

export interface BalanceOp {
  op: 'deduct' | 'refund';
  employeeId: string;
  type: CappedLeaveType;
  year: number;
  days: number;
}

/**
 * Move a leave balance inside the caller's transaction — the ARBITER:
 *  - 'deduct': the row is lazily created (prorated in the joining year), then
 *    incremented CONDITIONALLY — zero rows means the balance is exhausted and
 *    the thrown INSUFFICIENT_BALANCE rolls the whole transaction back;
 *  - 'refund': decremented conditionally (`used >= days`), never negative.
 */
const moveBalance = async (tx: DbClient, op: BalanceOp): Promise<void> => {
  if (op.op === 'deduct') {
    const joined = await tx.orm
      .select({ dateOfJoining: employees.dateOfJoining })
      .from(employees)
      .where(eq(employees.id, op.employeeId))
      .limit(1);
    await tx.orm
      .insert(leaveBalances)
      .values({
        employeeId: op.employeeId,
        type: op.type,
        year: op.year,
        // Accrued-to-date for the monthly types; the fixed quotas are
        // prorated in the joining year.
        allocated: String(
          accruedAllocation(op.type, op.year, {
            joinedOn: joined[0]?.dateOfJoining ?? null,
          }),
        ),
      })
      .onConflictDoNothing();
    // Effective balance includes carry-forward; earned is capped at 30
    // (policy auto-lapse) INSIDE the arbiter, so lapsed days can never
    // be spent even by two racing approvals.
    const capExpr =
      op.type === 'earned'
        ? `LEAST(opening + allocated, ${EL_BALANCE_CAP})`
        : '(opening + allocated)';
    const updated = await tx.query<{ id: string }>(
      `UPDATE org.leave_balances
          SET used = used + $1
        WHERE employee_id = $2 AND type = $3 AND year = $4
          AND used + $1 <= ${capExpr}
        RETURNING id`,
      [op.days, op.employeeId, op.type, op.year],
    );
    if (updated.length === 0) {
      // Service maps this to 409 INSUFFICIENT_BALANCE; transaction rolls back.
      throw Object.assign(new Error('Leave balance exhausted'), {
        code: 'INSUFFICIENT_BALANCE',
      });
    }
  } else if (op.op === 'refund') {
    const updated = await tx.query<{ id: string }>(
      `UPDATE org.leave_balances
          SET used = used - $1
        WHERE employee_id = $2 AND type = $3 AND year = $4
          AND used >= $1
        RETURNING id`,
      [op.days, op.employeeId, op.type, op.year],
    );
    if (updated.length === 0) {
      throw Object.assign(new Error('Balance refund failed'), {
        code: 'REFUND_FAILED',
      });
    }
  }
};

/** The only place the leaves feature touches the database. */
export const createLeavesRepository = (db: DbClient) => ({
  findById: async (id: string): Promise<LeaveRequestRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(leaveRequests)
      .where(eq(leaveRequests.id, id))
      .limit(1);
    return rows[0];
  },

  /** The Owner-linked administration account takes no leave (user decision). */
  isSystemAccount: async (employeeId: string): Promise<boolean> => {
    const rows = await db.orm
      .select()
      .from(orgOwner)
      .where(eq(orgOwner.employeeId, employeeId))
      .limit(1);
    return rows.length > 0;
  },

  /** The columns that decide who fills the RM slot (leave_approver ?? reports_to). */
  findEmployeeApprovers: async (employeeId: string) => {
    const rows = await db.orm
      .select({
        id: employees.id,
        name: employees.name,
        employeeCode: employees.employeeCode,
        reportsTo: employees.reportsTo,
        leaveApprover: employees.leaveApprover,
        // Joining-year proration of the fixed quotas.
        dateOfJoining: employees.dateOfJoining,
        // Policy gates: probation/notice (sick only) and menstrual eligibility.
        status: employees.status,
        confirmationDate: employees.confirmationDate,
        gender: employees.gender,
      })
      .from(employees)
      .where(eq(employees.id, employeeId))
      .limit(1);
    return rows[0];
  },

  listByEmployee: async (employeeId: string): Promise<LeaveRequestJoinedRow[]> => {
    const rows = await db.orm
      .select(joinedSelection)
      .from(leaveRequests)
      .innerJoin(employees, eq(leaveRequests.employeeId, employees.id))
      .where(eq(leaveRequests.employeeId, employeeId))
      .orderBy(desc(leaveRequests.createdAt));
    return flatten(rows);
  },

  /** Requests whose owner currently has `rmId` as their effective RM. */
  listForRm: async (rmId: string): Promise<LeaveRequestJoinedRow[]> => {
    const rows = await db.orm
      .select(joinedSelection)
      .from(leaveRequests)
      .innerJoin(employees, eq(leaveRequests.employeeId, employees.id))
      .where(
        and(
          // A named leave approver JOINS the chain, never replaces the RM (user
          // decision): both see the queue and either may fill the RM slot.
          or(eq(employees.leaveApprover, rmId), eq(employees.reportsTo, rmId)),
          // Menstrual leave is CONFIDENTIAL (policy §9.2): HR-only, so the RM
          // queue never carries the row; the absence still shows on the team
          // calendar as a generic leave day.
          ne(leaveRequests.type, 'menstrual'),
        ),
      )
      .orderBy(desc(leaveRequests.createdAt));
    return flatten(rows);
  },

  /** Display names for a set of employee ids — approver-name decoration. */
  /** An undecided end-of-probation review (still on probation until HR decides). */
  probationOpen: async (employeeId: string): Promise<boolean> =>
    (
      await db.query<{ id: string }>(
        `SELECT id FROM org.probation_reviews
          WHERE employee_id = $1 AND status IN ('pending', 'recommended')`,
        [employeeId],
      )
    ).length > 0,

  /**
   * Certificate state per leave: the file (if any) and whether one is
   * needed — a sick leave of 3+ days starting inside an exit's notice.
   */
  certificateInfo: async (ids: string[]) => {
    if (ids.length === 0) {
      return new Map<string, { needed: boolean; fileName: string | null; uploadedAt: Date | null }>();
    }
    const rows = await db.query<{
      id: string;
      needed: boolean;
      file_name: string | null;
      uploaded_at: Date | null;
    }>(
      `SELECT l.id, c.file_name, c.uploaded_at,
              (l.type = 'sick' AND l.days >= 3 AND EXISTS (
                 SELECT 1 FROM org.exits x
                  WHERE x.employee_id = l.employee_id
                    AND x.status IN ('submitted','accepted','relieved','settled')
                    AND l.start_date >= x.notice_start_on
                    AND l.start_date <= x.last_working_day)) AS needed
         FROM org.leave_requests l
         LEFT JOIN org.leave_certificates c ON c.leave_id = l.id
        WHERE l.id = ANY($1::uuid[])`,
      [ids],
    );
    return new Map(
      rows.map((r) => [
        r.id,
        { needed: r.needed, fileName: r.file_name, uploadedAt: r.uploaded_at },
      ]),
    );
  },

  /** Store (or replace) a leave's certificate, with its audit row. */
  upsertCertificate: async (
    file: { leaveId: string; fileName: string; contentType: string; data: Buffer },
    actor: ActorContext,
  ): Promise<void> =>
    db.transaction(async (tx) => {
      await tx.orm
        .insert(leaveCertificates)
        .values({
          leaveId: file.leaveId,
          fileName: file.fileName,
          contentType: file.contentType,
          sizeBytes: file.data.length,
          data: file.data,
          uploadedBy: actor.actorEmployeeId,
        })
        .onConflictDoUpdate({
          target: leaveCertificates.leaveId,
          set: {
            fileName: file.fileName,
            contentType: file.contentType,
            sizeBytes: file.data.length,
            data: file.data,
            uploadedBy: actor.actorEmployeeId,
            uploadedAt: new Date(),
          },
        });
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'leave.certificate_uploaded',
        subject: `leave_requests:${file.leaveId}`,
        detail: JSON.stringify({ bytes: file.data.length }),
      });
    }),

  getCertificate: async (leaveId: string) =>
    (
      await db.orm
        .select({
          fileName: leaveCertificates.fileName,
          contentType: leaveCertificates.contentType,
          data: leaveCertificates.data,
        })
        .from(leaveCertificates)
        .where(eq(leaveCertificates.leaveId, leaveId))
        .limit(1)
    )[0],

  namesByIds: async (ids: string[]): Promise<Map<string, string>> => {
    if (ids.length === 0) return new Map();
    const rows = await db.orm
      .select({ id: employees.id, name: employees.name })
      .from(employees)
      .where(inArray(employees.id, ids));
    return new Map(rows.map((r) => [r.id, r.name]));
  },

  /** HR queue. TODO(skeleton): filter by the caller's resolved scope (org-wide now). */
  listAll: async (
    status?: LeaveRequestRow['status'],
  ): Promise<LeaveRequestJoinedRow[]> => {
    const rows = await db.orm
      .select(joinedSelection)
      .from(leaveRequests)
      .innerJoin(employees, eq(leaveRequests.employeeId, employees.id))
      .where(status ? eq(leaveRequests.status, status) : undefined)
      .orderBy(desc(leaveRequests.createdAt));
    return flatten(rows);
  },

  /**
   * Org-wide partially-approved requests lying FULLY inside [from, to] — the
   * month-end sweep's eligibility. Fully-inside, not overlapping: a request
   * spilling into an already-finalized neighbour month would double-charge its
   * out-of-month days if auto-approved whole (review finding M7).
   */
  listPartiallyApprovedWithin: async (from: string, to: string) => {
    return db.orm
      .select()
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.status, 'partially_approved'),
          gte(leaveRequests.startDate, from),
          lte(leaveRequests.endDate, to),
        ),
      );
  },

  /**
   * Partially-approved requests OVERLAPPING [from, to] — payroll's finalize
   * guard. Overlap, not fully-inside: a month-spanning request is invisible
   * to the sweep, so only this wider net stops finalize from classifying its
   * days absent and double-charging them when the second approval lands.
   */
  listPartiallyApprovedOverlapping: async (from: string, to: string) => {
    return db.orm
      .select()
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.status, 'partially_approved'),
          lte(leaveRequests.startDate, to),
          gte(leaveRequests.endDate, from),
        ),
      );
  },

  /** Own live/approved requests intersecting [start, end] — the overlap rule. */
  listOverlapping: async (employeeId: string, startDate: string, endDate: string) => {
    return db.orm
      .select()
      .from(leaveRequests)
      .where(
        and(
          eq(leaveRequests.employeeId, employeeId),
          inArray(leaveRequests.status, [...BLOCKING_STATUSES]),
          lte(leaveRequests.startDate, endDate),
          gte(leaveRequests.endDate, startDate),
        ),
      );
  },

  /** Holiday dates in [from, to] — the no-sandwich day count skips them. */
  listHolidayDates: async (from: string, to: string): Promise<string[]> => {
    const rows = await db.orm
      .select({ date: holidays.date })
      .from(holidays)
      .where(and(gte(holidays.date, from), lte(holidays.date, to)));
    return rows.map((r) => r.date);
  },

  listBalances: async (employeeId: string, year: number) => {
    return db.orm
      .select()
      .from(leaveBalances)
      .where(and(eq(leaveBalances.employeeId, employeeId), eq(leaveBalances.year, year)));
  },

  /**
   * Lazy monthly accrual (policy §9.2/§9.3a): make the earned (and, when the
   * person is eligible, menstrual) rows exist with allocated = accrued-to-date.
   * Allocated only ever RISES (monotonic guard), so a concurrent call or an HR
   * edit is never undone. Earned's `opening` (carry-forward, capped at 30) is
   * computed ONCE when the year's row is born, from the previous year's
   * effective remaining.
   */
  ensureAccruals: async (
    employeeId: string,
    year: number,
    menstrualEligible: boolean,
  ): Promise<void> => {
    const types: CappedLeaveType[] = menstrualEligible
      ? ['earned', 'menstrual']
      : ['earned'];
    // Accrual runs from the joining month (refinement pass fix).
    const joinedOn =
      (
        await db.orm
          .select({ dateOfJoining: employees.dateOfJoining })
          .from(employees)
          .where(eq(employees.id, employeeId))
          .limit(1)
      )[0]?.dateOfJoining ?? null;
    for (const type of types) {
      const accrued = accruedAllocation(type, year, { joinedOn });
      const existing = await db.orm
        .select({ id: leaveBalances.id, allocated: leaveBalances.allocated })
        .from(leaveBalances)
        .where(
          and(
            eq(leaveBalances.employeeId, employeeId),
            eq(leaveBalances.type, type),
            eq(leaveBalances.year, year),
          ),
        )
        .limit(1);
      if (!existing[0]) {
        let opening = 0;
        if (type === 'earned') {
          const prev = (
            await db.orm
              .select()
              .from(leaveBalances)
              .where(
                and(
                  eq(leaveBalances.employeeId, employeeId),
                  eq(leaveBalances.type, 'earned'),
                  eq(leaveBalances.year, year - 1),
                ),
              )
              .limit(1)
          )[0];
          if (prev) {
            const effective = Math.min(
              Number(prev.opening) + Number(prev.allocated),
              EL_BALANCE_CAP,
            );
            opening = Math.min(
              Math.max(0, effective - Number(prev.used)),
              EL_BALANCE_CAP,
            );
          }
        }
        await db.orm
          .insert(leaveBalances)
          .values({
            employeeId,
            type,
            year,
            allocated: String(accrued),
            opening: String(opening),
          })
          .onConflictDoNothing();
      } else if (Number(existing[0].allocated) < accrued) {
        await db.query(
          `UPDATE org.leave_balances SET allocated = $1
            WHERE id = $2 AND allocated < $1`,
          [accrued, existing[0].id],
        );
      }
    }
  },

  /** Earned days already committed this year (live + approved) — the 18/yr use limit. */
  sumLiveEarnedDays: async (employeeId: string, year: number): Promise<number> => {
    const rows = await db.query<{ total: string | null }>(
      `SELECT SUM(days) AS total FROM org.leave_requests
        WHERE employee_id = $1 AND type = 'earned'
          AND status IN ('pending', 'partially_approved', 'approved')
          AND EXTRACT(YEAR FROM start_date) = $2`,
      [employeeId, year],
    );
    return Number(rows[0]?.total ?? 0);
  },

  /** Approved unpaid days in a year — display only, no cap to enforce. */
  sumApprovedUnpaid: async (employeeId: string, year: number): Promise<number> => {
    const rows = await db.query<{ total: string | null }>(
      `SELECT SUM(days) AS total FROM org.leave_requests
        WHERE employee_id = $1 AND type = 'unpaid' AND status = 'approved'
          AND EXTRACT(YEAR FROM start_date) = $2`,
      [employeeId, year],
    );
    return Number(rows[0]?.total ?? 0);
  },

  /** Raise + audit, one transaction (§10). Audit detail never carries the reason. */
  insertRequest: async (
    values: typeof leaveRequests.$inferInsert,
    actor: ActorContext,
  ): Promise<LeaveRequestRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm.insert(leaveRequests).values(values).returning();
      const row = rows[0]!;
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'leave.requested',
        subject: `leave_requests:${row.id}`,
        detail: JSON.stringify({
          type: row.type,
          startDate: row.startDate,
          endDate: row.endDate,
          days: row.days,
        }),
      });
      return row;
    });
  },

  /**
   * A SELF-GOVERNED request (refinement plan, Phase 2): born approved — no
   * slot to fill — with the balance charged by the same arbiter, the request
   * and its audit rows in ONE transaction (an exhausted balance writes nothing).
   */
  insertSelfApproved: async (
    values: Omit<
      typeof leaveRequests.$inferInsert,
      'rmRequired' | 'hrRequired' | 'status'
    >,
    balanceOp: BalanceOp | null,
    actor: ActorContext,
  ): Promise<LeaveRequestRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .insert(leaveRequests)
        .values({ ...values, status: 'approved', rmRequired: false, hrRequired: false })
        .returning();
      const row = rows[0]!;
      if (balanceOp) await moveBalance(tx, balanceOp);
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'leave.self_approved',
        subject: `leave_requests:${row.id}`,
        detail: JSON.stringify({
          type: row.type,
          startDate: row.startDate,
          endDate: row.endDate,
          days: row.days,
        }),
      });
      return row;
    });
  },

  /**
   * Apply a decision (slot fills, decline, cancel, or revoke) + audit in ONE
   * transaction. `balanceOp` moves the balance for capped types:
   *  - 'deduct' (final approval): the row is lazily created, then incremented
   *    CONDITIONALLY — zero rows updated means the balance is exhausted and
   *    the thrown error rolls the whole decision back (the arbiter for two
   *    competing pending requests);
   *  - 'refund' (revoking a future approved leave): decremented CONDITIONALLY
   *    (`used >= days`) so a quota edit can never drive `used` negative.
   */
  applyDecision: async (
    id: string,
    patch: Partial<LeaveRequestRow>,
    balanceOp: BalanceOp | null,
    audit: { action: string; detail: Record<string, unknown> },
    actor: ActorContext,
    /**
     * Optimistic-concurrency snapshot: the status + slot values the SERVICE
     * read when it made its decision. The UPDATE re-asserts them in its WHERE,
     * so a concurrent decision (approve vs decline, double-approve, cancel vs
     * finalize, sweep vs decline) matches zero rows instead of overwriting a
     * committed state — callers map DECISION_CONFLICT to a retryable 409.
     */
    expected: {
      status: LeaveRequestRow['status'];
      rmApprovedBy: string | null;
      hrApprovedBy: string | null;
    },
  ): Promise<LeaveRequestRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(leaveRequests)
        .set(patch)
        .where(
          and(
            eq(leaveRequests.id, id),
            eq(leaveRequests.status, expected.status),
            sql`${leaveRequests.rmApprovedBy} IS NOT DISTINCT FROM ${expected.rmApprovedBy}`,
            sql`${leaveRequests.hrApprovedBy} IS NOT DISTINCT FROM ${expected.hrApprovedBy}`,
          ),
        )
        .returning();
      const row = rows[0];
      if (!row) {
        // Someone else decided first; roll back and let the caller retry.
        throw Object.assign(new Error('Request changed concurrently'), {
          code: 'DECISION_CONFLICT',
        });
      }

      if (balanceOp) await moveBalance(tx, balanceOp);

      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: audit.action,
        subject: `leave_requests:${id}`,
        detail: JSON.stringify(audit.detail),
      });
      return row;
    });
  },
});

export type LeavesRepository = ReturnType<typeof createLeavesRepository>;
