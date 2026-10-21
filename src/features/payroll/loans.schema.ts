import { z } from '../../shared/zod.js';

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM');

export const loanSchema = z
  .object({
    id: z.string().uuid(),
    employee: z.object({
      id: z.string().uuid(),
      name: z.string(),
      employeeCode: z.string(),
    }),
    kind: z.enum(['loan', 'advance']),
    principal: z.number(),
    interestRatePct: z.number(),
    months: z.number().int(),
    startMonth: z.string(),
    emi: z.number(),
    status: z.enum(['active', 'closed', 'recovered_at_exit']),
    note: z.string().nullable(),
    repaidPrincipal: z.number(),
    repaidInterest: z.number(),
    balance: z.number(),
    instalments: z.number().int(),
    createdAt: z.string().datetime(),
  })
  .openapi('Loan');

export const loanDetailSchema = loanSchema
  .extend({
    repayments: z.array(
      z.object({
        month: z.string().nullable(),
        kind: z.enum(['emi', 'fnf', 'outside']),
        amount: z.number(),
        principal: z.number(),
        interest: z.number(),
        at: z.string().datetime(),
      }),
    ),
    schedule: z.array(
      z.object({
        month: z.string(),
        amount: z.number(),
        interest: z.number(),
        principal: z.number(),
        balance: z.number(),
      }),
    ),
  })
  .openapi('LoanDetail');

/** Payroll records a loan or a salary advance (an advance is one month). */
export const createLoanSchema = z
  .object({
    employeeId: z.string().uuid(),
    kind: z.enum(['loan', 'advance']),
    principal: z.number().positive().max(100_000_000),
    interestRatePct: z.number().min(0).max(50),
    months: z.number().int().min(1).max(120),
    startMonth: month,
    note: z.string().trim().max(1000).optional(),
  })
  .strict()
  .openapi('CreateLoan');

/** Change the rate or the months left — the EMI is worked out again. */
export const updateLoanSchema = z
  .object({
    interestRatePct: z.number().min(0).max(50).optional(),
    monthsLeft: z.number().int().min(1).max(120).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict()
  .openapi('UpdateLoan');

export const closeLoanSchema = z
  .object({ note: z.string().trim().min(3).max(500) })
  .strict()
  .openapi('CloseLoan');

export type LoanDto = z.infer<typeof loanSchema>;
export type LoanDetailDto = z.infer<typeof loanDetailSchema>;
export type CreateLoanInput = z.infer<typeof createLoanSchema>;
export type UpdateLoanInput = z.infer<typeof updateLoanSchema>;
export type CloseLoanInput = z.infer<typeof closeLoanSchema>;
