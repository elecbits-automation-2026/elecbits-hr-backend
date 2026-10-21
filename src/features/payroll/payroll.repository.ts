import { alias } from 'drizzle-orm/pg-core';
import { and, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import {
  loanRepayments,
  auditLog,
  departments,
  employeeSalary,
  employees,
  leaveBalances,
  orgOwner,
  payrollRuns,
  payslipCorrections,
  payslips,
  punchZones,
  reimbursementClaims,
} from '../../db/schema/index.js';
import { EL_BALANCE_CAP, accruedAllocation } from '../../shared/constants/constants.js';
import { insertNotifications } from '../notifications/index.js';

/** Who performed the mutation — for the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

export type PayrollRunRow = typeof payrollRuns.$inferSelect;
export type PayslipRow = typeof payslips.$inferSelect;
export type PayslipInsert = typeof payslips.$inferInsert;
export type PayslipCorrectionRow = typeof payslipCorrections.$inferSelect;

const appliedRuns = alias(payrollRuns, 'applied_runs');
const creators = alias(employees, 'correction_creators');

/**
 * Move one employee's DRAFT slips for months after `sourceMonth` by a
 * correction delta — the correction line and final pay together, so an open
 * draft always shows what it will carry. Inside the caller's transaction.
 */
const shiftDraftCorrections = async (
  tx: DbClient,
  employeeId: string,
  sourceMonth: string,
  delta: number,
): Promise<void> => {
  await tx.query(
    `UPDATE org.payslips p
        SET correction = correction + $1, final_pay = final_pay + $1, updated_at = now()
       FROM org.payroll_runs r
      WHERE p.run_id = r.id AND r.status = 'draft'
        AND p.employee_id = $2 AND r.month > $3`,
    [delta, employeeId, sourceMonth],
  );
};

export type PayslipJoinedRow = PayslipRow & {
  employeeName: string;
  employeeCode: string;
};

const joinedSelection = {
  slip: payslips,
  employeeName: employees.name,
  employeeCode: employees.employeeCode,
};

const flatten = (
  rows: Array<{ slip: PayslipRow; employeeName: string; employeeCode: string }>,
): PayslipJoinedRow[] =>
  rows.map((r) => ({
    ...r.slip,
    employeeName: r.employeeName,
    employeeCode: r.employeeCode,
  }));

/** The only place the payroll feature touches the database. */
export const createPayrollRepository = (db: DbClient) => ({
  findRunById: async (id: string): Promise<PayrollRunRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.id, id))
      .limit(1);
    return rows[0];
  },

  findRunByMonth: async (month: string): Promise<PayrollRunRow | undefined> => {
    const rows = await db.orm
      .select()
      .from(payrollRuns)
      .where(eq(payrollRuns.month, month))
      .limit(1);
    return rows[0];
  },

  /** Runs with their payslip count + net total, newest month first. */
  listRuns: async () => {
    return db.query<{
      id: string;
      month: string;
      status: PayrollRunRow['status'];
      payslip_count: string;
      net_total: string | null;
      created_at: Date;
      finalized_at: Date | null;
      paid_at: Date | null;
    }>(
      `SELECT r.id, r.month, r.status, r.created_at, r.finalized_at, r.paid_at,
              COUNT(p.id) AS payslip_count, COALESCE(SUM(p.net_pay), 0) AS net_total
         FROM org.payroll_runs r
         LEFT JOIN org.payslips p ON p.run_id = r.id
        GROUP BY r.id
        ORDER BY r.month DESC`,
    );
  },

  listPayslipsForRun: async (runId: string): Promise<PayslipJoinedRow[]> => {
    const rows = await db.orm
      .select(joinedSelection)
      .from(payslips)
      .innerJoin(employees, eq(payslips.employeeId, employees.id))
      .where(eq(payslips.runId, runId))
      .orderBy(employees.name);
    return flatten(rows);
  },

  /** Current employee statuses (in notice = 'exiting'). */
  statusesOf: async (ids: string[]): Promise<Map<string, string>> => {
    if (ids.length === 0) return new Map();
    const rows = await db.orm
      .select({ id: employees.id, status: employees.status })
      .from(employees)
      .where(inArray(employees.id, ids));
    return new Map(rows.map((r) => [r.id, r.status]));
  },

  /** The DRAFT slip carrying an exit's F&F, if a draft run has one. */
  draftSlipForExit: async (exitId: string) =>
    (
      await db.query<{ id: string; run_id: string; month: string }>(
        `SELECT p.id, p.run_id, r.month FROM org.payslips p
           JOIN org.payroll_runs r ON r.id = p.run_id
          WHERE p.exit_id = $1 AND r.status = 'draft'`,
        [exitId],
      )
    )[0],

  /** The published slip that settled an exit (the F&F statement). */
  settledSlipForExit: async (exitId: string) =>
    (
      await db.query<{ id: string; run_id: string; month: string; status: PayrollRunRow['status'] }>(
        `SELECT p.id, p.run_id, r.month, r.status FROM org.payslips p
           JOIN org.payroll_runs r ON r.id = p.run_id
          WHERE p.exit_id = $1 AND r.status <> 'draft'`,
        [exitId],
      )
    )[0],

  findPayslip: async (id: string): Promise<PayslipRow | undefined> => {
    const rows = await db.orm.select().from(payslips).where(eq(payslips.id, id)).limit(1);
    return rows[0];
  },

  /** Own payslips from published (non-draft) runs, newest month first. */
  listMyPayslips: async (employeeId: string) => {
    const rows = await db.orm
      .select({ slip: payslips, month: payrollRuns.month, runStatus: payrollRuns.status })
      .from(payslips)
      .innerJoin(payrollRuns, eq(payslips.runId, payrollRuns.id))
      .where(and(eq(payslips.employeeId, employeeId), ne(payrollRuns.status, 'draft')))
      .orderBy(desc(payrollRuns.month));
    return rows;
  },

  /**
   * Generation input: every ACTIVE employee left-joined to their salary row.
   * The Owner-linked administration account is excluded — it is a system
   * concept, not a person on payroll (user decision).
   */
  listActiveWithSalary: async (ids?: string[]) => {
    return db.orm
      .select({
        id: employees.id,
        name: employees.name,
        employeeCode: employees.employeeCode,
        status: employees.status,
        dateOfJoining: employees.dateOfJoining,
        // PT location rule (ERP sheet): snapshotted onto the slip at build.
        baseZoneName: punchZones.name,
        ctc: employeeSalary.ctc,
        currency: employeeSalary.salaryCurrency,
        basicPercent: employeeSalary.basicPercent,
        hraPercent: employeeSalary.hraPercent,
        pfAmount: employeeSalary.pfAmount,
        tdsAmount: employeeSalary.tdsAmount,
        professionalTaxAmount: employeeSalary.professionalTaxAmount,
        otherDeductionAmount: employeeSalary.otherDeductionAmount,
      })
      .from(employees)
      .leftJoin(employeeSalary, eq(employeeSalary.employeeId, employees.id))
      .leftJoin(punchZones, eq(employees.baseZoneId, punchZones.id))
      .leftJoin(orgOwner, eq(orgOwner.employeeId, employees.id))
      .where(
        and(
          // In notice (exiting) is still on payroll (exit module); leavers
          // come in by id for their last month / F&F.
          ids
            ? inArray(employees.id, ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])
            : inArray(employees.status, ['active', 'exiting']),
          isNull(orgOwner.employeeId),
        ),
      )
      .orderBy(employees.name);
  },

  /** TDS calculator inputs: live people with a CTC on record. */
  listTdsInputs: async () => {
    return db.orm
      .select({
        id: employees.id,
        name: employees.name,
        employeeCode: employees.employeeCode,
        dateOfJoining: employees.dateOfJoining,
        ctc: employeeSalary.ctc,
        tdsAmount: employeeSalary.tdsAmount,
        cnpsPercent: employeeSalary.cnpsPercent,
        basicPercent: employeeSalary.basicPercent,
        variablePay: employeeSalary.variablePay,
      })
      .from(employees)
      .innerJoin(employeeSalary, eq(employeeSalary.employeeId, employees.id))
      .leftJoin(orgOwner, eq(orgOwner.employeeId, employees.id))
      .where(
        and(inArray(employees.status, ['active', 'exiting']), isNull(orgOwner.employeeId)),
      )
      .orderBy(employees.name);
  },

  /** TDS already in PUBLISHED slips per employee for runs inside [from, to]. */
  sumTdsDeducted: async (
    fromMonth: string,
    toMonth: string,
  ): Promise<Map<string, number>> => {
    const rows = await db.query<{ employee_id: string; total: string | null }>(
      `SELECT p.employee_id, SUM(p.tds) AS total
         FROM org.payslips p
         JOIN org.payroll_runs r ON r.id = p.run_id
        WHERE r.status <> 'draft' AND r.month >= $1 AND r.month <= $2
        GROUP BY p.employee_id`,
      [fromMonth, toMonth],
    );
    return new Map(rows.map((r) => [r.employee_id, Number(r.total ?? 0)]));
  },

  /** Write the calculator's outcome onto the salary row + audit (§10). */
  updateSalaryTds: async (
    employeeId: string,
    patch: { tdsAmount?: string; cnpsPercent?: string },
    actor: ActorContext,
  ): Promise<boolean> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(employeeSalary)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(employeeSalary.employeeId, employeeId))
        .returning({ employeeId: employeeSalary.employeeId });
      if (!rows[0]) return false;
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'payroll.tds_updated',
        subject: `employees:${employeeId}`,
        detail: JSON.stringify(patch),
      });
      return true;
    });
  },

  /** Create the run + its draft payslips + audit, one transaction (§10). */
  insertRunWithPayslips: async (
    month: string,
    slips: Omit<PayslipInsert, 'runId'>[],
    actor: ActorContext,
  ): Promise<PayrollRunRow> => {
    return db.transaction(async (tx) => {
      const runs = await tx.orm
        .insert(payrollRuns)
        .values({ month, generatedBy: actor.actorEmployeeId })
        .returning();
      const run = runs[0]!;
      if (slips.length > 0) {
        await tx.orm.insert(payslips).values(slips.map((s) => ({ ...s, runId: run.id })));
      }
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'payroll.run_generated',
        subject: `payroll_runs:${run.id}`,
        // Never amounts — compensation must not leak into the audit log (§12).
        detail: JSON.stringify({ month, payslips: slips.length }),
      });
      return run;
    });
  },

  /** Draft regeneration: replace every payslip + audit, one transaction. */
  replacePayslips: async (
    runId: string,
    month: string,
    slips: Omit<PayslipInsert, 'runId'>[],
    actor: ActorContext,
  ): Promise<void> => {
    await db.transaction(async (tx) => {
      // Lock + re-assert draft status (M5): never rebuild a finalized run.
      const guard = await tx.query<{ id: string }>(
        `SELECT id FROM org.payroll_runs WHERE id = $1 AND status = 'draft' FOR UPDATE`,
        [runId],
      );
      if (guard.length === 0) {
        throw Object.assign(new Error('Run status changed concurrently'), {
          code: 'RUN_CONFLICT',
        });
      }
      await tx.orm.delete(payslips).where(eq(payslips.runId, runId));
      if (slips.length > 0) {
        await tx.orm.insert(payslips).values(slips.map((s) => ({ ...s, runId })));
      }
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'payroll.run_regenerated',
        subject: `payroll_runs:${runId}`,
        detail: JSON.stringify({ month, payslips: slips.length }),
      });
    });
  },

  updatePayslip: async (
    id: string,
    patch: Partial<PayslipRow>,
    changedFields: string[],
    actor: ActorContext,
  ): Promise<PayslipRow> => {
    return db.transaction(async (tx) => {
      // Lock + re-assert the owning run is a draft (M5): a finalize racing
      // this PATCH can never let an edit land on published payslips.
      const guard = await tx.query<{ id: string }>(
        `SELECT r.id FROM org.payroll_runs r
           JOIN org.payslips p ON p.run_id = r.id
          WHERE p.id = $1 AND r.status = 'draft'
          FOR UPDATE OF r`,
        [id],
      );
      if (guard.length === 0) {
        throw Object.assign(new Error('Run status changed concurrently'), {
          code: 'RUN_CONFLICT',
        });
      }
      const rows = await tx.orm
        .update(payslips)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(payslips.id, id))
        .returning();
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'payroll.payslip_updated',
        subject: `payslips:${id}`,
        detail: JSON.stringify({ fields: changedFields }),
      });
      return rows[0]!;
    });
  },

  /**
   * R&R pay-out (refinement plan, Phase 2): per employee, the total of awards
   * APPROVED during `month` ('2026-10') in the company timezone — the server
   * runs in it, so local month boundaries are the right instants.
   */
  recognitionAwardsApprovedIn: async (month: string): Promise<Map<string, number>> => {
    const [y, m] = month.split('-').map(Number);
    const from = new Date(y!, m! - 1, 1);
    const to = new Date(y!, m!, 1);
    const rows = await db.query<{ employee_id: string; total: string }>(
      `SELECT employee_id, SUM(value_inr)::text AS total
         FROM org.recognitions
        WHERE status = 'approved' AND decided_at >= $1 AND decided_at < $2
        GROUP BY employee_id`,
      [from.toISOString(), to.toISOString()],
    );
    return new Map(rows.map((r) => [r.employee_id, Number(r.total)]));
  },

  /** Joining dates for a cohort — the fixed leave quotas prorate by them. */
  joiningDates: async (employeeIds: string[]): Promise<Map<string, string | null>> => {
    if (employeeIds.length === 0) return new Map();
    const rows = await db.orm
      .select({ id: employees.id, dateOfJoining: employees.dateOfJoining })
      .from(employees)
      .where(inArray(employees.id, employeeIds));
    return new Map(rows.map((r) => [r.id, r.dateOfJoining]));
  },

  /** Balance rows for a cohort + year — the auto-leave split reads these. */
  listBalancesFor: async (employeeIds: string[], year: number) => {
    if (employeeIds.length === 0) return [];
    return db.orm
      .select()
      .from(leaveBalances)
      .where(
        and(inArray(leaveBalances.employeeId, employeeIds), eq(leaveBalances.year, year)),
      );
  },

  /**
   * FINALIZE in one transaction (user decision, month-end auto-leave):
   * per payslip, the uncovered-absence split is charged to balances
   * in the configured order (earned/sick) with the same lazy-insert + conditional-UPDATE guard the
   * leaves feature uses (zero rows -> throw -> whole finalize rolls back),
   * the slip's auto/LOP/totals are rewritten, then the run locks.
   */
  finalizeRun: async (
    run: PayrollRunRow,
    updates: Array<{
      id: string;
      employeeId: string;
      year: number;
      autoEl: number;
      autoSl: number;
      lopDays: string;
      lopAmount: string;
      /** Recomputed structure/PF/PT fields; null keeps the stored ones. */
      money: Record<string, string | number> | null;
      earningsTotal: string;
      deductionsTotal: string;
      netPay: string;
      finalPay: string;
    }>,
    actor: ActorContext,
    /** Exits whose F&F this run carries: payroll cleared + settled, same transaction. */
    settleExits: string[] = [],
    /** Loan instalments (or F&F balances) this run deducts. */
    loanPayments: Array<{
      loanId: string;
      kind: 'emi' | 'fnf';
      amount: number;
      principal: number;
      interest: number;
      closes: boolean;
    }> = [],
  ): Promise<PayrollRunRow> => {
    return db.transaction(async (tx) => {
      // Lock + re-assert the run is STILL a draft inside the transaction (M5):
      // a concurrent finalize/regenerate/delete makes this match zero rows and
      // the whole finalize rolls back instead of double-charging balances.
      const locked = await tx.orm
        .update(payrollRuns)
        .set({
          status: 'finalized',
          finalizedBy: actor.actorEmployeeId,
          finalizedAt: new Date(),
        })
        .where(and(eq(payrollRuns.id, run.id), eq(payrollRuns.status, 'draft')))
        .returning();
      if (!locked[0]) {
        throw Object.assign(new Error('Run status changed concurrently'), {
          code: 'RUN_CONFLICT',
        });
      }

      let totalAutoDays = 0;
      for (const u of updates) {
        // Auto-cover draws from the balances the payroll.autoCoverLeaveTypes
        // setting names (earned and/or sick); casual is retired, CL stays zero.
        const charges = [
          ['earned', u.autoEl],
          ['sick', u.autoSl],
        ] as const;
        for (const [type, days] of charges) {
          if (days <= 0) continue;
          totalAutoDays += days;
          const joined = await tx.orm
            .select({ dateOfJoining: employees.dateOfJoining })
            .from(employees)
            .where(eq(employees.id, u.employeeId))
            .limit(1);
          await tx.orm
            .insert(leaveBalances)
            .values({
              employeeId: u.employeeId,
              type,
              year: u.year,
              allocated: String(
                accruedAllocation(type, u.year, {
                  joinedOn: joined[0]?.dateOfJoining ?? null,
                }),
              ),
            })
            .onConflictDoNothing();
          // Same effective-balance arbiter as leave approval: carry-forward
          // counts, earned's 30-day cap lapses the excess (policy §9.3a).
          const capExpr =
            type === 'earned'
              ? `LEAST(opening + allocated, ${EL_BALANCE_CAP})`
              : '(opening + allocated)';
          const updated = await tx.query<{ id: string }>(
            `UPDATE org.leave_balances
                SET used = used + $1
              WHERE employee_id = $2 AND type = $3 AND year = $4
                AND used + $1 <= ${capExpr}
              RETURNING id`,
            [days, u.employeeId, type, u.year],
          );
          if (updated.length === 0) {
            // Balance moved between the split computation and now — the
            // service maps this to a retryable 409.
            throw Object.assign(new Error('Auto-leave balance conflict'), {
              code: 'AUTO_LEAVE_CONFLICT',
            });
          }
        }
        await tx.orm
          .update(payslips)
          .set({
            autoElDays: String(u.autoEl),
            autoSlDays: String(u.autoSl),
            autoClDays: '0',
            lopDays: u.lopDays,
            lopAmount: u.lopAmount,
            ...(u.money ?? {}),
            earningsTotal: u.earningsTotal,
            deductionsTotal: u.deductionsTotal,
            netPay: u.netPay,
            finalPay: u.finalPay,
            updatedAt: new Date(),
          })
          .where(eq(payslips.id, u.id));
      }

      // Corrections: the pending ones from earlier months for the people in
      // this run must add up to each slip's correction line (a correction
      // added or cancelled after another run carried it would not), then they
      // are marked applied to this run.
      const carried = await tx.query<{ id: string; employee_id: string; amount: string }>(
        `SELECT c.id, c.employee_id, c.amount
           FROM org.payslip_corrections c
           JOIN org.payslips p ON p.employee_id = c.employee_id AND p.run_id = $1
          WHERE c.status = 'pending' AND c.source_month < $2
          FOR UPDATE OF c`,
        [run.id, run.month],
      );
      const due = new Map<string, number>();
      for (const c of carried) {
        due.set(c.employee_id, (due.get(c.employee_id) ?? 0) + Number(c.amount));
      }
      const onSlips = await tx.query<{ employee_id: string; correction: string }>(
        `SELECT employee_id, correction FROM org.payslips WHERE run_id = $1`,
        [run.id],
      );
      for (const slip of onSlips) {
        const expected = Math.round((due.get(slip.employee_id) ?? 0) * 100);
        if (expected !== Math.round(Number(slip.correction) * 100)) {
          throw Object.assign(new Error('Corrections changed'), {
            code: 'CORRECTIONS_CHANGED',
          });
        }
      }
      // Reimbursements: the same check for approved claims spent by this
      // month, then they are marked paid by this run.
      const claims = await tx.query<{ id: string; employee_id: string; amount: string }>(
        `SELECT c.id, c.employee_id, c.amount
           FROM org.reimbursement_claims c
           JOIN org.payslips p ON p.employee_id = c.employee_id AND p.run_id = $1
          WHERE c.status = 'approved' AND to_char(c.spent_on, 'YYYY-MM') <= $2
          FOR UPDATE OF c`,
        [run.id, run.month],
      );
      const owed = new Map<string, number>();
      for (const c of claims) {
        owed.set(c.employee_id, (owed.get(c.employee_id) ?? 0) + Number(c.amount));
      }
      const reimbursed = await tx.query<{ employee_id: string; reimbursement: string }>(
        `SELECT employee_id, reimbursement FROM org.payslips WHERE run_id = $1`,
        [run.id],
      );
      for (const slip of reimbursed) {
        if (
          Math.round((owed.get(slip.employee_id) ?? 0) * 100) !==
          Math.round(Number(slip.reimbursement) * 100)
        ) {
          throw Object.assign(new Error('Reimbursements changed'), {
            code: 'REIMBURSEMENTS_CHANGED',
          });
        }
      }
      if (claims.length > 0) {
        await tx.orm
          .update(reimbursementClaims)
          .set({ status: 'paid', paidRunId: run.id, updatedAt: new Date() })
          .where(
            inArray(
              reimbursementClaims.id,
              claims.map((c) => c.id),
            ),
          );
      }

      if (carried.length > 0) {
        await tx.orm
          .update(payslipCorrections)
          .set({ status: 'applied', appliedRunId: run.id })
          .where(
            inArray(
              payslipCorrections.id,
              carried.map((c) => c.id),
            ),
          );
      }

      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'payroll.run_finalized',
        subject: `payroll_runs:${run.id}`,
        detail: JSON.stringify({ month: run.month }),
      });
      for (const lp of loanPayments) {
        await tx.orm.insert(loanRepayments).values({
          loanId: lp.loanId,
          runId: run.id,
          month: run.month,
          kind: lp.kind,
          amount: String(lp.amount),
          principalPart: String(lp.principal),
          interestPart: String(lp.interest),
        });
        if (lp.closes) {
          await tx.query(
            `UPDATE org.loans SET status = $2, closed_at = now(), updated_at = now()
              WHERE id = $1 AND status = 'active'`,
            [lp.loanId, lp.kind === 'fnf' ? 'recovered_at_exit' : 'closed'],
          );
        }
      }
      for (const exitId of settleExits) {
        await tx.query(
          `UPDATE org.exit_clearances SET cleared_by = $2, cleared_at = now(), note = $3
            WHERE exit_id = $1 AND kind = 'payroll' AND cleared_at IS NULL`,
          [exitId, actor.actorEmployeeId, `F&F in the ${run.month} payroll`],
        );
        const settled = await tx.query<{ id: string }>(
          `UPDATE org.exits SET status = 'settled', settled_run_id = $2, settled_at = now(), updated_at = now()
            WHERE id = $1 AND status = 'relieved' RETURNING id`,
          [exitId, run.id],
        );
        if (!settled[0]) {
          throw Object.assign(new Error('Exit changed while finalizing'), {
            code: 'EXIT_CONFLICT',
          });
        }
        await tx.orm.insert(auditLog).values({
          actorUserId: actor.actorUserId,
          action: 'exit.settled',
          subject: `exits:${exitId}`,
          detail: JSON.stringify({ runId: run.id, month: run.month }),
        });
      }
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'payroll.auto_leave_deducted',
        subject: `payroll_runs:${run.id}`,
        detail: JSON.stringify({
          month: run.month,
          payslips: updates.length,
          totalAutoDays,
        }),
      });
      return locked[0];
    });
  },

  /**
   * What a payslip PDF prints about the person. PAN and account come back as
   * their LAST FOUR characters only — the full numbers never leave the row.
   */
  payslipHeader: async (employeeId: string) => {
    const rows = await db.orm
      .select({
        name: employees.name,
        employeeCode: employees.employeeCode,
        designation: employees.designation,
        department: departments.name,
        dateOfJoining: employees.dateOfJoining,
        panLast4: sql<string | null>`right(${employeeSalary.panNumber}, 4)`,
        bankName: employeeSalary.bankName,
        accountLast4: sql<string | null>`right(${employeeSalary.bankAccountNo}, 4)`,
      })
      .from(employees)
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .leftJoin(employeeSalary, eq(employeeSalary.employeeId, employees.id))
      .where(eq(employees.id, employeeId))
      .limit(1);
    return rows[0];
  },

  /** A slip with its run's month/status — the correction target check. */
  findPayslipWithRun: async (id: string) => {
    const rows = await db.orm
      .select({
        id: payslips.id,
        employeeId: payslips.employeeId,
        month: payrollRuns.month,
        runStatus: payrollRuns.status,
      })
      .from(payslips)
      .innerJoin(payrollRuns, eq(payslips.runId, payrollRuns.id))
      .where(eq(payslips.id, id))
      .limit(1);
    return rows[0];
  },

  /**
   * Per employee, approved-but-unpaid reimbursement claims spent in or before
   * `month` — what a draft for that month carries (draft build).
   */
  approvedClaimsUpTo: async (month: string): Promise<Map<string, number>> => {
    const rows = await db.query<{ employee_id: string; total: string }>(
      `SELECT employee_id, sum(amount) AS total FROM org.reimbursement_claims
        WHERE status = 'approved' AND to_char(spent_on, 'YYYY-MM') <= $1
        GROUP BY employee_id`,
      [month],
    );
    return new Map(rows.map((r) => [r.employee_id, Number(r.total)]));
  },

  /** Approved and paid claims of these people — the payslip's claim lines. */
  claimsFor: async (employeeIds: string[]) => {
    if (employeeIds.length === 0) return [];
    return db.orm
      .select({
        id: reimbursementClaims.id,
        employeeId: reimbursementClaims.employeeId,
        spentOn: reimbursementClaims.spentOn,
        category: reimbursementClaims.category,
        description: reimbursementClaims.description,
        amount: reimbursementClaims.amount,
        status: reimbursementClaims.status,
        paidRunId: reimbursementClaims.paidRunId,
      })
      .from(reimbursementClaims)
      .where(
        and(
          inArray(reimbursementClaims.employeeId, employeeIds),
          inArray(reimbursementClaims.status, ['approved', 'paid']),
        ),
      )
      .orderBy(reimbursementClaims.spentOn);
  },

  /** Per employee, pending corrections from months before `month` (draft build). */
  pendingCorrectionsBefore: async (month: string): Promise<Map<string, number>> => {
    const rows = await db.orm
      .select({ employeeId: payslipCorrections.employeeId, amount: payslipCorrections.amount })
      .from(payslipCorrections)
      .where(
        and(eq(payslipCorrections.status, 'pending'), lt(payslipCorrections.sourceMonth, month)),
      );
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.employeeId, (map.get(r.employeeId) ?? 0) + Number(r.amount));
    return map;
  },

  /** Corrections with names and the month they were paid in, newest first. */
  listCorrections: async (filter: { employeeIds?: string[] } = {}) => {
    if (filter.employeeIds && filter.employeeIds.length === 0) return [];
    return db.orm
      .select({
        row: payslipCorrections,
        employeeName: employees.name,
        employeeCode: employees.employeeCode,
        appliedMonth: appliedRuns.month,
        createdByName: creators.name,
      })
      .from(payslipCorrections)
      .innerJoin(employees, eq(payslipCorrections.employeeId, employees.id))
      .innerJoin(creators, eq(payslipCorrections.createdBy, creators.id))
      .leftJoin(appliedRuns, eq(payslipCorrections.appliedRunId, appliedRuns.id))
      .where(
        filter.employeeIds
          ? inArray(payslipCorrections.employeeId, filter.employeeIds)
          : undefined,
      )
      .orderBy(desc(payslipCorrections.createdAt));
  },

  /** New correction + open drafts shifted + audit + the employee's bell. */
  insertCorrection: async (
    input: {
      employeeId: string;
      sourcePayslipId: string;
      sourceMonth: string;
      amount: number;
      reason: string;
    },
    actor: ActorContext,
  ): Promise<PayslipCorrectionRow> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .insert(payslipCorrections)
        .values({ ...input, amount: String(input.amount), createdBy: actor.actorEmployeeId })
        .returning();
      await shiftDraftCorrections(tx, input.employeeId, input.sourceMonth, input.amount);
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'payroll.correction_added',
        subject: `payslips:${input.sourcePayslipId}`,
        // No amount in the org-readable audit log — pay stays out of it.
        detail: JSON.stringify({ sourceMonth: input.sourceMonth, correctionId: rows[0]!.id }),
      });
      await insertNotifications(tx, [input.employeeId], {
        type: 'payroll.correction',
        title: `A correction to your ${input.sourceMonth} payslip`,
        body: 'It will show as its own line on your next payslip.',
        link: '/my-payslips',
      });
      return rows[0]!;
    }),

  /** Pending only (the WHERE is the arbiter); drafts shift back. */
  cancelCorrection: async (
    id: string,
    actor: ActorContext,
  ): Promise<PayslipCorrectionRow | undefined> =>
    db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(payslipCorrections)
        .set({ status: 'cancelled', cancelledBy: actor.actorEmployeeId, cancelledAt: new Date() })
        .where(and(eq(payslipCorrections.id, id), eq(payslipCorrections.status, 'pending')))
        .returning();
      const row = rows[0];
      if (!row) return undefined;
      await shiftDraftCorrections(tx, row.employeeId, row.sourceMonth, -Number(row.amount));
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'payroll.correction_cancelled',
        subject: `payslips:${row.sourcePayslipId}`,
        detail: JSON.stringify({ correctionId: row.id }),
      });
      return row;
    }),

  updateRunStatus: async (
    id: string,
    patch: Partial<PayrollRunRow>,
    action: string,
    month: string,
    actor: ActorContext,
    /** The status the caller decided on — re-asserted in the WHERE (M5). */
    expectedStatus: PayrollRunRow['status'],
  ): Promise<PayrollRunRow> => {
    return db.transaction(async (tx) => {
      const rows = await tx.orm
        .update(payrollRuns)
        .set(patch)
        .where(and(eq(payrollRuns.id, id), eq(payrollRuns.status, expectedStatus)))
        .returning();
      if (!rows[0]) {
        throw Object.assign(new Error('Run status changed concurrently'), {
          code: 'RUN_CONFLICT',
        });
      }
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action,
        subject: `payroll_runs:${id}`,
        detail: JSON.stringify({ month }),
      });
      return rows[0]!;
    });
  },

  /** Draft delete: payslips go with the run (FK cascade) + audit row. */
  deleteRun: async (run: PayrollRunRow, actor: ActorContext): Promise<void> => {
    await db.transaction(async (tx) => {
      const rows = await tx.orm
        .delete(payrollRuns)
        .where(and(eq(payrollRuns.id, run.id), eq(payrollRuns.status, 'draft')))
        .returning();
      if (!rows[0]) {
        throw Object.assign(new Error('Run status changed concurrently'), {
          code: 'RUN_CONFLICT',
        });
      }
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'payroll.run_deleted',
        subject: `payroll_runs:${run.id}`,
        detail: JSON.stringify({ month: run.month }),
      });
    });
  },
});

export type PayrollRepository = ReturnType<typeof createPayrollRepository>;
