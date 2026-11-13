import createError from 'http-errors';
import { checkUpload } from '../../shared/helpers/uploads.js';
import type { AuthzRepository } from '../access/authz.repository.js';
import { buildBankFile } from './reimbursements.export.js';
import type {
  ActorContext,
  ClaimJoinedRow,
  ReimbursementsRepository,
} from './reimbursements.repository.js';
import type {
  CreateClaimInput,
  DecideClaimInput,
  MarkPaidInput,
  ReimbursementClaimDto,
  ReimbursementStatus,
} from './reimbursements.schema.js';

const toDto = (r: ClaimJoinedRow): ReimbursementClaimDto => ({
  id: r.row.id,
  employee: { id: r.row.employeeId, name: r.employeeName, employeeCode: r.employeeCode },
  department: r.department,
  spentOn: r.row.spentOn,
  category: r.row.category as ReimbursementClaimDto['category'],
  description: r.row.description,
  amount: Number(r.row.amount),
  receiptNote: r.row.receiptNote,
  // Filled by withReceipts on the list paths.
  receipt: null,
  status: r.row.status,
  payrollDecidedByName: r.payrollDecidedByName,
  payrollDecidedAt: r.row.payrollDecidedAt?.toISOString() ?? null,
  adminDecidedByName: r.adminDecidedByName,
  adminDecidedAt: r.row.adminDecidedAt?.toISOString() ?? null,
  declineReason: r.row.declineReason,
  paidOn: r.row.paidOn,
  paymentRef: r.row.paymentRef,
  paidByName: r.paidByName,
  paidInMonth: r.paidInMonth,
  createdAt: r.row.createdAt.toISOString(),
});

const todayIso = () => new Date().toLocaleDateString('en-CA');

/**
 * Reimbursement rules (learner, 2026-11-05):
 *  - the employee claims; PR approves (anyone holding pr.payroll update at org
 *    scope — the PR batch), then the Admin account. A PR person's own claim
 *    goes to Admin only. There is no RM step and nothing is auto-approved;
 *  - the Admin account may act at either step, and its approval is final;
 *  - a decline (PR or Admin) is final, with a reason; nobody decides their own
 *    claim; a receipt file is needed to approve;
 *  - the Admin account raises no claims (it is not a person);
 *  - approved claims are NOT on the payslip: PR downloads the bank file, pays
 *    by transfer, then marks them paid (date + bank reference);
 *  - no bells per claim — the monthly reimbursement-digest job rings PR and
 *    Admin; claimants see the status on their page;
 *  - the claimant can withdraw a claim while it still waits on someone.
 */
