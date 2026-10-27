import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import {
  auditLog,
  employees,
  exitClearances,
  exits,
  fnfRecoveries,
} from '../../db/schema/index.js';
import { revokeEmployeeRefreshTokens } from '../auth/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';
import { endSeatsOfLeaver, type SeatKind } from '../seats/index.js';

export type ExitRow = typeof exits.$inferSelect;
export type ClearanceRow = typeof exitClearances.$inferSelect;
export type RecoveryRow = typeof fnfRecoveries.$inferSelect;

/** Who performed the mutation — null for the scheduler (system). */
export interface ActorContext {
  actorUserId: string | null;
  actorEmployeeId: string | null;
}

export interface Bell {
  to: string[];
  event: NotificationEvent;
}

/** The person an exit is about, with what the exit rules need. */
export interface ExitPerson {
  id: string;
  name: string;
  employee_code: string;
  status: string;
  designation: string | null;
  department: string | null;
  date_of_joining: string | null;
  notice_days: number | null;
  effective_rm: string | null;
  rm_name: string | null;
  is_owner: boolean;
  /** Basic % from the salary record (null = the 50% default). */
  basic_percent: string | null;
}

const audit = (
  tx: DbClient,
  actor: ActorContext,
  action: string,
  exitId: string,
  detail?: Record<string, unknown>,
) =>
  tx.orm.insert(auditLog).values({
    actorUserId: actor.actorUserId,
    action,
    subject: `exits:${exitId}`,
    detail: detail ? JSON.stringify(detail) : null,
  });

const ring = async (tx: DbClient, bells: Bell[] = []) => {
  for (const b of bells) await insertNotifications(tx, b.to, b.event);
};

