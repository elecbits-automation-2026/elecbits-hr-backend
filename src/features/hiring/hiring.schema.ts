import { z } from '../../shared/zod.js';

export const ROUNDS = ['hr', 'technical', 'practical', 'managerial', 'hr_final'] as const;
/** A line is approved by the HR department's head and the Admin account (any order). */
export const APPROVER_ROLES = ['hr_head', 'admin'] as const;
export const REQUISITION_STATUSES = [
  'draft',
  'queued',
  'submitted',
  'returned',
  'approved',
  'cancelled',
] as const;

const roundSchema = z.enum(ROUNDS);
const approverRoleSchema = z.enum(APPROVER_ROLES);
const quarterSchema = z
  .string()
  .regex(/^\d{4}-Q[1-4]$/, 'Quarter must look like 2026-Q4');

/** What the caller can do in hiring: the departments they head, the approver roles they hold. */
export const hiringMeSchema = z
  .object({
    headOf: z.array(
      z.object({
        departmentId: z.string().uuid(),
        departmentName: z.string(),
        acting: z.boolean(),
      }),
    ),
    approverRoles: z.array(approverRoleSchema),
    /** The quarter heads plan for now, and the day its lines go for approval. */
    planQuarter: z.string(),
    planDeadline: z.string(),
  })
  .openapi('HiringMe');

// ── Step C: positions, JD + scorecard ───────────────────────────────────

export const DOC_ROLES = ['dept_head', 'admin'] as const;
const docRoleSchema = z.enum(DOC_ROLES);
export const POSITION_STATUSES = [
  'awaiting_docs',
  'open',
  'interviewing',
  'offer',
  'filled',
  'cancelled',
] as const;

/** The JD: TA writes it from a template plus the head's request. */
export const jdContentSchema = z
  .object({
    summary: z.string().trim().min(1).max(4000),
    responsibilities: z.string().trim().min(1).max(8000),
    requirements: z.string().trim().min(1).max(8000),
    location: z.string().trim().min(1).max(200),
    employmentType: z.string().trim().min(1).max(60),
    ctcRange: z.string().trim().max(120).nullable().optional(),
  })
  .strict()
  .openapi('JdContent');

/** The scorecard: what each round rates, each criterion scored 1–5 by its interviewer. */
export const scorecardContentSchema = z
  .object({
    criteria: z
      .array(
        z.object({
          round: roundSchema,
          criterion: z.string().trim().min(1).max(200),
          guidance: z.string().trim().max(1000).nullable().optional(),
        }),
      )
      .min(1, 'Add at least one criterion')
      .max(60),
  })
  .strict()
  .openapi('ScorecardContent');

export const taDocumentSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['jd', 'scorecard']),
    version: z.number().int(),
    status: z.enum(['draft', 'in_review', 'returned', 'approved']),
    content: z.record(z.string(), z.unknown()),
    writtenByName: z.string(),
    returnReason: z.string().nullable(),
    /** Decisions on the current version only. */
    approvals: z.array(
      z.object({
        role: docRoleSchema,
        decision: z.enum(['approve', 'reject']),
        decidedByName: z.string(),
        reason: z.string().nullable(),
        decidedAt: z.string().datetime(),
      }),
    ),
    waitingOn: z.array(docRoleSchema),
    submittedAt: z.string().datetime().nullable(),
    approvedAt: z.string().datetime().nullable(),
  })
  .openapi('TaDocument');

export const positionSchema = z
  .object({
    id: z.string().uuid(),
    number: z.number().int(),
    status: z.enum(POSITION_STATUSES),
    recruiterId: z.string().uuid().nullable(),
    recruiterName: z.string().nullable(),
    /** The recruiter's goal this quarter (progress follows the position). */
    goal: z
      .object({ id: z.string().uuid(), weight: z.number(), progress: z.number().int() })
      .nullable(),
    openedAt: z.string().datetime().nullable(),
  })
  .openapi('Position');

export const saveJdSchema = z
  .object({ content: jdContentSchema })
  .strict()
  .openapi('SaveJd');
export const saveScorecardSchema = z
  .object({ content: scorecardContentSchema })
  .strict()
  .openapi('SaveScorecard');

/** Admin gives an approved line to a TA RM. */
export const assignTaRmSchema = z
  .object({ taRmId: z.string().uuid() })
  .strict()
  .openapi('AssignTaRm');

/** Someone Admin can give a line to: holds the TA batch and has direct reports. */
export const taRmOptionSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    employeeCode: z.string(),
    reports: z.number().int(),
  })
  .openapi('TaRmOption');

export const assignPositionSchema = z
  .object({
    recruiterId: z.string().uuid(),
    /** Weight of the hiring goal among the recruiter's goals. */
    weight: z.number().min(1).max(100),
  })
  .strict()
  .openapi('AssignPosition');

/** A JD or scorecard waiting for my review, with its line for context. */
export const documentReviewSchema = z
  .object({
    requisitionId: z.string().uuid(),
    departmentName: z.string(),
    roleTitle: z.string(),
    quantity: z.number().int(),
    document: taDocumentSchema,
  })
  .openapi('DocumentReview');

