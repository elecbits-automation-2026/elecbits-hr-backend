import createError from 'http-errors';
import { hasOrgScope } from '../../shared/helpers/helpers.js';
import type { AuthzRepository } from '../access/authz.repository.js';
import { createSelfGovernance } from '../access/selfGovernance.js';
import type {
  ActorContext,
  ClaimJoinedRow,
  ReimbursementsRepository,
} from './reimbursements.repository.js';
import type {
  CreateClaimInput,
  DecideClaimInput,
  ReimbursementClaimDto,
} from './reimbursements.schema.js';

const LINK = '/reimbursements';
const PAYROLL_LINK = '/hr/payroll';

const toDto = (r: ClaimJoinedRow): ReimbursementClaimDto => ({
  id: r.row.id,
  employee: { id: r.row.employeeId, name: r.employeeName, employeeCode: r.employeeCode },
  spentOn: r.row.spentOn,
  category: r.row.category as ReimbursementClaimDto['category'],
  description: r.row.description,
  amount: Number(r.row.amount),
  receiptNote: r.row.receiptNote,
  // Filled by withReceipts on the list paths.
  receipt: null,
  status: r.row.status,
  rmDecidedByName: r.rmDecidedByName,
  rmDecidedAt: r.row.rmDecidedAt?.toISOString() ?? null,
  payrollDecidedByName: r.payrollDecidedByName,
  payrollDecidedAt: r.row.payrollDecidedAt?.toISOString() ?? null,
  declineReason: r.row.declineReason,
  paidInMonth: r.paidInMonth,
  createdAt: r.row.createdAt.toISOString(),
});

