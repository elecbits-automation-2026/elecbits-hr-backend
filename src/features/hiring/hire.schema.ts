import { z } from '../../shared/zod.js';
import { LEVELS } from '../../shared/constants/constants.js';
import { EMPLOYMENT_TYPES } from '../employees/index.js';
import { applicationSchema } from './candidates.schema.js';

/** An offer waiting for the HR Head's approval and signature, with the candidate. */
export const pendingOfferSchema = applicationSchema.openapi('PendingOffer');

/**
 * TA's draft of the offer after negotiation (workflow deck step 15): CTC,
 * joining date and any other terms. Changing approved terms reopens approval.
 */
export const offerDraftSchema = z
  .object({
    /** Annual CTC (₹) agreed with the candidate. */
    ctc: z.number().positive().max(100_000_000),
    joiningDate: z.string().date(),
    terms: z.string().trim().max(4000).optional(),
  })
  .strict()
  .openapi('OfferDraft');

/** The HR Head sends the offer back with what to change. */
export const returnOfferSchema = z
  .object({ reason: z.string().trim().min(1).max(2000) })
  .strict()
  .openapi('ReturnOffer');

export const endOfferSchema = z
  .object({ reason: z.string().trim().min(1).max(2000) })
  .strict()
  .openapi('EndOffer');

export const CANDIDATE_DOC_STATUSES = ['requested', 'received', 'not_applicable'] as const;

export const candidateDocumentSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    status: z.enum(CANDIDATE_DOC_STATUSES),
    updatedAt: z.string().datetime(),
  })
  .openapi('CandidateDocument');

export const addCandidateDocumentSchema = z
  .object({ name: z.string().trim().min(1).max(120) })
  .strict()
  .openapi('AddCandidateDocument');

export const setCandidateDocumentSchema = z
  .object({ status: z.enum(CANDIDATE_DOC_STATUSES) })
  .strict()
  .openapi('SetCandidateDocument');

/** The candidate's document folder link (Candidate ID + Name). */
export const folderLinkSchema = z
  .object({ link: z.string().trim().url().max(1000).nullable() })
  .strict()
  .openapi('FolderLink');

/**
 * Mark hired: what the employee record needs that the candidate doesn't
 * have — company email, employee code, level and RM (the record's own rules
 * apply: company email only, the RM must exist).
 */
export const markHiredSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(),
    employeeCode: z.string().trim().min(1).max(40),
    level: z.enum(LEVELS),
    reportsToId: z.string().uuid(),
    designation: z.string().trim().max(120).optional(),
    employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  })
  .strict()
  .openapi('MarkHired');

export const markHiredResultSchema = z
  .object({
    application: applicationSchema,
    employeeId: z.string().uuid(),
    /** Single-use sign-in link token for the joiner (shown once). */
    claim: z.object({ token: z.string(), expiresAt: z.string().datetime() }),
  })
  .openapi('MarkHiredResult');

export type OfferDraftInput = z.infer<typeof offerDraftSchema>;
export type MarkHiredInput = z.infer<typeof markHiredSchema>;
export type CandidateDocumentDto = z.infer<typeof candidateDocumentSchema>;
export type CandidateDocStatus = (typeof CANDIDATE_DOC_STATUSES)[number];
