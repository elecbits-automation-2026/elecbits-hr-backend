import { z } from '../../shared/zod.js';
import { ROUNDS, requisitionSchema } from './hiring.schema.js';

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


const roundSchema = z.enum(ROUNDS);
const stageSchema = z.enum(APPLICATION_STAGES);
const recommendationSchema = z.enum(['hire', 'no_hire']);

export const INTERVIEW_MODES = ['in_person', 'video', 'phone'] as const;

/** When and how a round happens (learner, 2026-10-27). */
export const interviewSlotSchema = z
  .object({
    id: z.string().uuid(),
    startsAt: z.string().datetime(),
    durationMin: z.number().int(),
    mode: z.enum(INTERVIEW_MODES),
    /** Room / address, meeting link, or phone number. */
    location: z.string().nullable(),
    status: z.enum(['scheduled', 'done', 'cancelled', 'no_show']),
    endReason: z.string().nullable(),
  })
  .openapi('InterviewSlot');

/** One round's scores as everyone allowed to see them sees them. */
export const roundScoreSchema = z
  .object({
    round: roundSchema,
    interviewerName: z.string(),
    /** Per attribute: 1–4 and the evidence written for it. */
    scores: z.array(
      z.object({
        attribute: z.string(),
        score: z.number().int(),
        evidence: z.string().nullable(),
      }),
    ),
    /** The round out of 100: each attribute weighs the same, score/4 of its share. */
    roundScore: z.number(),
    recommendation: recommendationSchema,
    notes: z.string().nullable(),
    submittedAt: z.string().datetime(),
  })
  .openapi('RoundScore');

/** A round of an application: who conducts it and whether it's scored. */
export const applicationRoundSchema = z.object({
  round: roundSchema,
  /** The round's weight on the position's scorecard (%), null before it exists. */
  weight: z.number().int().nullable(),
  interviewerId: z.string().uuid().nullable(),
  interviewerName: z.string().nullable(),
  score: roundScoreSchema.nullable(),
  /** The round's latest slot (a cancelled one only until it is rescheduled). */
  slot: interviewSlotSchema.nullable(),
});

