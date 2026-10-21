import { z } from '../../shared/zod.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const ref = z.object({ id: z.string().uuid(), name: z.string() });

export const EXIT_STATUSES = [
  'submitted',
  'accepted',
  'relieved',
  'settled',
  'withdrawn',
  'cancelled',
] as const;
export const CLEARANCE_KINDS = ['hr', 'manager', 'ops', 'payroll'] as const;
export type ClearanceKind = (typeof CLEARANCE_KINDS)[number];

/** The exit interview the leaver fills on their last day (HR sees it, the manager doesn't). */
export const INTERVIEW_REASONS = [
  'Better role or pay elsewhere',
  'Career change',
  'Higher studies',
  'Relocation',
  'Personal or family reasons',
  'Manager or team',
  'Work-life balance',
  'Other',
] as const;

export const interviewSchema = z
  .object({
    reason: z.enum(INTERVIEW_REASONS),
    liked: z.string().trim().max(2000),
    improve: z.string().trim().max(2000),
    managerRating: z.number().int().min(1).max(5),
    roleRating: z.number().int().min(1).max(5),
    recommend: z.boolean(),
    wouldReturn: z.boolean(),
    newWorkplace: z.string().trim().max(200).optional(),
    other: z.string().trim().max(2000).optional(),
  })
  .strict()
  .openapi('ExitInterview');

export const clearanceSchema = z.object({
  kind: z.enum(CLEARANCE_KINDS),
  clearedBy: ref.nullable(),
  clearedAt: z.string().datetime().nullable(),
  note: z.string().nullable(),
  // When it may be cleared (HR from the resignation date, manager during
  // notice, OPS on the last day, payroll with the F&F run).
  opensOn: isoDate.nullable(),
});

/** What the full & final will carry, worked out live (payroll and HR only). */
export const fnfPreviewSchema = z
  .object({
    encashedElDays: z.number(),
    leaveEncashment: z.number(),
    gratuityYears: z.number().int(),
    gratuity: z.number(),
    noticePay: z.number(),
    noticeRecovery: z.number(),
    sickLopDays: z.number(),
    sickLopDeduction: z.number(),
    fnfRecovery: z.number(),
    loanBalance: z.number(),
    recoveries: z.array(
      z.object({
        id: z.string().uuid(),
        label: z.string(),
        amount: z.number(),
        note: z.string().nullable(),
      }),
    ),
    // null = no CTC on record, nothing can be worked out.
    hasSalary: z.boolean(),
  })
  .openapi('FnfPreview');

export const exitSchema = z
  .object({
    id: z.string().uuid(),
    employee: z.object({
      id: z.string().uuid(),
      name: z.string(),
      employeeCode: z.string(),
      designation: z.string().nullable(),
      department: z.string().nullable(),
      dateOfJoining: z.string().nullable(),
    }),
    rm: ref.nullable(),
    kind: z.enum(['resignation', 'termination']),
    status: z.enum(EXIT_STATUSES),
    reason: z.string(),
    initiatedBy: ref,
    noticeStartOn: isoDate,
    noticeDays: z.number().int(),
    proposedLastDay: isoDate,
    lastWorkingDay: isoDate,
    servedDays: z.number().int(),
    shortfallDays: z.number().int(),
    shortfallAction: z.enum(['waive', 'recover']).nullable(),
    shortfallReason: z.string().nullable(),
    terminationMode: z.enum(['serve', 'pay_in_lieu']).nullable(),
    handoverPlan: z.string().nullable(),
    acknowledgedBy: ref.nullable(),
    acknowledgedAt: z.string().datetime().nullable(),
    acceptedBy: ref.nullable(),
    acceptedAt: z.string().datetime().nullable(),
    closedBy: ref.nullable(),
    closedAt: z.string().datetime().nullable(),
    closeReason: z.string().nullable(),
    relievedAt: z.string().datetime().nullable(),
    settledAt: z.string().datetime().nullable(),
    clearances: z.array(clearanceSchema),
    // HR and the leaver only.
    interview: interviewSchema.nullable(),
    interviewAt: z.string().datetime().nullable(),
    // OPS / HR: what they still hold (assets, loans, gate-pass items).
    holdings: z
      .object({
        assets: z.array(
          z.object({
            id: z.string(),
            assetCode: z.string(),
            name: z.string(),
            loanDueOn: z.string().nullable(),
          }),
        ),
        passes: z.array(
          z.object({
            id: z.string(),
            assetCode: z.string(),
            name: z.string(),
            returnOn: z.string(),
          }),
        ),
      })
      .nullable(),
    // Payroll / HR.
    fnf: fnfPreviewSchema.nullable(),
    // What the caller may do now (the server still checks every action).
    can: z.object({
      withdraw: z.boolean(),
      acknowledge: z.boolean(),
      accept: z.boolean(),
      cancel: z.boolean(),
      clear: z.array(z.enum(CLEARANCE_KINDS)),
      interview: z.boolean(),
      recoveries: z.boolean(),
      documents: z.boolean(),
    }),
    createdAt: z.string().datetime(),
  })
  .openapi('Exit');

/** The leaver's own view of the resignation page. */
export const myExitPageSchema = z
  .object({
    exit: exitSchema.nullable(),
    noticeDays: z.number().int(),
    defaultLastDay: isoDate,
    interviewReasons: z.array(z.string()),
  })
  .openapi('MyExitPage');

export const resignSchema = z
  .object({
    reason: z.string().trim().min(10).max(3000),
    // Defaults to today + their notice days.
    lastWorkingDay: isoDate.optional(),
  })
  .strict()
  .openapi('Resign');

export const terminateSchema = z
  .object({
    employeeId: z.string().uuid(),
    reason: z.string().trim().min(10).max(3000),
    mode: z.enum(['serve', 'pay_in_lieu']),
    lastWorkingDay: isoDate,
  })
  .strict()
  .openapi('Terminate');

export const acknowledgeSchema = z
  .object({ handoverPlan: z.string().trim().min(10).max(5000) })
  .strict()
  .openapi('AcknowledgeExit');

export const acceptSchema = z
  .object({
    lastWorkingDay: isoDate,
    // Required when the notice is short.
    shortfallAction: z.enum(['waive', 'recover']).optional(),
    shortfallReason: z.string().trim().max(1000).optional(),
  })
  .strict()
  .openapi('AcceptExit');

export const cancelExitSchema = z
  .object({ reason: z.string().trim().min(3).max(1000) })
  .strict()
  .openapi('CancelExit');

export const clearSchema = z
  .object({
    kind: z.enum(['hr', 'manager', 'ops']),
    note: z.string().trim().max(1000).optional(),
  })
  .strict()
  .openapi('ClearExit');

export type ExitDto = z.infer<typeof exitSchema>;
export type MyExitPageDto = z.infer<typeof myExitPageSchema>;
export type FnfPreviewDto = z.infer<typeof fnfPreviewSchema>;
export type InterviewInput = z.infer<typeof interviewSchema>;
export type ResignInput = z.infer<typeof resignSchema>;
export type TerminateInput = z.infer<typeof terminateSchema>;
export type AcknowledgeInput = z.infer<typeof acknowledgeSchema>;
export type AcceptInput = z.infer<typeof acceptSchema>;
export type CancelExitInput = z.infer<typeof cancelExitSchema>;
export type ClearInput = z.infer<typeof clearSchema>;
