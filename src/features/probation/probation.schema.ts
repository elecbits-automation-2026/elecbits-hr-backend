import { z } from '../../shared/zod.js';

const ref = z.object({ id: z.string().uuid(), name: z.string() });

/** The end-of-probation decision for one person. */
export const probationReviewSchema = z
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
    dueOn: z.string(),
    // The date it confirms by itself when nobody decides (due + 7 days).
    autoConfirmOn: z.string(),
    status: z.enum(['pending', 'recommended', 'confirmed', 'ended']),
    recommendation: z.enum(['confirm', 'end']).nullable(),
    recommendationNote: z.string().nullable(),
    recommendedBy: ref.nullable(),
    recommendedAt: z.string().datetime().nullable(),
    decidedBy: ref.nullable(),
    decidedAt: z.string().datetime().nullable(),
    decisionNote: z.string().nullable(),
    autoConfirmed: z.boolean(),
    exitId: z.string().uuid().nullable(),
    can: z.object({ recommend: z.boolean(), decide: z.boolean(), letter: z.boolean() }),
    createdAt: z.string().datetime(),
  })
  .openapi('ProbationReview');

export const recommendSchema = z
  .object({
    recommendation: z.enum(['confirm', 'end']),
    note: z.string().trim().min(5).max(3000),
  })
  .strict()
  .openapi('ProbationRecommend');

/** HR's decision. Ending it starts a termination exit (serve / pay in lieu). */
export const decideSchema = z
  .object({
    decision: z.enum(['confirm', 'end']),
    note: z.string().trim().min(5).max(3000),
    mode: z.enum(['serve', 'pay_in_lieu']).optional(),
    lastWorkingDay: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
  })
  .strict()
  .openapi('ProbationDecide');

export type ProbationReviewDto = z.infer<typeof probationReviewSchema>;
export type RecommendInput = z.infer<typeof recommendSchema>;
export type DecideInput = z.infer<typeof decideSchema>;
