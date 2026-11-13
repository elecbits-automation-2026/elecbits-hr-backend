import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbClient } from '../../db/client.js';
import {
  auditLog,
  claimReceipts,
  departments,
  employees,
  employeeSalary,
  payrollRuns,
  reimbursementClaims,
} from '../../db/schema/index.js';
import type { CreateClaimInput, ReimbursementStatus } from './reimbursements.schema.js';

export type ClaimRow = typeof reimbursementClaims.$inferSelect;

/** Who performed the mutation — for the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

/** The two steps a claim waits at: PR, then the Admin account. */
export type OpenStatus = 'pending_payroll' | 'pending_admin';

const payrollDecider = alias(employees, 'payroll_decider');
const adminDecider = alias(employees, 'admin_decider');
const payer = alias(employees, 'payer');

const joined = {
  row: reimbursementClaims,
  employeeName: employees.name,
  employeeCode: employees.employeeCode,
  department: departments.name,
  payrollDecidedByName: payrollDecider.name,
  adminDecidedByName: adminDecider.name,
  paidByName: payer.name,
  paidInMonth: payrollRuns.month,
};

export type ClaimJoinedRow = {
  row: ClaimRow;
  employeeName: string;
  employeeCode: string;
  department: string | null;
  payrollDecidedByName: string | null;
  adminDecidedByName: string | null;
  paidByName: string | null;
  paidInMonth: string | null;
};

/** The month a claim was approved in: Admin's decision, or PR's for older claims. */
const approvedMonth = sql<string | null>`to_char(coalesce(${reimbursementClaims.adminDecidedAt}, ${reimbursementClaims.payrollDecidedAt}) AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM')`;

