import { z } from '../../shared/zod.js';
import { ROUNDS } from './hiring.schema.js';

export const CANDIDATE_SOURCES = [
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
] as const;
export const APPLICATION_STAGES = [
  'sourced',
  'shortlisted',
  'interviewing',
  'interviewed',
  'decision',
  'selected',
  'offered',
  'hired',
  'offer_declined',
  'offer_withdrawn',
  'no_show',
  'rejected',
  'withdrawn',
] as const;

/** Who gives the final hire decision: dept head, the line's TA RM, HR head and Admin. */
export const HIRE_ROLES = ['dept_head', 'ta_rm', 'hr_head', 'admin'] as const;
export const BGV_STATUSES = ['not_started', 'in_progress', 'clear', 'failed'] as const;

const roundSchema = z.enum(ROUNDS);
const stageSchema = z.enum(APPLICATION_STAGES);
const recommendationSchema = z.enum(['hire', 'no_hire']);

/** One round's scores as everyone allowed to see them sees them. */
export const roundScoreSchema = z
  .object({
    round: roundSchema,
    interviewerName: z.string(),
    scores: z.array(z.object({ criterion: z.string(), score: z.number().int() })),
    average: z.number(),
    recommendation: recommendationSchema,
    notes: z.string().nullable(),
    submittedAt: z.string().datetime(),
  })
  .openapi('RoundScore');

/** A round of an application: who conducts it and whether it's scored. */
export const applicationRoundSchema = z.object({
  round: roundSchema,
  interviewerId: z.string().uuid().nullable(),
  interviewerName: z.string().nullable(),
  score: roundScoreSchema.nullable(),
});

export const applicationSchema = z
  .object({
    id: z.string().uuid(),
    candidateId: z.string().uuid(),
    candidateName: z.string(),
    positionId: z.string().uuid(),
    positionNumber: z.number().int(),
    requisitionId: z.string().uuid(),
    /** The line's TA RM — validates the shortlist and decides the hire. */
    taRmId: z.string().uuid().nullable(),
    roleTitle: z.string(),
    departmentName: z.string(),
    stage: stageSchema,
    shortlistedByName: z.string().nullable(),
    outcomeReason: z.string().nullable(),
    rounds: z.array(applicationRoundSchema),
    createdAt: z.string().datetime(),
    // ── Step E ──
    /** The final hire decision: who approved, who is still to decide. */
    decision: z.object({
      approvals: z.array(
        z.object({
          role: z.enum(HIRE_ROLES),
          decision: z.enum(['approve', 'reject']),
          decidedByName: z.string(),
          reason: z.string().nullable(),
        }),
      ),
      waitingOn: z.array(z.enum(HIRE_ROLES)),
    }),
    /** The offer waits for the line's approval (always true once positions exist). */
    lineApproved: z.boolean(),
    offeredCtc: z.number().nullable(),
    /** The line's budget per hire — an offer above the max is flagged, not blocked. */
    budgetMin: z.number().nullable(),
    budgetMax: z.number().nullable(),
    joiningDate: z.string().nullable(),
    hasOfferLetter: z.boolean(),
    bgvStatus: z.enum(BGV_STATUSES),
    bgvNotes: z.string().nullable(),
    employeeId: z.string().uuid().nullable(),
  })
  .openapi('Application');

export const candidateSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    source: z.enum(CANDIDATE_SOURCES),
    referredByName: z.string().nullable(),
    notes: z.string().nullable(),
    hasCv: z.boolean(),
    retainUntil: z.string(),
    anonymised: z.boolean(),
    createdAt: z.string().datetime(),
    applications: z.array(applicationSchema),
  })
  .openapi('Candidate');

/** A possible duplicate, found by email or phone before adding. */
export const candidateMatchSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
  })
  .openapi('CandidateMatch');

const phoneSchema = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number');

export const createCandidateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(200).optional(),
    phone: phoneSchema.optional(),
    source: z.enum(CANDIDATE_SOURCES),
    referredById: z.string().uuid().optional(),
    notes: z.string().trim().max(4000).optional(),
    /** The candidate agreed to be kept in the talent pool (6 months). */
    consent: z.literal(true, { message: 'Consent is required to keep the candidate' }),
  })
  .strict()
  .refine((v) => v.email || v.phone, {
    message: 'Give an email or a phone number',
    path: ['email'],
  })
  .refine((v) => v.source !== 'referral' || v.referredById, {
    message: 'Pick who referred them',
    path: ['referredById'],
  })
  .openapi('CreateCandidate');

export const addApplicationSchema = z
  .object({ candidateId: z.string().uuid() })
  .strict()
  .openapi('AddApplication');

export const endApplicationSchema = z
  .object({ reason: z.string().trim().min(1).max(2000) })
  .strict()
  .openapi('EndApplication');

export const submitScoreSchema = z
  .object({
    scores: z
      .array(
        z.object({
          criterion: z.string().trim().min(1),
          score: z.number().int().min(1).max(5),
        }),
      )
      .min(1),
    recommendation: recommendationSchema,
    notes: z.string().trim().max(4000).optional(),
  })
  .strict()
  .openapi('SubmitScore');

export const swapInterviewerSchema = z
  .object({ interviewerId: z.string().uuid() })
  .strict()
  .openapi('SwapInterviewer');

/** What an interviewer sees for one round — nothing about other rounds. */
export const myInterviewSchema = z
  .object({
    applicationId: z.string().uuid(),
    candidateId: z.string().uuid(),
    candidateName: z.string(),
    hasCv: z.boolean(),
    roleTitle: z.string(),
    departmentName: z.string(),
    round: roundSchema,
    criteria: z.array(
      z.object({ criterion: z.string(), guidance: z.string().nullable() }),
    ),
    jdSummary: z.string().nullable(),
    myScore: roundScoreSchema.nullable(),
  })
  .openapi('MyInterview');

export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];
export type CandidateDto = z.infer<typeof candidateSchema>;
export type ApplicationDto = z.infer<typeof applicationSchema>;
export type RoundScoreDto = z.infer<typeof roundScoreSchema>;
export type CandidateMatchDto = z.infer<typeof candidateMatchSchema>;
export type MyInterviewDto = z.infer<typeof myInterviewSchema>;
export type CreateCandidateInput = z.infer<typeof createCandidateSchema>;
export type SubmitScoreInput = z.infer<typeof submitScoreSchema>;
