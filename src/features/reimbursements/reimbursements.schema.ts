import { z } from '../../shared/zod.js';

export const REIMBURSEMENT_CATEGORIES = [
  'travel',
  'food',
  'internet_phone',
  'equipment',
  'other',
] as const;

// `pending_rm` is history only — the RM step was removed on 2026-11-05.
const STATUSES = [
  'pending_rm',
  'pending_payroll',
  'pending_admin',
  'approved',
  'paid',
  'declined',
  'cancelled',
] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

export const reimbursementClaimSchema = z
  .object({
    id: z.string().uuid(),
    employee: z.object({
      id: z.string().uuid(),
      name: z.string(),
      employeeCode: z.string(),
    }),
    department: z.string().nullable(),
    spentOn: z.string(),
    category: z.enum(REIMBURSEMENT_CATEGORIES),
    description: z.string(),
    amount: z.number(),
    receiptNote: z.string().nullable(),
    // The uploaded receipt file, if any (close-out).
    receipt: z
      .object({ fileName: z.string(), uploadedAt: z.string().datetime() })
      .nullable(),
    status: z.enum(STATUSES),
    /** PR's step (the column keeps its old "payroll" name). */
    payrollDecidedByName: z.string().nullable(),
    payrollDecidedAt: z.string().datetime().nullable(),
    adminDecidedByName: z.string().nullable(),
    adminDecidedAt: z.string().datetime().nullable(),
    declineReason: z.string().nullable(),
    /** Paid from the reimbursement sheet: transfer date + bank reference. */
    paidOn: z.string().nullable(),
    paymentRef: z.string().nullable(),
    paidByName: z.string().nullable(),
    /** YYYY-MM of the payroll run that paid it (claims paid before 2026-11-05). */
    paidInMonth: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('ReimbursementClaim');

export const createClaimSchema = z
  .object({
    spentOn: isoDate,
    category: z.enum(REIMBURSEMENT_CATEGORIES),
    description: z.string().trim().min(5).max(500),
    amount: z.number().positive().max(1_000_000),
    receiptNote: z.string().trim().max(300).optional(),
  })
  .strict()
  .openapi('CreateReimbursementClaim');

export const decideClaimSchema = z
  .object({
    decision: z.enum(['approve', 'decline']),
    reason: z.string().trim().max(500).optional(),
  })
  .strict()
  .refine((v) => v.decision === 'approve' || (v.reason ?? '').length >= 5, {
    message: 'Say why it is declined (at least 5 characters)',
    path: ['reason'],
  })
  .openapi('DecideReimbursementClaim');

export const markPaidSchema = z
  .object({
    claimIds: z.array(z.string().uuid()).min(1).max(500),
    paidOn: isoDate,
    reference: z.string().trim().min(3).max(100),
  })
  .strict()
  .openapi('MarkReimbursementsPaid');

export const markPaidResultSchema = z
  .object({ paid: z.number().int(), total: z.number() })
  .openapi('MarkReimbursementsPaidResult');

export type ReimbursementClaimDto = z.infer<typeof reimbursementClaimSchema>;
export type CreateClaimInput = z.infer<typeof createClaimSchema>;
export type DecideClaimInput = z.infer<typeof decideClaimSchema>;
export type MarkPaidInput = z.infer<typeof markPaidSchema>;
export type ReimbursementStatus = (typeof STATUSES)[number];