/** The only place the exits feature touches the database. */
export const createExitsRepository = (db: DbClient) => ({
  /** The Admin (Owner) account — it assigns seats, so it hears about emptied ones. */
  ownerEmployeeId: async (): Promise<string | null> =>
    (
      await db.query<{ employee_id: string }>(`SELECT employee_id FROM access.org_owner`)
    )[0]?.employee_id ?? null,

  person: async (id: string): Promise<ExitPerson | undefined> =>
    (
      await db.query<ExitPerson>(
        `SELECT e.id, e.name, e.employee_code, e.status, e.designation,
                d.name AS department, e.date_of_joining::text, e.notice_days,
                coalesce(e.leave_approver, e.reports_to) AS effective_rm,
                rm.name AS rm_name,
                EXISTS (SELECT 1 FROM access.org_owner o WHERE o.employee_id = e.id) AS is_owner,
                (SELECT s.basic_percent FROM org.employee_salary s WHERE s.employee_id = e.id) AS basic_percent
           FROM org.employees e
           LEFT JOIN org.departments d ON d.id = e.department_id
           LEFT JOIN org.employees rm ON rm.id = coalesce(e.leave_approver, e.reports_to)
          WHERE e.id = $1`,
        [id],
      )
    )[0],

  names: async (ids: string[]): Promise<Map<string, string>> => {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return new Map();
    const rows = await db.orm
      .select({ id: employees.id, name: employees.name })
      .from(employees)
      .where(inArray(employees.id, unique));
    return new Map(rows.map((r) => [r.id, r.name]));
  },

  find: async (id: string): Promise<ExitRow | undefined> =>
    (await db.orm.select().from(exits).where(eq(exits.id, id)).limit(1))[0],

  /** The person's live exit (submitted / accepted / relieved), else their latest. */
  currentOf: async (employeeId: string): Promise<ExitRow | undefined> => {
    const r = (
      await db.query<{ id: string }>(
        `SELECT id FROM org.exits WHERE employee_id = $1
          ORDER BY (status IN ('submitted','accepted','relieved')) DESC, created_at DESC LIMIT 1`,
        [employeeId],
      )
    )[0];
    if (!r) return undefined;
    return (await db.orm.select().from(exits).where(eq(exits.id, r.id)).limit(1))[0];
  },

  /** Exits for lists: live ones always, closed ones from the last 180 days. */
  list: (): Promise<ExitRow[]> =>
    db
      .query<ExitRow>(
        `SELECT id FROM org.exits
        WHERE status IN ('submitted','accepted','relieved')
           OR created_at > now() - interval '180 days'
        ORDER BY created_at DESC`,
      )
      .then(async (rows) =>
        rows.length
          ? db.orm
              .select()
              .from(exits)
              .where(
                inArray(
                  exits.id,
                  rows.map((r) => r.id),
                ),
              )
          : [],
      ),

  /** Exits of people whose effective RM is `rmId` (the manager's queue). */
  forManager: async (rmId: string): Promise<ExitRow[]> => {
    const rows = await db.query<{ id: string }>(
      `SELECT x.id FROM org.exits x JOIN org.employees e ON e.id = x.employee_id
        WHERE coalesce(e.leave_approver, e.reports_to) = $1
          AND x.status IN ('submitted','accepted','relieved')`,
      [rmId],
    );
    if (rows.length === 0) return [];
    return db.orm
      .select()
      .from(exits)
      .where(
        inArray(
          exits.id,
          rows.map((r) => r.id),
        ),
      );
  },

  clearances: async (exitIds: string[]): Promise<ClearanceRow[]> =>
    exitIds.length
      ? db.orm
          .select()
          .from(exitClearances)
          .where(inArray(exitClearances.exitId, exitIds))
      : [],

  recoveries: (exitId: string): Promise<RecoveryRow[]> =>
    db.orm.select().from(fnfRecoveries).where(eq(fnfRecoveries.exitId, exitId)),

  /** Has the run for this month been finalized (or paid)? */
  runLocked: async (month: string): Promise<boolean> =>
    (
      await db.query<{ status: string }>(
        `SELECT status FROM org.payroll_runs WHERE month = $1`,
        [month],
      )
    ).some((r) => r.status !== 'draft'),

  /** Start an exit with its four clearance rows; optionally move the employee status. */
  insert: (
    values: typeof exits.$inferInsert,
    actor: ActorContext,
    action: string,
    bells: Bell[],
    employeeStatus?: 'exiting',
  ): Promise<string> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm.insert(exits).values(values).returning();
      const id = rows[0]!.id;
      await tx.orm
        .insert(exitClearances)
        .values(
          (['hr', 'manager', 'ops', 'payroll'] as const).map((kind) => ({
            exitId: id,
            kind,
          })),
        );
      if (employeeStatus) {
        await tx.orm
          .update(employees)
          .set({ status: employeeStatus, updatedAt: new Date() })
          .where(eq(employees.id, values.employeeId));
      }
      await audit(tx, actor, action, id, { kind: values.kind, status: values.status });
      await ring(tx, bells);
      return id;
    }),

  /**
   * Move an exit on from the status(es) it is still in; optionally set the
   * employee's status in the same transaction. False = it moved meanwhile.
   */
  transition: (
    exitId: string,
    from: ExitRow['status'][],
    patch: Partial<typeof exits.$inferInsert>,
    actor: ActorContext,
    action: string,
    bells: Bell[],
    employee?: { id: string; status: 'active' | 'exiting' },
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(exits)
        .set({ ...patch, updatedAt: new Date() })
        .where(and(eq(exits.id, exitId), inArray(exits.status, from)))
        .returning();
      if (!rows[0]) return false;
      if (employee) {
        await tx.orm
          .update(employees)
          .set({ status: employee.status, updatedAt: new Date() })
          .where(eq(employees.id, employee.id));
      }
      await audit(tx, actor, action, exitId, { status: rows[0].status });
      await ring(tx, bells);
      return true;
    }),

  clear: (
    exitId: string,
    kind: ClearanceRow['kind'],
    note: string | null,
    actor: ActorContext,
    bells: Bell[],
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(exitClearances)
        .set({ clearedBy: actor.actorEmployeeId, clearedAt: new Date(), note })
        .where(
          and(
            eq(exitClearances.exitId, exitId),
            eq(exitClearances.kind, kind),
            isNull(exitClearances.clearedAt),
          ),
        )
        .returning();
      if (!rows[0]) return false;
      await audit(tx, actor, `exit.cleared_${kind}`, exitId);
      await ring(tx, bells);
      return true;
    }),

  /** Exits whose last working day is today (the morning bells). */
  lastDayToday: (today: string) =>
    db.query<{ id: string; employee_id: string; name: string }>(
      `SELECT x.id, x.employee_id, e.name FROM org.exits x JOIN org.employees e ON e.id = x.employee_id
        WHERE x.status = 'accepted' AND x.last_working_day = $1::date`,
      [today],
    ),

  /** Accepted exits whose last working day has passed — to relieve. */
  dueToRelieve: (today: string) =>
    db.query<{ id: string; employee_id: string }>(
      `SELECT id, employee_id FROM org.exits
        WHERE status = 'accepted' AND last_working_day < $1::date`,
      [today],
    ),

  /**
   * Relieve one leaver after their last working day, all in one transaction:
   * login off (status inactive + every refresh token revoked), their pending
   * requests cancelled, and their team left without an RM — the team's
   * waiting RM approvals fall to HR; any seat they held ends. Returns who lost
   * their RM and which seats are now empty.
   */
  relieve: (
    exit: { id: string; employee_id: string },
    actor: ActorContext,
  ): Promise<{
    ok: boolean;
    orphans: Array<{ id: string; name: string }>;
    emptySeats: Array<{ seat: SeatKind; department_name: string | null }>;
  }> =>
    db.transaction(async (tx) => {
      const moved = await tx.query<{ id: string }>(
        `UPDATE org.exits SET status = 'relieved', relieved_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'accepted' RETURNING id`,
        [exit.id],
      );
      if (!moved[0]) return { ok: false, orphans: [], emptySeats: [] };
      const who = exit.employee_id;
      await tx.query(
        `UPDATE org.employees SET status = 'inactive', updated_at = now() WHERE id = $1`,
        [who],
      );
      await revokeEmployeeRefreshTokens(tx, who, 'deactivated');

      // Their own open requests go nowhere now.
      await tx.query(
        `UPDATE org.leave_requests SET status = 'cancelled', decided_at = now(),
                decision_reason = 'Cancelled at exit'
          WHERE employee_id = $1 AND status IN ('pending', 'partially_approved')`,
        [who],
      );
      await tx.query(
        `UPDATE org.wfh_requests SET status = 'cancelled'
          WHERE employee_id = $1 AND status IN ('pending', 'partially_approved')`,
        [who],
      );
      await tx.query(
        `UPDATE org.attendance_regularizations SET status = 'cancelled'
          WHERE employee_id = $1 AND status IN ('pending', 'partially_approved')`,
        [who],
      );
      await tx.query(
        `UPDATE access.grant_requests SET status = 'cancelled'
          WHERE employee_id = $1 AND status = 'pending'`,
        [who],
      );
      await tx.query(
        `UPDATE ops.asset_requests SET status = 'declined', handler_note = 'Closed at exit', updated_at = now()
          WHERE requested_by = $1 AND status IN ('open', 'in_progress')`,
        [who],
      );
      await tx.query(
        `UPDATE ops.gate_passes SET status = 'declined', decline_reason = 'Closed at exit'
          WHERE requested_by = $1 AND status = 'requested'`,
        [who],
      );

      // The team: nobody reports to someone who has left. RM-slot approvals
      // still waiting on the leaver fall to HR.
      const orphans = await tx.query<{ id: string; name: string }>(
        `SELECT id, name FROM org.employees
          WHERE (reports_to = $1 OR leave_approver = $1) AND status <> 'inactive'`,
        [who],
      );
      if (orphans.length) {
        const ids = orphans.map((o) => o.id);
        await tx.query(
          `UPDATE org.employees SET
              reports_to = CASE WHEN reports_to = $1 THEN NULL ELSE reports_to END,
              leave_approver = CASE WHEN leave_approver = $1 THEN NULL ELSE leave_approver END,
              expense_approver = CASE WHEN expense_approver = $1 THEN NULL ELSE expense_approver END,
              shift_request_approver = CASE WHEN shift_request_approver = $1 THEN NULL ELSE shift_request_approver END,
              updated_at = now()
            WHERE id = ANY($2::uuid[])`,
          [who, ids],
        );
        await tx.query(
          `UPDATE org.leave_requests SET rm_required = false, hr_required = true
            WHERE employee_id = ANY($1::uuid[]) AND status IN ('pending', 'partially_approved')
              AND rm_required AND rm_approved_at IS NULL`,
          [ids],
        );
        await tx.query(
          `UPDATE org.reimbursement_claims SET status = 'pending_payroll'
            WHERE employee_id = ANY($1::uuid[]) AND status = 'pending_rm'`,
          [ids],
        );
      }
      await audit(tx, actor, 'exit.relieved', exit.id, {
        orphanedReports: orphans.length,
      });
      // Seats they held (dept head, VP) end; HR assigns an acting holder.
      const emptySeats = await endSeatsOfLeaver(tx, who);
      return { ok: true, orphans, emptySeats };
    }),

  saveInterview: (
    exitId: string,
    answers: Record<string, unknown>,
    actor: ActorContext,
    bells: Bell[],
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(exits)
        .set({ interview: answers, interviewAt: new Date(), updatedAt: new Date() })
        .where(and(eq(exits.id, exitId), eq(exits.status, 'accepted')))
        .returning();
      if (!rows[0]) return false;
      await audit(tx, actor, 'exit.interview', exitId);
      await ring(tx, bells);
      return true;
    }),

  // ── F&F inputs ───────────────────────────────────────────────────────────

  ctcOf: async (employeeId: string): Promise<number | null> => {
    const r = (
      await db.query<{ ctc: string | null }>(
        `SELECT ctc::text FROM org.employee_salary WHERE employee_id = $1`,
        [employeeId],
      )
    )[0];
    return r?.ctc == null ? null : Number(r.ctc);
  },

  earnedBalanceRow: async (employeeId: string, year: number) =>
    (
      await db.query<{ opening: string; used: string }>(
        `SELECT opening::text, used::text FROM org.leave_balances
          WHERE employee_id = $1 AND type = 'earned' AND year = $2`,
        [employeeId, year],
      )
    )[0],

  /** Outstanding balance of the person's active loans / advances. */
  loanBalance: async (employeeId: string): Promise<number> =>
    Number(
      (
        await db.query<{ bal: string | null }>(
          `SELECT sum(l.principal - coalesce((SELECT sum(r.principal_part) FROM org.loan_repayments r
                                               WHERE r.loan_id = l.id), 0))::text AS bal
             FROM org.loans l WHERE l.employee_id = $1 AND l.status = 'active'`,
          [employeeId],
        )
      )[0]?.bal ?? 0,
    ),

  /** Approved sick leaves of 3+ days inside the notice with no certificate. */
  uncertifiedSickDays: async (employeeId: string, from: string, to: string) =>
    (
      await db.query<{ days: string | null }>(
        `SELECT sum(l.days)::text AS days FROM org.leave_requests l
           LEFT JOIN org.leave_certificates c ON c.leave_id = l.id
          WHERE l.employee_id = $1 AND l.type = 'sick' AND l.status = 'approved'
            AND l.days >= 3 AND l.start_date >= $2::date AND l.start_date <= $3::date
            AND c.id IS NULL`,
        [employeeId, from, to],
      )
    )[0]?.days,

  /**
   * Exits a payroll run for [monthStart, monthEnd] must handle: accepted or
   * relieved, last day on or before the month end. `settleable` = HR,
   * manager and OPS have cleared, so the F&F may ride this run.
   */
  touching: (monthEnd: string) =>
    db.query<{
      exit_id: string;
      employee_id: string;
      status: ExitRow['status'];
      last_working_day: string;
      settleable: boolean;
    }>(
      `SELECT x.id AS exit_id, x.employee_id, x.status, x.last_working_day::text,
              NOT EXISTS (
                SELECT 1 FROM org.exit_clearances c
                 WHERE c.exit_id = x.id AND c.kind IN ('hr','manager','ops') AND c.cleared_at IS NULL
              ) AS settleable
         FROM org.exits x
        WHERE x.status IN ('accepted', 'relieved') AND x.last_working_day <= $1::date`,
      [monthEnd],
    ),

  addRecovery: (
    values: typeof fnfRecoveries.$inferInsert,
    actor: ActorContext,
  ): Promise<RecoveryRow> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm.insert(fnfRecoveries).values(values).returning();
      // Amounts stay out of the audit log (§12).
      await audit(tx, actor, 'exit.recovery_added', values.exitId, {
        recoveryId: rows[0]!.id,
      });
      return rows[0]!;
    }),

  removeRecovery: (exitId: string, id: string, actor: ActorContext): Promise<boolean> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .delete(fnfRecoveries)
        .where(and(eq(fnfRecoveries.id, id), eq(fnfRecoveries.exitId, exitId)))
        .returning();
      if (!rows[0]) return false;
      await audit(tx, actor, 'exit.recovery_removed', exitId, { recoveryId: id });
      return true;
    }),
});

export type ExitsRepository = ReturnType<typeof createExitsRepository>;
