import { eq, inArray } from 'drizzle-orm';
import type { DbClient } from '../../db/client.js';
import { auditLog, loanRepayments, loans } from '../../db/schema/index.js';
import { insertNotifications } from '../notifications/index.js';

export type LoanRow = typeof loans.$inferSelect;

export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

/** A loan joined to its person and what has come back so far. */
export interface LoanViewRow extends LoanRow {
  employeeName: string;
  employeeCode: string;
  repaidPrincipal: number;
  repaidInterest: number;
  instalments: number;
}

/** DB access for the loan / advance register. Amounts never reach the audit log. */
export const createLoansRepository = (db: DbClient) => {
  const views = async (where: string, params: unknown[]): Promise<LoanViewRow[]> => {
    const rows = await db.query<{
      id: string;
      employee_name: string;
      employee_code: string;
      repaid_principal: string;
      repaid_interest: string;
      instalments: number;
    }>(
      `SELECT l.id, e.name AS employee_name, e.employee_code,
              coalesce(sum(r.principal_part), 0)::text AS repaid_principal,
              coalesce(sum(r.interest_part), 0)::text AS repaid_interest,
              count(r.id)::int AS instalments
         FROM org.loans l
         JOIN org.employees e ON e.id = l.employee_id
         LEFT JOIN org.loan_repayments r ON r.loan_id = l.id
        ${where}
        GROUP BY l.id, e.name, e.employee_code`,
      params,
    );
    if (rows.length === 0) return [];
    const full = await db.orm
      .select()
      .from(loans)
      .where(
        inArray(
          loans.id,
          rows.map((r) => r.id),
        ),
      );
    const byId = new Map(full.map((f) => [f.id, f]));
    return rows.map((r) => ({
      ...byId.get(r.id)!,
      employeeName: r.employee_name,
      employeeCode: r.employee_code,
      repaidPrincipal: Number(r.repaid_principal),
      repaidInterest: Number(r.repaid_interest),
      instalments: r.instalments,
    }));
  };

  return {
    all: () => views('', []),
    ofEmployee: (employeeId: string) => views('WHERE l.employee_id = $1', [employeeId]),
    one: async (id: string) => (await views('WHERE l.id = $1', [id]))[0],
    /** Active loans of these people that have started by this month. */
    dueIn: (employeeIds: string[], month: string) =>
      employeeIds.length
        ? views(
            `WHERE l.status = 'active' AND l.start_month <= $2 AND l.employee_id = ANY($1::uuid[])`,
            [employeeIds, month],
          )
        : Promise.resolve([] as LoanViewRow[]),

    activeOf: (employeeIds: string[]) =>
      employeeIds.length
        ? views(`WHERE l.status = 'active' AND l.employee_id = ANY($1::uuid[])`, [
            employeeIds,
          ])
        : Promise.resolve([] as LoanViewRow[]),

    repayments: (loanId: string) =>
      db.orm.select().from(loanRepayments).where(eq(loanRepayments.loanId, loanId)),

    /** What the eligibility rule needs: confirmed full-time, not leaving. */
    eligibility: async (employeeId: string) =>
      (
        await db.query<{
          name: string;
          status: string;
          employment_type: string | null;
          confirmation_date: string | null;
          probation_open: boolean;
        }>(
          `SELECT e.name, e.status, e.employment_type, e.confirmation_date::text,
                  EXISTS (SELECT 1 FROM org.probation_reviews r
                           WHERE r.employee_id = e.id AND r.status IN ('pending','recommended')) AS probation_open
             FROM org.employees e WHERE e.id = $1`,
          [employeeId],
        )
      )[0],

    runLocked: async (month: string): Promise<boolean> =>
      (
        await db.query<{ status: string }>(
          `SELECT status FROM org.payroll_runs WHERE month = $1`,
          [month],
        )
      ).some((r) => r.status !== 'draft'),

    insert: (values: typeof loans.$inferInsert, actor: ActorContext): Promise<string> =>
      db.transaction(async (tx) => {
        const rows = await tx.orm.insert(loans).values(values).returning();
        const id = rows[0]!.id;
        await tx.orm.insert(auditLog).values({
          actorUserId: actor.actorUserId,
          action: 'payroll.loan_recorded',
          subject: `loans:${id}`,
          detail: JSON.stringify({ employeeId: values.employeeId, kind: values.kind }),
        });
        await insertNotifications(tx, [values.employeeId], {
          type: 'payroll.loan',
          title: `A ${values.kind === 'advance' ? 'salary advance' : 'loan'} is on record for you — repayments start with the ${values.startMonth} payroll`,
          link: '/my-payslips',
        });
        return id;
      }),

    update: (
      id: string,
      patch: Partial<typeof loans.$inferInsert>,
      actor: ActorContext,
    ) =>
      db.transaction(async (tx) => {
        const rows = await tx.orm
          .update(loans)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(loans.id, id))
          .returning();
        if (rows[0]) {
          await tx.orm.insert(auditLog).values({
            actorUserId: actor.actorUserId,
            action: 'payroll.loan_updated',
            subject: `loans:${id}`,
            detail: JSON.stringify({ fields: Object.keys(patch) }),
          });
        }
        return rows[0];
      }),

    /** Settled outside payroll: the balance is written as one repayment and the loan closes. */
    closeOutside: (
      id: string,
      balance: number,
      note: string,
      actor: ActorContext,
    ): Promise<boolean> =>
      db.transaction(async (tx) => {
        const rows = await tx.query<{ id: string }>(
          `UPDATE org.loans SET status = 'closed', closed_at = now(), updated_at = now(),
                  note = coalesce(note || E'\\n', '') || $2
            WHERE id = $1 AND status = 'active' RETURNING id`,
          [id, note],
        );
        if (!rows[0]) return false;
        if (balance > 0) {
          await tx.orm.insert(loanRepayments).values({
            loanId: id,
            kind: 'outside',
            amount: String(balance),
            principalPart: String(balance),
            interestPart: '0',
          });
        }
        await tx.orm.insert(auditLog).values({
          actorUserId: actor.actorUserId,
          action: 'payroll.loan_closed',
          subject: `loans:${id}`,
          detail: JSON.stringify({ outside: true }),
        });
        return true;
      }),
  };
};

export type LoansRepository = ReturnType<typeof createLoansRepository>;
