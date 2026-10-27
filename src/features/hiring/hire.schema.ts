import { z } from '../../shared/zod.js';
import { LEVELS } from '../../shared/constants/constants.js';
import { EMPLOYMENT_TYPES } from '../employees/index.js';
import { applicationSchema, BGV_STATUSES } from './candidates.schema.js';

/** A hire decision waiting for me, with the candidate's scores (visible only while pending). */
export const hireDecisionSchema = applicationSchema.openapi('HireDecision');

export const decideHireSchema = z
  .object({
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine((v) => v.decision === 'approve' || (v.reason ?? '').length > 0, {
    message: 'A rejection needs a reason',
    path: ['reason'],
  })
  .openapi('DecideHire');

export const makeOfferSchema = z
  .object({
    /** Annual CTC (₹) agreed in the HR final round. */
    ctc: z.number().positive().max(100_000_000),
    joiningDate: z.string().date(),
  })
  .strict()
  .openapi('MakeOffer');

export const bgvSchema = z
  .object({
    status: z.enum(BGV_STATUSES),
    notes: z.string().trim().max(4000).optional(),
  })
  .strict()
  .openapi('UpdateBgv');

export const endOfferSchema = z
  .object({ reason: z.string().trim().min(1).max(2000) })
  .strict()
  .openapi('EndOffer');

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

export type DecideHireInput = z.infer<typeof decideHireSchema>;
export type MakeOfferInput = z.infer<typeof makeOfferSchema>;
export type BgvInput = z.infer<typeof bgvSchema>;
export type MarkHiredInput = z.infer<typeof markHiredSchema>;
