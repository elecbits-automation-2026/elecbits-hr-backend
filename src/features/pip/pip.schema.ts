import { z } from '../../shared/zod.js';

const ref = z.object({ id: z.string().uuid(), name: z.string() });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

export const pipTargetSchema = z.object({
  title: z.string().trim().min(3).max(300),
  measure: z.string().trim().min(3).max(500),
});

export const pipSchema = z
  .object({
    id: z.string().uuid(),
    employee: z.object({
      id: z.string().uuid(),
      name: z.string(),
      employeeCode: z.string(),
      designation: z.string().nullable(),
    }),
    rm: ref,
    // `pending_hr` is history only — PIPs start active since 2026-11-05.
    status: z.enum(['pending_hr', 'active', 'passed', 'not_passed', 'cancelled']),
    reason: z.string(),
    targets: z.array(pipTargetSchema),
    support: z.string(),
    startOn: z.string(),
    endOn: z.string(),
    extended: z.boolean(),
    outcomeNote: z.string().nullable(),
    outcomeBy: ref.nullable(),
    outcomeAt: z.string().datetime().nullable(),
    can: z.object({
      outcome: z.boolean(),
      cancel: z.boolean(),
    }),
    createdAt: z.string().datetime(),
  })
  .openapi('Pip');

/** The RM opens a PIP — targets, support, a start date; it runs 60 days. */
export const createPipSchema = z
  .object({
    employeeId: z.string().uuid(),
    reason: z.string().trim().min(10).max(3000),
    targets: z.array(pipTargetSchema).min(1).max(10),
    support: z.string().trim().min(10).max(3000),
    startOn: isoDate.optional(),
  })
  .strict()
  .openapi('CreatePip');

/** At the end: passed, one 30-day extension, or not passed. */
export const pipOutcomeSchema = z
  .object({
    outcome: z.enum(['passed', 'extend', 'not_passed']),
    note: z.string().trim().min(5).max(3000),
  })
  .strict()
  .openapi('PipOutcome');

export const cancelPipSchema = z
  .object({ note: z.string().trim().min(3).max(1000) })
  .strict()
  .openapi('CancelPip');

export type PipDto = z.infer<typeof pipSchema>;
export type CreatePipInput = z.infer<typeof createPipSchema>;
export type PipOutcomeInput = z.infer<typeof pipOutcomeSchema>;
export type CancelPipInput = z.infer<typeof cancelPipSchema>;
