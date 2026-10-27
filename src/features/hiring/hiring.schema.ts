import { z } from '../../shared/zod.js';

export const ROUNDS = ['hr', 'technical', 'practical', 'managerial', 'hr_final'] as const;
/** A line is approved by the HR department's head and the Admin account (any order). */
/** Who approves a hiring request: any HRBP-batch holder (TA workflow deck, 2026-10-27). */
export const APPROVER_ROLES = ['hrbp'] as const;
export const HIRING_PRIORITIES = ['high', 'normal', 'low'] as const;
export const REQUISITION_STATUSES = [
  'rejected',
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

/** Who reviews a position's JD / scorecard: the line's TA RM + the dept head (no Admin). */
export const DOC_ROLES = ['dept_head', 'ta_rm'] as const;
const docRoleSchema = z.enum(DOC_ROLES);
export const POSITION_STATUSES = [
  'awaiting_docs',
  'open',
  'interviewing',
  'offer',
  'filled',
  'cancelled',
] as const;

const bullets = (what: string) =>
  z
    .array(z.string().trim().min(1).max(500))
    .min(1, `Add at least one ${what}`)
    .max(40);

/**
 * The JD, as per the company template (Test Portal JD, learner 2026-10-27):
 * the recruiter fills the role-specific parts; the common company text
 * (About Elecbits, Why Join Us, office footer) is fixed and added by the
 * screen that renders it, never stored here.
 */
export const jdContentSchema = z
  .object({
    jobType: z.string().trim().min(1).max(60),
    city: z.string().trim().min(1).max(120),
    /** Cost to company as shown on the JD, e.g. "₹12–18 L per year" or "Negotiable". */
    ctc: z.string().trim().min(1).max(120),
    /** About the Business Unit — the department overview. */
    businessUnit: z.string().trim().min(1).max(4000),
    roleSummary: z.string().trim().min(1).max(4000),
    responsibilities: bullets('responsibility'),
    requiredSkills: bullets('required skill'),
    preferredSkills: z.array(z.string().trim().min(1).max(500)).max(40),
  })
  .strict()
  .openapi('JdContent');

/**
 * The scorecard, as per the company's Excel (learner, 2026-10-27): one sheet
 * per round with its WEIGHT (all rounds add up to 100); each round rates
 * ATTRIBUTES, each with the questions to ask. The interviewer scores every
 * attribute 1–4 with evidence; attributes of a round weigh the same, so the
 * round scores out of 100 and the weighted rounds give the total out of 100.
 */
export const scorecardContentSchema = z
  .object({
    rounds: z
      .array(
        z.object({
          round: roundSchema,
          weight: z.number().int().min(1).max(100),
          attributes: z
            .array(
              z.object({
                name: z.string().trim().min(1).max(200),
                questions: z.array(z.string().trim().min(1).max(1000)).max(20),
              }),
            )
            .min(1, 'Add at least one attribute to every round')
            .max(40),
        }),
      )
      .min(1)
      .max(5),
  })
  .strict()
  .refine((v) => new Set(v.rounds.map((r) => r.round)).size === v.rounds.length, {
    message: 'Each round appears once',
    path: ['rounds'],
  })
  .refine((v) => v.rounds.reduce((a, r) => a + r.weight, 0) === 100, {
    message: 'Round weights must add up to 100',
    path: ['rounds'],
  })
  .refine(
    (v) =>
      v.rounds.every(
        (r) => new Set(r.attributes.map((x) => x.name.toLowerCase())).size === r.attributes.length,
      ),
    { message: 'Attribute names must differ within a round', path: ['rounds'] },
  )
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

/** A channel the recruiter activated for a position (workflow deck step 6). */
export const sourceActivationSchema = z
  .object({
    id: z.string().uuid(),
    channel: z.string(),
    activatedOn: z.string(),
    spocName: z.string(),
    notes: z.string().nullable(),
  })
  .openapi('SourceActivation');

export const addSourceSchema = z
  .object({
    channel: z.enum([
      'naukri',
      'linkedin',
      'internshala',
      'careers_page',
      'agency',
      'campus',
      'social',
      'referral',
      'internal',
      'other',
    ]),
    activatedOn: z.string().date(),
    notes: z.string().trim().max(1000).optional(),
  })
  .strict()
  .openapi('AddSource');

export const positionSchema = z
  .object({
    id: z.string().uuid(),
    number: z.number().int(),
    status: z.enum(POSITION_STATUSES),
    /** TA ownership: priority (from the line) and the expected closure date. */
    priority: z.enum(HIRING_PRIORITIES),
    expectedCloseOn: z.string().nullable(),
    sources: z.array(sourceActivationSchema),
    recruiterId: z.string().uuid().nullable(),
    recruiterName: z.string().nullable(),
    /** The recruiter's goal this quarter (progress follows the position). */
    goal: z
      .object({ id: z.string().uuid(), weight: z.number(), progress: z.number().int() })
      .nullable(),
    openedAt: z.string().datetime().nullable(),
    /** Its own JD + scorecard, written by its recruiter (learner, 2026-10-27). */
    documents: z.object({
      jd: taDocumentSchema.nullable(),
      scorecard: taDocumentSchema.nullable(),
    }),
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

/** A report the TA RM can give a position to (holds the TA batch). */
export const recruiterOptionSchema = z
  .object({ id: z.string().uuid(), name: z.string(), employeeCode: z.string() })
  .openapi('RecruiterOption');

export const assignPositionSchema = z
  .object({
    recruiterId: z.string().uuid(),
    /** Weight of the hiring goal among the recruiter's goals. */
    weight: z.number().min(1).max(100),
    /** When TA expects to close it (workflow deck: TA ownership). */
    expectedCloseOn: z.string().date().optional(),
    priority: z.enum(HIRING_PRIORITIES).optional(),
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
    positionId: z.string().uuid(),
    positionNumber: z.number().int(),
    recruiterName: z.string().nullable(),
    document: taDocumentSchema,
  })
  .openapi('DocumentReview');

export type DocRole = z.infer<typeof docRoleSchema>;
export type TaDocumentDto = z.infer<typeof taDocumentSchema>;
export type PositionDto = z.infer<typeof positionSchema>;
export type AddSourceInput = z.infer<typeof addSourceSchema>;
export type DocumentReviewDto = z.infer<typeof documentReviewSchema>;
export type JdContent = z.infer<typeof jdContentSchema>;
export type ScorecardContent = z.infer<typeof scorecardContentSchema>;
export type AssignPositionInput = z.infer<typeof assignPositionSchema>;
export type AssignTaRmInput = z.infer<typeof assignTaRmSchema>;
export type TaRmOptionDto = z.infer<typeof taRmOptionSchema>;
export type RecruiterOptionDto = z.infer<typeof recruiterOptionSchema>;
export const requisitionSchema = z
  .object({
    id: z.string().uuid(),
    departmentId: z.string().uuid(),
    departmentName: z.string(),
    quarter: z.string().nullable(),
    roleTitle: z.string(),
    quantity: z.number().int(),
    notes: z.string().nullable(),
    /** Readable Hiring Request ID, e.g. HR-2027Q1-0007. */
    requestCode: z.string().nullable(),
    /** Request details (TA workflow deck); null only on lines made before 2026-10-27. */
    reason: z.string().nullable(),
    targetJoiningOn: z.string().nullable(),
    location: z.string().nullable(),
    reportingManager: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
    priority: z.enum(HIRING_PRIORITIES),
    employmentType: z.string().nullable(),
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
  )
  // Round 1 is always the TA SPOC's screening call — the gate (workflow deck, 2026-10-27).
  .refine((rs) => rs.some((r) => r.round === 'hr'), 'Round 1 (screening) is always included');

/** The request details every new line carries (TA workflow deck, 2026-10-27). */
const requestDetails = {
  /** Why this hire is needed (backfill, new project, growth…). */
  reason: z.string().trim().min(1).max(2000),
  targetJoiningOn: z.string().date(),
  location: z.string().trim().min(1).max(120),
  reportingManagerId: z.string().uuid(),
  priority: z.enum(HIRING_PRIORITIES),
  employmentType: z.string().trim().min(1).max(60),
};

export const createRequisitionSchema = z
  .object({
    departmentId: z.string().uuid(),
    quarter: quarterSchema,
    roleTitle: z.string().trim().min(1).max(120),
    quantity: z.number().int().min(1).max(50),
    notes: z.string().trim().max(4000).optional(),
    ...requestDetails,
    rounds: roundsInput,
  })
  .strict()
  .openapi('CreateRequisition');

export const updateRequisitionSchema = z
  .object({
    roleTitle: z.string().trim().min(1).max(120).optional(),
    quantity: z.number().int().min(1).max(50).optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
    reason: requestDetails.reason.optional(),
    targetJoiningOn: requestDetails.targetJoiningOn.optional(),
    location: requestDetails.location.optional(),
    reportingManagerId: requestDetails.reportingManagerId.optional(),
    priority: requestDetails.priority.optional(),
    employmentType: requestDetails.employmentType.optional(),
    rounds: roundsInput.optional(),
  })
  .strict()
  .openapi('UpdateRequisition');

export const decideRequisitionSchema = z
  .object({
    /** The version the approver looked at — a newer one means they haven't seen it. */
    version: z.number().int().min(1),
    /**
     * approve; reject = send back to fix and resubmit; decline = turn a hiring
     * request down for good (requests only — HRBP, 2026-10-27).
     */
    decision: z.enum(['approve', 'reject', 'decline']),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((v) => v.decision === 'approve' || (v.reason ?? '').length > 0, {
    message: 'Give a reason',
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