export const createReimbursementsService = (deps: {
  repo: ReimbursementsRepository;
  authz: AuthzRepository;
}) => {
  const { repo, authz } = deps;

  /** In the PR batch: pr.payroll update at org scope (SuperAdmins too, not the Owner). */
  const isPr = async (employeeId: string, ownerId: string | null) => {
    if (employeeId === ownerId) return false;
    const access = await authz.resolveAccess(employeeId, 'pr.payroll', 'update');
    return access.bypass || access.scopes.includes('org');
  };

  /** Attach the uploaded receipt (file name + time) to each claim. */
  const withReceipts = async (dtos: ReimbursementClaimDto[]) => {
    const info = await repo.receiptInfo(dtos.map((d) => d.id));
    return dtos.map((d) => {
      const r = info.get(d.id);
      return r
        ? {
            ...d,
            receipt: { fileName: r.fileName, uploadedAt: r.uploadedAt.toISOString() },
          }
        : d;
    });
  };

  const reload = async (id: string) =>
    (await withReceipts([toDto((await repo.findById(id))!)]))[0]!;

  const mine = async (employeeId: string) =>
    withReceipts((await repo.listMine(employeeId)).map(toDto));

  /** PR / Admin: every claim, by status and the month it was approved in. */
  const queue = async (filter: { statuses?: ReimbursementStatus[]; month?: string }) =>
    withReceipts((await repo.listAll(filter)).map(toDto));

  const create = async (input: CreateClaimInput, actor: ActorContext) => {
    const me = await repo.findEmployee(actor.actorEmployeeId);
    if (!me)
      throw createError(404, 'Employee record not found', { code: 'EMPLOYEE_NOT_FOUND' });
    const ownerId = await authz.ownerId();
    if (me.id === ownerId) {
      throw createError(403, 'The Admin account does not raise claims', {
        code: 'OWNER_NO_CLAIMS',
      });
    }
    if (input.spentOn > todayIso()) {
      throw createError(422, 'The spend date cannot be in the future', {
        code: 'FUTURE_DATE',
      });
    }
    // PR people never approve their own claims, so theirs go to Admin only.
    const status = (await isPr(me.id, ownerId)) ? 'pending_admin' : 'pending_payroll';
    const row = await repo.insert(me.id, input, status, actor);
    return reload(row.id);
  };

  const decide = async (id: string, input: DecideClaimInput, actor: ActorContext) => {
    const claim = await repo.findById(id);
    if (!claim) throw createError(404, 'Claim not found', { code: 'CLAIM_NOT_FOUND' });
    const row = claim.row;
    if (row.employeeId === actor.actorEmployeeId) {
      throw createError(403, 'You cannot decide your own claim', {
        code: 'NO_SELF_APPROVAL',
      });
    }
    if (row.status !== 'pending_payroll' && row.status !== 'pending_admin') {
      throw createError(409, 'This claim has already been decided', {
        code: 'ALREADY_DECIDED',
      });
    }
    // Receipts are always mandatory (user decision 2026-10-22): nobody
    // approves a claim without the file. Declining one stays possible.
    if (input.decision === 'approve' && !(await repo.receiptInfo([id])).has(id)) {
      throw createError(422, 'Attach the receipt before this claim can be approved', {
        code: 'RECEIPT_REQUIRED',
      });
    }

    const ownerId = await authz.ownerId();
    const approve = input.decision === 'approve';
    const now = new Date();
    const by = actor.actorEmployeeId;
    const decline = { status: 'declined' as const, declineReason: input.reason ?? null };

    let patch: Parameters<ReimbursementsRepository['decide']>[2];
    if (by === ownerId) {
      // Admin: at either step, and an approval is final.
      patch = approve
        ? { status: 'approved', adminDecidedBy: by, adminDecidedAt: now }
        : { ...decline, adminDecidedBy: by, adminDecidedAt: now };
    } else if (row.status === 'pending_payroll' && (await isPr(by, ownerId))) {
      patch = approve
        ? { status: 'pending_admin', payrollDecidedBy: by, payrollDecidedAt: now }
        : { ...decline, payrollDecidedBy: by, payrollDecidedAt: now };
    } else {
      throw createError(
        403,
        row.status === 'pending_admin'
          ? 'This claim is waiting for the Admin account'
          : 'PR approves this step',
        { code: 'NOT_AN_APPROVER' },
      );
    }

    const updated = await repo.decide(id, row.status, patch, actor);
    if (!updated) {
      throw createError(409, 'This claim has already been decided', {
        code: 'ALREADY_DECIDED',
      });
    }
    return reload(id);
  };

  /** The bank file of approved claims (all, or those approved in `month`). */
  const bankFile = async (month?: string) => {
    const rows = await repo.toPay(month);
    const label = month ?? todayIso().slice(0, 7);
    return {
      fileName: `reimbursements-${label}.xlsx`,
      data: await buildBankFile(rows, label),
    };
  };

  /** After the transfer: PR (or Admin) marks the claims paid, all or none. */
  const markPaid = async (input: MarkPaidInput, actor: ActorContext) => {
    if (input.paidOn > todayIso()) {
      throw createError(422, 'The payment date cannot be in the future', {
        code: 'FUTURE_DATE',
      });
    }
    try {
      const rows = await repo.markPaid(
        [...new Set(input.claimIds)],
        { paidOn: input.paidOn, reference: input.reference },
        actor,
      );
      return {
        paid: rows.length,
        total: Math.round(rows.reduce((a, r) => a + Number(r.amount), 0) * 100) / 100,
      };
    } catch (err) {
      if ((err as { code?: string }).code === 'NOT_APPROVED') {
        throw createError(
          409,
          'Some of these claims are not approved-and-unpaid any more — reload and try again',
          { code: 'NOT_APPROVED' },
        );
      }
      throw err;
    }
  };

  const cancel = async (id: string, actor: ActorContext) => {
    const row = await repo.cancel(id, actor);
    if (!row) {
      throw createError(
        409,
        'Only your own claim that is still waiting can be withdrawn',
        {
          code: 'CANNOT_CANCEL',
        },
      );
    }
    return reload(id);
  };

  /** The claimant attaches (or replaces) the receipt while the claim is live. */
  const uploadReceipt = async (
    id: string,
    file: { fileName: string; contentType: string; data: Buffer },
    actor: ActorContext,
  ) => {
    const claim = await repo.findById(id);
    if (!claim || claim.row.employeeId !== actor.actorEmployeeId) {
      throw createError(404, 'Claim not found', { code: 'CLAIM_NOT_FOUND' });
    }
    if (claim.row.status === 'declined' || claim.row.status === 'cancelled') {
      throw createError(409, `This claim is ${claim.row.status}`, {
        code: 'CLAIM_CLOSED',
      });
    }
    const type = checkUpload(file, ['pdf', 'jpg', 'png'], { what: 'The receipt' });
    await repo.upsertReceipt(
      { claimId: id, fileName: file.fileName, contentType: type, data: file.data },
      actor,
    );
    return reload(id);
  };

  /** The claimant, PR (pr.payroll read, org) or the Admin account may open it. */
  const receipt = async (id: string, callerId: string) => {
    const claim = await repo.findById(id);
    if (!claim)
      throw createError(404, 'Receipt not found', { code: 'RECEIPT_NOT_FOUND' });
    if (claim.row.employeeId !== callerId) {
      const pr = await authz.resolveAccess(callerId, 'pr.payroll', 'read');
      if (!pr.bypass && !pr.scopes.includes('org')) {
        throw createError(404, 'Receipt not found', { code: 'RECEIPT_NOT_FOUND' });
      }
    }
    const file = await repo.getReceipt(id);
    if (!file) throw createError(404, 'Receipt not found', { code: 'RECEIPT_NOT_FOUND' });
    return file;
  };

  return { mine, queue, create, decide, bankFile, markPaid, cancel, uploadReceipt, receipt };
};

export type ReimbursementsService = ReturnType<typeof createReimbursementsService>;
