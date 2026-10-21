import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { DbClient } from '../../db/client.js';
import {
  auditLog,
  claimReceipts,
  employees,
  payrollRuns,
  reimbursementClaims,
} from '../../db/schema/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';
import type { CreateClaimInput, ReimbursementStatus } from './reimbursements.schema.js';

export type ClaimRow = typeof reimbursementClaims.$inferSelect;

/** Who performed the mutation — for the audit row (§10). */
export interface ActorContext {
  actorUserId: string;
  actorEmployeeId: string;
}

const rmDecider = alias(employees, 'rm_decider');
const payrollDecider = alias(employees, 'payroll_decider');

const joined = {
  row: reimbursementClaims,
  employeeName: employees.name,
  employeeCode: employees.employeeCode,
  rmDecidedByName: rmDecider.name,
  payrollDecidedByName: payrollDecider.name,
  paidInMonth: payrollRuns.month,
};

export type ClaimJoinedRow = {
  row: ClaimRow;
  employeeName: string;
  employeeCode: string;
  rmDecidedByName: string | null;
  payrollDecidedByName: string | null;
  paidInMonth: string | null;
};

/**
 * Move one employee's open DRAFT payslips by an approved claim — the
 * Reimbursement line and final pay together, for every draft month on or
 * after the month the money was spent. Inside the caller's transaction.
 */
const shiftDrafts = async (
  tx: DbClient,
  employeeId: string,
  spentOn: string,
  delta: number,
): Promise<void> => {
  await tx.query(
    `UPDATE org.payslips p
        SET reimbursement = reimbursement + $1, final_pay = final_pay + $1, updated_at = now()
       FROM org.payroll_runs r
      WHERE p.run_id = r.id AND r.status = 'draft'
        AND p.employee_id = $2 AND r.month >= to_char($3::date, 'YYYY-MM')`,
    [delta, employeeId, spentOn],
  );
};

/** The only place the reimbursements feature touches the database. */
export const createReimbursementsRepository = (db: DbClient) => {
  const select = () =>
    db.orm
      .select(joined)
      .from(reimbursementClaims)
      .innerJoin(employees, eq(reimbursementClaims.employeeId, employees.id))
      .leftJoin(rmDecider, eq(reimbursementClaims.rmDecidedBy, rmDecider.id))
      .leftJoin(
        payrollDecider,
        eq(reimbursementClaims.payrollDecidedBy, payrollDecider.id),
      )
      .leftJoin(payrollRuns, eq(reimbursementClaims.paidRunId, payrollRuns.id));

  return {
    findEmployee: async (employeeId: string) =>
      (
        await db.orm
          .select({
            id: employees.id,
            name: employees.name,
            status: employees.status,
            reportsTo: employees.reportsTo,
            leaveApprover: employees.leaveApprover,
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

    /** Claims waiting on this RM: their effective reports, RM step only. */
    listForRm: (rmId: string): Promise<ClaimJoinedRow[]> =>
      select()
        .where(
          and(
            eq(reimbursementClaims.status, 'pending_rm'),
            sql`coalesce(${employees.leaveApprover}, ${employees.reportsTo}) = ${rmId}`,
          ),
        )
        .orderBy(reimbursementClaims.createdAt),

    /** Payroll's view: everything, or one or more statuses. */
    listAll: (statuses?: ReimbursementStatus[]): Promise<ClaimJoinedRow[]> =>
      select()
        .where(
          statuses?.length ? inArray(reimbursementClaims.status, statuses) : undefined,
        )
        .orderBy(desc(reimbursementClaims.createdAt)),

    /** New claim + audit + the first approver's bell, one transaction. */
    insert: async (
      employeeId: string,
      input: CreateClaimInput,
      status: 'pending_rm' | 'pending_payroll',
      actor: ActorContext,
      bell: { to: string[]; event: NotificationEvent },
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
        await insertNotifications(tx, bell.to, bell.event);
        return rows[0]!;
      }),

    /**
     * One step of the trail. The WHERE re-asserts the expected status so a
     * double decision returns nothing; an approval that completes the trail
     * shifts the open payroll drafts in the same transaction.
     */
    decide: async (
      id: string,
      from: 'pending_rm' | 'pending_payroll',
      patch: Partial<ClaimRow>,
      actor: ActorContext,
      bell: { to: string[]; event: NotificationEvent },
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
        if (row.status === 'approved') {
          await shiftDrafts(tx, row.employeeId, row.spentOn, Number(row.amount));
        }
        await tx.orm.insert(auditLog).values({
          actorUserId: actor.actorUserId,
          action: `reimbursement.${row.status === 'declined' ? 'declined' : 'approved'}`,
          subject: `employees:${row.employeeId}`,
          detail: JSON.stringify({ claimId: row.id, step: from, status: row.status }),
        });
        await insertNotifications(tx, bell.to, bell.event);
        return row;
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
              inArray(reimbursementClaims.status, ['pending_rm', 'pending_payroll']),
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