export const applicationSchema = z
  .object({
    id: z.string().uuid(),
    candidateId: z.string().uuid(),
    candidateName: z.string(),
    candidateCode: z.string().nullable(),
    candidateSource: z.enum(CANDIDATE_SOURCES),
    candidateNoticeDays: z.number().int().nullable(),
    /** Live progress (workflow deck): the next action, its owner and due date. */
    nextAction: z
      .object({
        text: z.string(),
        ownerId: z.string().uuid().nullable(),
        ownerName: z.string().nullable(),
        due: z.string().nullable(),
      })
      .nullable(),
    /** Contacts logged (calls, emails…) and the latest one. */
    contactCount: z.number().int(),
    lastContactAt: z.string().datetime().nullable(),
    positionId: z.string().uuid(),
    positionNumber: z.number().int(),
    requisitionId: z.string().uuid(),
    /** The line's TA RM — validates the shortlist and decides the hire. */
    taRmId: z.string().uuid().nullable(),
    /** The position's recruiter — works the candidate and schedules the rounds. */
    recruiterId: z.string().uuid().nullable(),
    roleTitle: z.string(),
    departmentName: z.string(),
    stage: stageSchema,
    /** The round open now (rounds run one after another); null outside interviews. */
    currentRound: roundSchema.nullable(),
    /** The rejection record: the round, who rejected, when the candidate was told. */
    rejectedRound: roundSchema.nullable(),
    rejectedByName: z.string().nullable(),
    informedAt: z.string().datetime().nullable(),
    shortlistedByName: z.string().nullable(),
    outcomeReason: z.string().nullable(),
    rounds: z.array(applicationRoundSchema),
    /**
     * The scorecard summary: Σ round score × round weight, out of 100, over
     * the rounds scored so far (null before any is scored).
     */
    scoreTotal: z.number().nullable(),
    /** Education + experience shown on the scorecard summary. */
    candidateEducation: z.string().nullable(),
    candidateExperienceYears: z.number().nullable(),
    createdAt: z.string().datetime(),
    /** Last change — the board's "days since it last moved". */
    updatedAt: z.string().datetime(),
    /** The offer waits for the line's approval (always true once positions exist). */
    lineApproved: z.boolean(),
    /**
     * The offer (workflow deck step 15): TA drafts the terms + letter, the HR
     * Head approves and signs, TA shares. null until TA starts it.
     */
    offer: z
      .object({
        status: z.enum(['draft', 'pending', 'approved', 'returned']),
        ctc: z.number().nullable(),
        joiningDate: z.string().nullable(),
        terms: z.string().nullable(),
        returnReason: z.string().nullable(),
        approvedByName: z.string().nullable(),
        approvedAt: z.string().datetime().nullable(),
      })
      .nullable(),
    offeredCtc: z.number().nullable(),
    joiningDate: z.string().nullable(),
    hasOfferLetter: z.boolean(),
    hasSignedLetter: z.boolean(),
    /** The document checklist and the candidate folder (workflow deck steps 13–14). */
    documents: z.object({ received: z.number().int(), pending: z.number().int(), total: z.number().int() }),
    folderLink: z.string().nullable(),
    employeeId: z.string().uuid().nullable(),
    /** HRBP confirmed the actual joining. */
    joinedAt: z.string().datetime().nullable(),
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
    /** Readable candidate ID, e.g. C-000123. */
    candidateCode: z.string().nullable(),
    education: z.string().nullable(),
    experienceYears: z.number().nullable(),
    // Candidate tracker (TA workflow deck, 2026-10-27). CTC stays inside TA.
    currentCompany: z.string().nullable(),
    designation: z.string().nullable(),
    location: z.string().nullable(),
    noticeDays: z.number().int().nullable(),
    currentCtc: z.number().nullable(),
    expectedCtc: z.number().nullable(),
    availableFrom: z.string().nullable(),
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

/** The candidate tracker's profile fields (TA workflow deck step 7). */
const ctcAmount = z.number().min(0).max(9_999_999_999);
const trackerFields = {
  /** Blank for freshers. */
  currentCompany: z.string().trim().max(200).optional(),
  designation: z.string().trim().max(200).optional(),
  location: z.string().trim().min(1, 'Where are they based?').max(120),
  noticeDays: z.number().int().min(0).max(365),
  currentCtc: ctcAmount.optional(),
  expectedCtc: ctcAmount.optional(),
  availableFrom: z.string().date().optional(),
};

/** Fill or correct a candidate's profile (TA) — e.g. after the screening call. */
export const updateCandidateSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    education: z.string().trim().min(1).max(300).optional(),
    experienceYears: z.number().min(0).max(60).optional(),
    currentCompany: z.string().trim().max(200).nullable().optional(),
    designation: z.string().trim().max(200).nullable().optional(),
    location: z.string().trim().min(1).max(120).optional(),
    noticeDays: z.number().int().min(0).max(365).optional(),
    currentCtc: ctcAmount.nullable().optional(),
    expectedCtc: ctcAmount.nullable().optional(),
    availableFrom: z.string().date().nullable().optional(),
  })
  .strict()
  .openapi('UpdateCandidate');

/** What happens next on an application, who does it, by when. */
export const nextActionSchema = z
  .object({
    nextAction: z.string().trim().min(1).max(300).nullable(),
    ownerId: z.string().uuid().nullable(),
    due: z.string().date().nullable(),
  })
  .strict()
  .openapi('NextAction');

export const ACTIVITY_KINDS = ['call', 'email', 'whatsapp', 'meeting'] as const;
export const ACTIVITY_OUTCOMES = ['connected', 'no_answer', 'busy', 'wrong_number', 'other'] as const;

/** Log a contact with the candidate (workflow deck: "calls done"). */
export const logActivitySchema = z
  .object({
    kind: z.enum(ACTIVITY_KINDS),
    outcome: z.enum(ACTIVITY_OUTCOMES),
    notes: z.string().trim().max(2000).optional(),
    happenedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .openapi('LogActivity');

export const activitySchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(ACTIVITY_KINDS),
    outcome: z.enum(ACTIVITY_OUTCOMES),
    notes: z.string().nullable(),
    happenedAt: z.string().datetime(),
    byName: z.string(),
  })
  .openapi('Activity');