/** The only place the reimbursements feature touches the database. */
export const createReimbursementsRepository = (db: DbClient) => {
  const select = () =>
    db.orm
      .select(joined)
      .from(reimbursementClaims)
      .innerJoin(employees, eq(reimbursementClaims.employeeId, employees.id))
      .leftJoin(departments, eq(employees.departmentId, departments.id))
      .leftJoin(
        payrollDecider,
        eq(reimbursementClaims.payrollDecidedBy, payrollDecider.id),
      )
      .leftJoin(adminDecider, eq(reimbursementClaims.adminDecidedBy, adminDecider.id))
      .leftJoin(payer, eq(reimbursementClaims.paidBy, payer.id))
      .leftJoin(payrollRuns, eq(reimbursementClaims.paidRunId, payrollRuns.id));

  return {
    findEmployee: async (employeeId: string) =>
      (
        await db.orm
          .select({
            id: employees.id,
            name: employees.name,
            status: employees.status,
          })
          .from(employees)
          .where(eq(employees.id, employeeId))
          .limit(1)
      )[0],

    findById: async (id: string): Promise<ClaimJoinedRow | undefined> =>
      (await select().where(eq(reimbursementClaims.id, id)).limit(1))[0],

    listMine: (employeeId: string): Promise<ClaimJoinedRow[]> =>
      select()
        .where(eq(reimbursementClaims.employeeId, employeeId))
        .orderBy(desc(reimbursementClaims.createdAt)),

    /**
     * PR / Admin's view: everything, or some statuses; `month` (YYYY-MM)
     * keeps the claims approved in that month (the reimbursement sheet).
     */
    listAll: (filter: {
      statuses?: ReimbursementStatus[];
      month?: string;
    }): Promise<ClaimJoinedRow[]> =>
      select()
        .where(
          and(
            filter.statuses?.length
              ? inArray(reimbursementClaims.status, filter.statuses)
              : undefined,
            filter.month ? sql`${approvedMonth} = ${filter.month}` : undefined,
          ),
        )
        .orderBy(desc(reimbursementClaims.createdAt)),

    /** Approved claims with the bank details the transfer file needs (PR scope). */
    toPay: (month?: string) =>
      db.orm
        .select({
          claimId: reimbursementClaims.id,
          employeeId: employees.id,
          name: employees.name,
          employeeCode: employees.employeeCode,
          email: employees.email,
          department: departments.name,
          spentOn: reimbursementClaims.spentOn,
          category: reimbursementClaims.category,
          description: reimbursementClaims.description,
          amount: reimbursementClaims.amount,
          prName: payrollDecider.name,
          adminName: adminDecider.name,
          approvedMonth,
          bankName: employeeSalary.bankName,
          accountNo: employeeSalary.bankAccountNo,
          ifsc: employeeSalary.ifscCode,
        })
        .from(reimbursementClaims)
        .innerJoin(employees, eq(reimbursementClaims.employeeId, employees.id))
        .leftJoin(departments, eq(employees.departmentId, departments.id))
        .leftJoin(employeeSalary, eq(employeeSalary.employeeId, employees.id))
        .leftJoin(
          payrollDecider,
          eq(reimbursementClaims.payrollDecidedBy, payrollDecider.id),
        )
        .leftJoin(adminDecider, eq(reimbursementClaims.adminDecidedBy, adminDecider.id))
        .where(
          and(
            eq(reimbursementClaims.status, 'approved'),
            month ? sql`${approvedMonth} = ${month}` : undefined,
          ),
        )
        .orderBy(employees.name, reimbursementClaims.spentOn),

    /** New claim + audit, one transaction (no bells — the monthly digest rings). */
    insert: async (
      employeeId: string,
      input: CreateClaimInput,
      status: OpenStatus,
      actor: ActorContext,
    ): Promise<ClaimRow> =>
      db.transaction(async (tx) => {
        const rows = await tx.orm
          .insert(reimbursementClaims)
          .values({
            employeeId,
            spentOn: input.spentOn,
            category: input.category,
            description: input.description,
            amount: String(input.amount),
            receiptNote: input.receiptNote ?? null,
            status,
          })
          .returning();
        await tx.orm.insert(auditLog).values({
          actorUserId: actor.actorUserId,
          action: 'reimbursement.claimed',
          subject: `employees:${employeeId}`,
          detail: JSON.stringify({ claimId: rows[0]!.id, status }),
        });
        return rows[0]!;
      }),

    /**
     * One step of the trail. The WHERE re-asserts the expected status so a
     * double decision returns nothing.
     */
    decide: async (
      id: string,
      from: OpenStatus,
      patch: Partial<ClaimRow>,
      actor: ActorContext,
    ): Promise<ClaimRow | undefined> =>
      db.transaction(async (tx) => {
        const rows = await tx.orm
          .update(reimbursementClaims)
          .set({ ...patch, updatedAt: new Date() })
          .where(
            and(eq(reimbursementClaims.id, id), eq(reimbursementClaims.status, from)),
          )
          .returning();
        const row = rows[0];
        if (!row) return undefined;
        await tx.orm.insert(auditLog).values({
          actorUserId: actor.actorUserId,
          action: `reimbursement.${row.status === 'declined' ? 'declined' : 'approved'}`,
          subject: `employees:${row.employeeId}`,
          detail: JSON.stringify({ claimId: row.id, step: from, status: row.status }),
        });
        return row;
      }),

    /**
     * Mark approved claims paid by bank transfer, all or none: if any id is
     * not `approved` any more the transaction rolls back (NOT_APPROVED).
     */
    markPaid: async (
      claimIds: string[],
      payment: { paidOn: string; reference: string },
      actor: ActorContext,
    ): Promise<ClaimRow[]> =>
      db.transaction(async (tx) => {
        const rows = await tx.orm
          .update(reimbursementClaims)
          .set({
            status: 'paid',
            paidOn: payment.paidOn,
            paymentRef: payment.reference,
            paidBy: actor.actorEmployeeId,
            paidAt: new Date(),
            updatedAt: new Date(),
          })
          .where(
            and(
              inArray(reimbursementClaims.id, claimIds),
              eq(reimbursementClaims.status, 'approved'),
            ),
          )
          .returning();
        if (rows.length !== new Set(claimIds).size) {
          throw Object.assign(new Error('Claims changed'), { code: 'NOT_APPROVED' });
        }
        for (const row of rows) {
          await tx.orm.insert(auditLog).values({
            actorUserId: actor.actorUserId,
            action: 'reimbursement.paid',
            subject: `employees:${row.employeeId}`,
            detail: JSON.stringify({
              claimId: row.id,
              amount: Number(row.amount),
              paidOn: payment.paidOn,
              reference: payment.reference,
            }),
          });
        }
        return rows;
      }),

    /** The claimant withdraws a claim that is still waiting on someone. */
    cancel: async (id: string, actor: ActorContext): Promise<ClaimRow | undefined> =>
      db.transaction(async (tx) => {
        const rows = await tx.orm
          .update(reimbursementClaims)
          .set({ status: 'cancelled', updatedAt: new Date() })
          .where(
            and(
              eq(reimbursementClaims.id, id),
              eq(reimbursementClaims.employeeId, actor.actorEmployeeId),
              inArray(reimbursementClaims.status, ['pending_payroll', 'pending_admin']),
            ),
          )
          .returning();
        if (rows[0]) {
          await tx.orm.insert(auditLog).values({
            actorUserId: actor.actorUserId,
            action: 'reimbursement.cancelled',
            subject: `employees:${rows[0].employeeId}`,
            detail: JSON.stringify({ claimId: rows[0].id }),
          });
        }
        return rows[0];
      }),

    /** Receipt file name + time per claim (no bytes). */
    receiptInfo: async (claimIds: string[]) => {
      if (claimIds.length === 0)
        return new Map<string, { fileName: string; uploadedAt: Date }>();
      const rows = await db.orm
        .select({
          claimId: claimReceipts.claimId,
          fileName: claimReceipts.fileName,
          uploadedAt: claimReceipts.uploadedAt,
        })
        .from(claimReceipts)
        .where(inArray(claimReceipts.claimId, claimIds));
      return new Map(rows.map((r) => [r.claimId, r]));
    },

    /** Store (or replace) a claim's receipt, with its audit row. */
    upsertReceipt: async (
      file: { claimId: string; fileName: string; contentType: string; data: Buffer },
      actor: ActorContext,
    ): Promise<void> =>
      db.transaction(async (tx) => {
        await tx.orm
          .insert(claimReceipts)
          .values({
            claimId: file.claimId,
            fileName: file.fileName,
            contentType: file.contentType,
            sizeBytes: file.data.length,
            data: file.data,
            uploadedBy: actor.actorEmployeeId,
          })
          .onConflictDoUpdate({
            target: claimReceipts.claimId,
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
          action: 'reimbursement.receipt_uploaded',
          subject: `employees:${actor.actorEmployeeId}`,
          detail: JSON.stringify({ claimId: file.claimId, bytes: file.data.length }),
        });
      }),

    getReceipt: async (claimId: string) =>
      (
        await db.orm
          .select({
            fileName: claimReceipts.fileName,
            contentType: claimReceipts.contentType,
            data: claimReceipts.data,
          })
          .from(claimReceipts)
          .where(eq(claimReceipts.claimId, claimId))
          .limit(1)
      )[0],
  };
};

export type ReimbursementsRepository = ReturnType<typeof createReimbursementsRepository>;