const money = (n: number) =>
  `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

/**
 * Reimbursement rules (refinement plan, Phase 3):
 *  - the employee claims; the EFFECTIVE RM approves first, then Payroll
 *    (pr.payroll update, org scope); self-governed people and anyone with no
 *    RM go straight to Payroll; nobody decides their own claim;
 *  - an approved claim is carried by the next payroll draft for a month on or
 *    after the spend month (its Reimbursement line is the sum of them — never
 *    typed) and turns `paid` when that run finalizes;
 *  - the claimant can withdraw a claim while it still waits on someone.
 */
export const createReimbursementsService = (deps: {
  repo: ReimbursementsRepository;
  authz: AuthzRepository;
}) => {
  const { repo, authz } = deps;
  const selfGoverned = createSelfGovernance(authz);

  const payrollDeciders = async (except: string[]) =>
    (await authz.listBroadHolders('pr.payroll', 'update')).filter(
      (id) => !except.includes(id),
    );

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

  const forRm = async (rmId: string) =>
    withReceipts((await repo.listForRm(rmId)).map(toDto));

  const queue = async (statuses?: ReimbursementClaimDto['status'][]) =>
    withReceipts((await repo.listAll(statuses)).map(toDto));

  const create = async (input: CreateClaimInput, actor: ActorContext) => {
    const me = await repo.findEmployee(actor.actorEmployeeId);
    if (!me)
      throw createError(404, 'Employee record not found', { code: 'EMPLOYEE_NOT_FOUND' });
    const today = new Date().toLocaleDateString('en-CA');
    if (input.spentOn > today) {
      throw createError(422, 'The spend date cannot be in the future', {
        code: 'FUTURE_DATE',
      });
    }
    const effectiveRm = me.leaveApprover ?? me.reportsTo;
    const skipRm = !effectiveRm || (await selfGoverned(me));
    const status = skipRm ? 'pending_payroll' : 'pending_rm';
    const title = `${me.name} claimed ${money(input.amount)} (${input.category.replace('_', ' / ')})`;
    const row = await repo.insert(me.id, input, status, actor, {
      to: skipRm ? await payrollDeciders([me.id]) : [effectiveRm!],
      event: {
        type: 'reimbursement.claimed',
        title,
        body: input.description,
        link: skipRm ? PAYROLL_LINK : LINK,
      },
    });
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
    if (row.status !== 'pending_rm' && row.status !== 'pending_payroll') {
      throw createError(409, 'This claim has already been decided', {
        code: 'ALREADY_DECIDED',
      });
    }
    const amount = money(Number(row.amount));
    const now = new Date();
    // Receipts are always mandatory (user decision 2026-10-22): nobody
    // approves a claim without the file. Declining one stays possible.
    if (input.decision === 'approve' && !(await repo.receiptInfo([id])).has(id)) {
      throw createError(422, 'Attach the receipt before this claim can be approved', {
        code: 'RECEIPT_REQUIRED',
      });
    }

    if (row.status === 'pending_rm') {
      const owner = await repo.findEmployee(row.employeeId);
      if (actor.actorEmployeeId !== (owner?.leaveApprover ?? owner?.reportsTo)) {
        throw createError(403, "Only this person's manager approves this step", {
          code: 'NOT_AN_APPROVER',
        });
      }
      const approve = input.decision === 'approve';
      const updated = await repo.decide(
        id,
        'pending_rm',
        approve
          ? {
              status: 'pending_payroll',
              rmDecidedBy: actor.actorEmployeeId,
              rmDecidedAt: now,
            }
          : {
              status: 'declined',
              rmDecidedBy: actor.actorEmployeeId,
              rmDecidedAt: now,
              declineReason: input.reason ?? null,
            },
        actor,
        approve
          ? {
              to: await payrollDeciders([row.employeeId, actor.actorEmployeeId]),
              event: {
                type: 'reimbursement.claimed',
                title: `${claim.employeeName}'s ${amount} claim is ready for payroll`,
                body: row.description,
                link: PAYROLL_LINK,
              },
            }
          : {
              to: [row.employeeId],
              event: {
                type: 'reimbursement.declined',
                title: `Your ${amount} claim was declined by your manager`,
                body: input.reason ?? null,
                link: LINK,
              },
            },
      );
      if (!updated) {
        throw createError(409, 'This claim has already been decided', {
          code: 'ALREADY_DECIDED',
        });
      }
      return reload(id);
    }

    // Payroll step — an org pr.payroll update grant (or the bypass).
    if (
      !hasOrgScope(
        await authz.resolveAccess(actor.actorEmployeeId, 'pr.payroll', 'update'),
      )
    ) {
      throw createError(403, 'Payroll approves this step', { code: 'NOT_AN_APPROVER' });
    }
    const approve = input.decision === 'approve';
    const updated = await repo.decide(
      id,
      'pending_payroll',
      approve
        ? {
            status: 'approved',
            payrollDecidedBy: actor.actorEmployeeId,
            payrollDecidedAt: now,
          }
        : {
            status: 'declined',
            payrollDecidedBy: actor.actorEmployeeId,
            payrollDecidedAt: now,
            declineReason: input.reason ?? null,
          },
      actor,
      {
        to: [row.employeeId],
        event: approve
          ? {
              type: 'reimbursement.approved',
              title: `Your ${amount} claim is approved`,
              body: 'It will be paid with your next payslip.',
              link: LINK,
            }
          : {
              type: 'reimbursement.declined',
              title: `Your ${amount} claim was declined by payroll`,
              body: input.reason ?? null,
              link: LINK,
            },
      },
    );
    if (!updated) {
      throw createError(409, 'This claim has already been decided', {
        code: 'ALREADY_DECIDED',
      });
    }
    return reload(id);
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

  const RECEIPT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

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
    const type = file.contentType.split(';')[0]!.trim().toLowerCase();
    if (!RECEIPT_TYPES.includes(type)) {
      throw createError(422, 'Upload a PDF, JPG or PNG', { code: 'BAD_FILE_TYPE' });
    }
    if (file.data.length === 0 || file.data.length > 10 * 1024 * 1024) {
      throw createError(422, 'The file must be under 10 MB', { code: 'BAD_FILE_SIZE' });
    }
    await repo.upsertReceipt(
      { claimId: id, fileName: file.fileName, contentType: type, data: file.data },
      actor,
    );
    return reload(id);
  };

  /** The claimant, their RM, or payroll (org) may open it. */
  const receipt = async (id: string, callerId: string) => {
    const claim = await repo.findById(id);
    if (!claim)
      throw createError(404, 'Receipt not found', { code: 'RECEIPT_NOT_FOUND' });
    if (claim.row.employeeId !== callerId) {
      const me = await repo.findEmployee(claim.row.employeeId);
      const isRm = (me?.leaveApprover ?? me?.reportsTo) === callerId;
      const pr = await authz.resolveAccess(callerId, 'pr.payroll', 'read');
      if (!isRm && !hasOrgScope(pr)) {
        throw createError(404, 'Receipt not found', { code: 'RECEIPT_NOT_FOUND' });
      }
    }
    const file = await repo.getReceipt(id);
    if (!file) throw createError(404, 'Receipt not found', { code: 'RECEIPT_NOT_FOUND' });
    return file;
  };

  return { mine, forRm, queue, create, decide, cancel, uploadReceipt, receipt };
};

export type ReimbursementsService = ReturnType<typeof createReimbursementsService>;