export type DocRole = z.infer<typeof docRoleSchema>;
export type TaDocumentDto = z.infer<typeof taDocumentSchema>;
export type PositionDto = z.infer<typeof positionSchema>;
export type DocumentReviewDto = z.infer<typeof documentReviewSchema>;
export type JdContent = z.infer<typeof jdContentSchema>;
export type ScorecardContent = z.infer<typeof scorecardContentSchema>;
export type AssignPositionInput = z.infer<typeof assignPositionSchema>;
export type AssignTaRmInput = z.infer<typeof assignTaRmSchema>;
export type TaRmOptionDto = z.infer<typeof taRmOptionSchema>;
export const requisitionSchema = z
  .object({
    id: z.string().uuid(),
    departmentId: z.string().uuid(),
    departmentName: z.string(),
    quarter: z.string().nullable(),
    roleTitle: z.string(),
    quantity: z.number().int(),
    notes: z.string().nullable(),
    /** Budget per hire (annual CTC, ₹); null only on lines made before budgets. */
    budgetMin: z.number().nullable(),
    budgetMax: z.number().nullable(),
    version: z.number().int(),
    status: z.enum(REQUISITION_STATUSES),
    urgent: z.boolean(),
    rounds: z.array(
      z.object({
        round: roundSchema,
        interviewerId: z.string().uuid().nullable(),
        interviewerName: z.string().nullable(),
      }),
    ),
    /** Decisions on the CURRENT version only; older versions are history. */
    approvals: z.array(
      z.object({
        role: approverRoleSchema,
        decision: z.enum(['approve', 'reject']),
        decidedByName: z.string(),
        reason: z.string().nullable(),
        decidedAt: z.string().datetime(),
      }),
    ),
    /** Roles that still have to decide (submitted lines only). */
    waitingOn: z.array(approverRoleSchema),
    returnReason: z.string().nullable(),
    createdByName: z.string(),
    submittedAt: z.string().datetime().nullable(),
    approvedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    /** The TA RM Admin gave the line to — they assign its positions to their team. */
    taRm: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
    taRmAssignedAt: z.string().datetime().nullable(),
    /** Step C — present once the line is approved. */
    positions: z.array(positionSchema),
    documents: z.object({
      jd: taDocumentSchema.nullable(),
      scorecard: taDocumentSchema.nullable(),
    }),
  })
  .openapi('Requisition');

export const hiringPlanSchema = z
  .object({
    departmentId: z.string().uuid(),
    quarter: z.string(),
    /** Submitted lines wait until this day, then go to the approvers together. */
    deadline: z.string(),
    /** True for the quarter being planned now — the only one that takes new lines. */
    open: z.boolean(),
    requisitions: z.array(requisitionSchema),
  })
  .openapi('HiringPlan');

const roundsInput = z
  .array(z.object({ round: roundSchema, interviewerId: z.string().uuid().nullable() }))
  .min(1, 'Pick at least one interview round')
  .refine(
    (rs) => new Set(rs.map((r) => r.round)).size === rs.length,
    'A round is listed twice',
  );

/** Annual CTC in ₹ for ONE hire (the head's budget). */
const budgetAmount = z.number().positive().max(9_999_999_999);

export const createRequisitionSchema = z
  .object({
    departmentId: z.string().uuid(),
    quarter: quarterSchema,
    roleTitle: z.string().trim().min(1).max(120),
    quantity: z.number().int().min(1).max(50),
    notes: z.string().trim().max(4000).optional(),
    /** Budget per hire: annual CTC range in ₹. */
    budgetMin: budgetAmount,
    budgetMax: budgetAmount,
    rounds: roundsInput,
  })
  .strict()
  .refine((v) => v.budgetMax >= v.budgetMin, {
    message: 'The budget maximum must be at least the minimum',
    path: ['budgetMax'],
  })
  .openapi('CreateRequisition');

export const updateRequisitionSchema = z
  .object({
    roleTitle: z.string().trim().min(1).max(120).optional(),
    quantity: z.number().int().min(1).max(50).optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    budgetMin: budgetAmount.optional(),
    budgetMax: budgetAmount.optional(),
    rounds: roundsInput.optional(),
  })
  .strict()
  .openapi('UpdateRequisition');

export const decideRequisitionSchema = z
  .object({
    /** The version the approver looked at — a newer one means they haven't seen it. */
    version: z.number().int().min(1),
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((v) => v.decision === 'approve' || (v.reason ?? '').length > 0, {
    message: 'A rejection needs a reason',
    path: ['reason'],
  })
  .openapi('DecideRequisition');

export type ApproverRole = z.infer<typeof approverRoleSchema>;
export type InterviewRound = z.infer<typeof roundSchema>;
export type HiringMeDto = z.infer<typeof hiringMeSchema>;
export type RequisitionDto = z.infer<typeof requisitionSchema>;
export type HiringPlanDto = z.infer<typeof hiringPlanSchema>;
export type CreateRequisitionInput = z.infer<typeof createRequisitionSchema>;
export type UpdateRequisitionInput = z.infer<typeof updateRequisitionSchema>;
export type DecideRequisitionInput = z.infer<typeof decideRequisitionSchema>;
