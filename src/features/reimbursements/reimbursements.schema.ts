import { z } from '../../shared/zod.js';

export const REIMBURSEMENT_CATEGORIES = [
  'travel',
  'food',
  'internet_phone',
  'equipment',
  'other',
] as const;

const STATUSES = [
  'pending_rm',
  'pending_payroll',
  'approved',
  'paid',
  'declined',
  'cancelled',
] as const;

export const reimbursementClaimSchema = z
  .object({
    id: z.string().uuid(),
    employee: z.object({
      id: z.string().uuid(),
      name: z.string(),
      employeeCode: z.string(),
    }),
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
    rmDecidedByName: z.string().nullable(),
    rmDecidedAt: z.string().datetime().nullable(),
    payrollDecidedByName: z.string().nullable(),
    payrollDecidedAt: z.string().datetime().nullable(),
    declineReason: z.string().nullable(),
    /** YYYY-MM of the payroll run that paid it, once paid. */
    paidInMonth: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('ReimbursementClaim');

export const createClaimSchema = z
  .object({
    spentOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
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

export type ReimbursementClaimDto = z.infer<typeof reimbursementClaimSchema>;
export type CreateClaimInput = z.infer<typeof createClaimSchema>;
export type DecideClaimInput = z.infer<typeof decideClaimSchema>;
export type ReimbursementStatus = (typeof STATUSES)[number];
