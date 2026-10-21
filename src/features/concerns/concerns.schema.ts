import { z } from '../../shared/zod.js';

/** Dispute Resolution Framework §4 — what a dispute may contest. */
export const DISPUTE_AREAS = [
  'appraisal',
  'pip',
  'reimbursement',
  'probation',
  'discipline',
  'referral',
  'policy_application',
  'other',
] as const;

/** Equal Opportunity §J + anti-bullying — conduct complaints (NOT sexual harassment). */
export const COMPLAINT_CATEGORIES = [
  'discrimination',
  'harassment',
  'bullying',
  'retaliation',
  'accommodation',
  'other',
] as const;

/** Whistleblower policy §4.2 / §5 — reportable concerns. */
export const WHISTLEBLOWER_CATEGORIES = [
  'fraud',
  'corruption',
  'violation_of_law',
  'code_of_conduct',
  'misuse_of_assets',
  'audit_controls',
  'health_safety',
  'retaliation',
  'other',
] as const;

/** Never stored: the Internal Committee handles it under the POSH policy. */
export const POSH_CATEGORY = 'sexual_harassment';

const TRACK = z.enum(['dispute', 'complaint', 'whistleblower']);
const STATUS = z.enum([
  'open',
  'acknowledged',
  'investigating',
  'decided',
  'resolved',
  'closed',
  'declined',
]);
const OUTCOME = z.enum([
  'substantiated',
  'partially',
  'not_substantiated',
  'withdrawn',
  'malicious',
]);

export const createConcernSchema = z
  .object({
    track: TRACK,
    category: z.string().trim().min(2).max(40),
    title: z.string().trim().min(5).max(200),
    detail: z.string().trim().min(20).max(5000),
    subjectEmployeeId: z.string().uuid().optional(),
    /** A retaliation report or follow-on case: the earlier case's code. */
    relatedCode: z.string().trim().max(30).optional(),
    /** Complaints and whistleblower reports only. */
    anonymous: z.boolean().optional(),
    /** Disputes: the decision was the manager's own — start at HR (level 2). */
    aboutMyManager: z.boolean().optional(),
  })
  .strict()
  .openapi('CreateConcern');

export const noteSchema = z
  .object({
    body: z.string().trim().min(2).max(5000),
    /** Handlers: true = a reply the raiser sees; false = an internal note. */
    visibleToRaiser: z.boolean().optional(),
  })
  .strict()
  .openapi('ConcernNoteInput');

export const decideSchema = z
  .object({ decision: z.string().trim().min(10).max(5000) })
  .strict()
  .openapi('DecideDispute');

export const escalateSchema = z
  .object({ reason: z.string().trim().min(10).max(2000) })
  .strict()
  .openapi('EscalateDispute');

export const resolveSchema = z
  .object({ outcome: OUTCOME, resolution: z.string().trim().min(10).max(5000) })
  .strict()
  .openapi('ResolveConcern');

export const extendSchema = z
  .object({
    to: z.string().date(),
    reason: z.string().trim().min(10).max(2000),
  })
  .strict()
  .openapi('ExtendConcern');

export const declineSchema = z
  .object({
    relatedCode: z.string().trim().max(30).optional(),
    reason: z.string().trim().min(10).max(2000),
  })
  .strict()
  .openapi('DeclineConcern');

export const followUpSchema = z
  .object({
    code: z.string().trim().min(5).max(30),
    key: z.string().trim().min(10).max(200),
  })
  .strict()
  .openapi('ConcernFollowUp');

export const followUpNoteSchema = followUpSchema
  .extend({ body: z.string().trim().min(2).max(5000) })
  .openapi('ConcernFollowUpNote');

export const concernNoteSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(['note', 'reply', 'decision', 'system']),
    level: z.number().int().nullable(),
    body: z.string(),
    /** Null for the anonymous raiser. */
    authorName: z.string().nullable(),
    fromRaiser: z.boolean(),
    visibleToRaiser: z.boolean(),
    createdAt: z.string().datetime(),
  })
  .openapi('ConcernNote');

export const concernSchema = z
  .object({
    id: z.string().uuid(),
    code: z.string(),
    track: TRACK,
    category: z.string(),
    title: z.string(),
    detail: z.string(),
    status: STATUS,
    level: z.number().int().nullable(),
    anonymous: z.boolean(),
    /** Hidden from the raiser's own view only when anonymous. */
    raisedBy: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
    subject: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
    relatedCode: z.string().nullable(),
    dueAckOn: z.string().nullable(),
    dueResolveOn: z.string().nullable(),
    extendedTo: z.string().nullable(),
    escalateBy: z.string().nullable(),
    ackAt: z.string().datetime().nullable(),
    outcome: OUTCOME.nullable(),
    resolution: z.string().nullable(),
    closedAt: z.string().datetime().nullable(),
    createdAt: z.string().datetime(),
    /** What the caller may do next. */
    can: z.object({
      acknowledge: z.boolean(),
      decide: z.boolean(),
      resolve: z.boolean(),
      extend: z.boolean(),
      decline: z.boolean(),
      accept: z.boolean(),
      escalate: z.boolean(),
      note: z.boolean(),
    }),
    notes: z.array(concernNoteSchema),
  })
  .openapi('Concern');

export const createdConcernSchema = z
  .object({
    concern: concernSchema,
    /** Anonymous reports only — shown ONCE; only its hash is stored. */
    followUpKey: z.string().nullable(),
  })
  .openapi('CreatedConcern');

export const queueSummarySchema = z
  .object({
    queue: z.enum(['manager', 'hr', 'mrc', 'vigil']),
    label: z.string(),
    open: z.number().int(),
    overdue: z.number().int(),
  })
  .openapi('ConcernQueue');

export const concernPersonSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    employeeCode: z.string(),
    designation: z.string().nullable(),
  })
  .openapi('ConcernPerson');

export type CreateConcernInput = z.infer<typeof createConcernSchema>;
export type NoteInput = z.infer<typeof noteSchema>;
export type DecideInput = z.infer<typeof decideSchema>;
export type EscalateInput = z.infer<typeof escalateSchema>;
export type ResolveInput = z.infer<typeof resolveSchema>;
export type ExtendInput = z.infer<typeof extendSchema>;
export type DeclineInput = z.infer<typeof declineSchema>;
export type FollowUpInput = z.infer<typeof followUpSchema>;
export type FollowUpNoteInput = z.infer<typeof followUpNoteSchema>;
export type ConcernDto = z.infer<typeof concernSchema>;
export type ConcernNoteDto = z.infer<typeof concernNoteSchema>;
export type QueueSummaryDto = z.infer<typeof queueSummarySchema>;
export type QueueName = QueueSummaryDto['queue'];