export const createCandidateSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(200).optional(),
    phone: phoneSchema.optional(),
    source: z.enum(CANDIDATE_SOURCES),
    referredById: z.string().uuid().optional(),
    notes: z.string().trim().max(4000).optional(),
    /** Highest qualification, e.g. "B.Tech ECE, NIT Trichy" (scorecard summary). */
    education: z.string().trim().min(1, 'Enter their education').max(300),
    /** Total years of experience, e.g. 4.5. */
    experienceYears: z.number().min(0).max(60),
    ...trackerFields,
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
    /** Every attribute of the round, scored 1–4, with evidence (as on the Excel). */
    scores: z
      .array(
        z.object({
          attribute: z.string().trim().min(1),
          score: z.number().int().min(1).max(4),
          evidence: z.string().trim().max(4000).optional(),
        }),
      )
      .min(1),
    recommendation: recommendationSchema,
    notes: z.string().trim().max(4000).optional(),
  })
  .strict()
  // A "do not hire" ends the candidacy, so it must say why (the rejection record).
  .refine((v) => v.recommendation === 'hire' || (v.notes ?? '').trim().length > 0, {
    message: 'Say why — the reason is kept on the rejection record',
    path: ['notes'],
  })
  .openapi('SubmitScore');

/** Schedule (or move) a round: the interviewer is the line's named one for that round. */
export const scheduleInterviewSchema = z
  .object({
    startsAt: z.string().datetime({ offset: true }),
    durationMin: z.number().int().min(15).max(480).default(60),
    mode: z.enum(INTERVIEW_MODES),
    location: z.string().trim().max(500).optional(),
  })
  .strict()
  .openapi('ScheduleInterview');

/** Call a scheduled round off — cancelled, or the candidate did not show up. */
export const endInterviewSlotSchema = z
  .object({
    noShow: z.boolean().default(false),
    reason: z.string().trim().min(1).max(1000),
  })
  .strict()
  .openapi('EndInterviewSlot');

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
    /** This round's weight on the scorecard (%). */
    roundWeight: z.number().int().nullable(),
    /** This round's sheet only: attributes and the questions to ask. */
    attributes: z.array(z.object({ name: z.string(), questions: z.array(z.string()) })),
    candidateEducation: z.string().nullable(),
    candidateExperienceYears: z.number().nullable(),
    jdSummary: z.string().nullable(),
    /** When and how — null until the recruiter schedules it. */
    slot: interviewSlotSchema.nullable(),
    myScore: roundScoreSchema.nullable(),
  })
  .openapi('MyInterview');

/** The Hiring board (old-tool style page): live lines and every candidate on their positions. */
export const hiringBoardSchema = z
  .object({
    lines: z.array(requisitionSchema),
    applications: z.array(applicationSchema),
  })
  .openapi('HiringBoard');

export type CandidateSource = (typeof CANDIDATE_SOURCES)[number];
export type ApplicationStage = (typeof APPLICATION_STAGES)[number];
export type CandidateDto = z.infer<typeof candidateSchema>;
export type ApplicationDto = z.infer<typeof applicationSchema>;
export type RoundScoreDto = z.infer<typeof roundScoreSchema>;
export type CandidateMatchDto = z.infer<typeof candidateMatchSchema>;
export type MyInterviewDto = z.infer<typeof myInterviewSchema>;
export type HiringBoardDto = z.infer<typeof hiringBoardSchema>;
export type UpdateCandidateInput = z.infer<typeof updateCandidateSchema>;
export type NextActionInput = z.infer<typeof nextActionSchema>;
export type LogActivityInput = z.infer<typeof logActivitySchema>;
export type ActivityDto = z.infer<typeof activitySchema>;
export type CreateCandidateInput = z.infer<typeof createCandidateSchema>;
export type SubmitScoreInput = z.infer<typeof submitScoreSchema>;
export type ScheduleInterviewInput = z.infer<typeof scheduleInterviewSchema>;
export type EndInterviewSlotInput = z.infer<typeof endInterviewSlotSchema>;
export type InterviewSlotDto = z.infer<typeof interviewSlotSchema>;
