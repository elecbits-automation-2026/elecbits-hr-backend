import { LEAVE_TYPES, LEAVE_TYPE_VALUES } from '../../shared/constants/constants.js';
import { z } from '../../shared/zod.js';

const DAY_PARTS = ['full', 'first_half', 'second_half'] as const;
const STATUSES = [
  'pending',
  'partially_approved',
  'approved',
  'declined',
  'cancelled',
] as const;

/**
 * Raise a leave (employee, D-self). Dates are YYYY-MM-DD. The rules a schema
 * can own live here: end after start, half days are a single date, and one
 * request stays inside one calendar year (balances are yearly — a New-Year
 * spanning leave is raised as two requests).
 */
export const createLeaveRequestSchema = z
  .object({
    type: z.enum(LEAVE_TYPES),
    startDate: z.string().date(),
    endDate: z.string().date(),
    dayPart: z.enum(DAY_PARTS).default('full'),
    reason: z.string().max(1000).optional(),
  })
  .strict()
  .refine((v) => v.endDate >= v.startDate, {
    message: 'endDate must not be before startDate',
    path: ['endDate'],
  })
  .refine((v) => v.dayPart === 'full' || v.startDate === v.endDate, {
    message: 'A half day is a single date',
    path: ['dayPart'],
  })
  .refine((v) => v.startDate.slice(0, 4) === v.endDate.slice(0, 4), {
    message: 'A request must stay within one calendar year — raise two',
    path: ['endDate'],
  })
  .openapi('CreateLeaveRequest');

/** Approve or decline — the service works out which slot(s) the caller fills. */
export const decideLeaveSchema = z
  .object({
    decision: z.enum(['approve', 'decline']),
    reason: z.string().max(1000).optional(),
  })
  .strict()
  // A decline ends the request for good (either slot can kill it), so the
  // decision must carry a reason (user decision).
  .refine((v) => v.decision !== 'decline' || Boolean(v.reason?.trim()), {
    message: 'A reason is required to decline',
    path: ['reason'],
  })
  .openapi('DecideLeave');

/** A leave request as every surface sees it (owner, RM queue, HR queue). */
export const leaveRequestSchema = z
  .object({
    id: z.string().uuid(),
    employee: z.object({
      id: z.string().uuid(),
      name: z.string(),
      employeeCode: z.string(),
    }),
    // Stored rows may carry retired types (casual) — history stays readable.
    type: z.enum(LEAVE_TYPE_VALUES),
    startDate: z.string(),
    endDate: z.string(),
    dayPart: z.enum(DAY_PARTS),
    days: z.number(),
    reason: z.string().nullable(),
    status: z.enum(STATUSES),
    rmRequired: z.boolean(),
    hrRequired: z.boolean(),
    rmApprovedBy: z.string().uuid().nullable(),
    rmApprovedAt: z.string().nullable(),
    hrApprovedBy: z.string().uuid().nullable(),
    hrApprovedAt: z.string().nullable(),
    // Display names for the filled slots — queues show WHO approved, not a tick.
    rmApprovedByName: z.string().nullable(),
    hrApprovedByName: z.string().nullable(),
    decidedBy: z.string().uuid().nullable(),
    decisionReason: z.string().nullable(),
    // Exit module: 3+ sick days during notice need a medical certificate,
    // or they are LOP in the F&F.
    certificateNeeded: z.boolean(),
    certificate: z
      .object({ fileName: z.string(), uploadedAt: z.string().datetime() })
      .nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('LeaveRequest');

/**
 * One row per type; `allocated`/`remaining` are null for uncapped (unpaid).
 * `allocated` is the year's ACCRUED-TO-DATE grant for earned/menstrual;
 * `opening` is carry-forward (earned only) — remaining already applies the
 * 30-day effective cap, so lapsed days never show as spendable.
 */
export const leaveBalanceSchema = z
  .object({
    type: z.enum(LEAVE_TYPES),
    year: z.number().int(),
    allocated: z.number().nullable(),
    opening: z.number(),
    used: z.number(),
    remaining: z.number().nullable(),
  })
  .openapi('LeaveBalance');

export type CreateLeaveRequestInput = z.infer<typeof createLeaveRequestSchema>;
export type DecideLeaveInput = z.infer<typeof decideLeaveSchema>;
export type LeaveRequestDto = z.infer<typeof leaveRequestSchema>;
export type LeaveBalanceDto = z.infer<typeof leaveBalanceSchema>;
