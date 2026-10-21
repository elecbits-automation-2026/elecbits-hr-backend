import { z } from '../../shared/zod.js';

export const cycleSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(), // '2026-Q4'
    startDate: z.string(),
    endDate: z.string(),
  })
  .openapi('ReviewCycle');

const GOAL_CATEGORY = z.enum(['fundamental', 'corporate', 'general']);

export const goalSchema = z
  .object({
    id: z.string().uuid(),
    employeeId: z.string().uuid(),
    cycleId: z.string().uuid(),
    title: z.string(),
    category: GOAL_CATEGORY,
    metric: z.string().nullable(),
    target: z.string().nullable(),
    weight: z.number(),
    progress: z.number().int(),
    dueOn: z.string(),
    createdByName: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('Goal');

/** Per-category attainment; null where the category has no goals. */
export const categoryAttainmentSchema = z
  .object({
    fundamental: z.number().nullable(),
    corporate: z.number().nullable(),
    general: z.number().nullable(),
  })
  .openapi('CategoryAttainment');

/**
 * The one score formula in the app: 50% Fundamental + 25% Corporate + 25%
 * General, each category Σ(progress×weight)/Σweight; categories without goals
 * drop out and the rest share their weight.
 */
export const myGoalsSchema = z
  .object({
    cycle: cycleSchema,
    goals: z.array(goalSchema),
    attainment: z.number().nullable(),
    byCategory: categoryAttainmentSchema,
    atRisk: z.number().int(),
    /** Weights should sum to 100 — the UI warns, nothing blocks. */
    weightTotal: z.number(),
  })
  .openapi('MyGoals');

export const createGoalSchema = z
  .object({
    employeeId: z.string().uuid(),
    title: z.string().trim().min(3).max(200),
    /** Defaults to fundamental. */
    category: GOAL_CATEGORY.optional(),
    metric: z.string().trim().max(200).optional(),
    target: z.string().trim().max(200).optional(),
    weight: z.number().min(0.5).max(100),
    /** Defaults to the cycle's end date. */
    dueOn: z.string().date().optional(),
  })
  .strict()
  .openapi('CreateGoal');

/** Edit a goal (RM-or-HR setter, open cycle only). Progress stays the owner's. */
export const updateGoalSchema = z
  .object({
    title: z.string().trim().min(3).max(200).optional(),
    category: GOAL_CATEGORY.optional(),
    metric: z.string().trim().max(200).nullable().optional(),
    target: z.string().trim().max(200).nullable().optional(),
    weight: z.number().min(0.5).max(100).optional(),
    dueOn: z.string().date().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to update' })
  .openapi('UpdateGoal');

export const updateProgressSchema = z
  .object({ progress: z.number().int().min(0).max(100) })
  .strict()
  .openapi('UpdateGoalProgress');

export const teamGoalsRowSchema = z
  .object({
    employee: z.object({
      id: z.string().uuid(),
      name: z.string(),
      employeeCode: z.string(),
    }),
    goalCount: z.number().int(),
    attainment: z.number().nullable(),
    atRisk: z.number().int(),
  })
  .openapi('TeamGoalsRow');

export const workUpdateSchema = z
  .object({
    id: z.string().uuid(),
    date: z.string(),
    note: z.string(),
    /** 0–100 alignment with OWN goals; null = unscored, NEVER 0 on failure. */
    score: z.number().int().nullable(),
    feedback: z.string().nullable(),
    kpiHits: z.array(z.string()).nullable(),
    /** Own goals this update is tagged with. */
    goalIds: z.array(z.string().uuid()).nullable(),
    /** null = written on the day; pending / approved / declined = a late entry. */
    lateStatus: z.enum(['pending', 'approved', 'declined']).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .openapi('WorkUpdate');

export const submitUpdateSchema = z
  .object({
    note: z.string().trim().min(10, 'Say what actually happened').max(4000),
    /** Optional tags — must be the writer's own goals this quarter. */
    goalIds: z.array(z.string().uuid()).max(10).optional(),
    /** Omit for today; a past date is a LATE entry for a missed day. */
    date: z.string().date().optional(),
  })
  .strict()
  .openapi('SubmitWorkUpdate');

/** One day of the update strip, as the server classifies it. */
export const STRIP_STATUSES = [
  'done',
  'missed',
  'late_pending',
  'late_approved',
  'leave',
  'holiday',
  'weekend',
  'today',
  'not_joined',
] as const;
export const stripDaySchema = z.object({
  date: z.string(),
  status: z.enum(STRIP_STATUSES),
});

export const decideLateSchema = z
  .object({ decision: z.enum(['approve', 'decline']) })
  .strict()
  .openapi('DecideLateUpdate');

export const myUpdatesSchema = z
  .object({
    updates: z.array(workUpdateSchema),
    scoringEnabled: z.boolean(),
    /** Oldest first, today last — leave, holidays and off days never count as a miss. */
    strip: z.array(stripDaySchema),
    missesThisMonth: z.number().int(),
    missAllowance: z.number().int(),
    /** Days a missed update can still be filled in late. */
    lateWindowDays: z.number().int(),
  })
  .openapi('MyWorkUpdates');

export const teamUpdatesRowSchema = z
  .object({
    employee: z.object({
      id: z.string().uuid(),
      name: z.string(),
      employeeCode: z.string(),
    }),
    updates: z.array(workUpdateSchema),
    missesThisMonth: z.number().int(),
    overAllowance: z.boolean(),
  })
  .openapi('TeamUpdatesRow');

/** A late entry waiting for its RM. */
export const lateUpdateSchema = z
  .object({
    employee: z.object({ id: z.string().uuid(), name: z.string() }),
    update: workUpdateSchema,
  })
  .openapi('LateWorkUpdate');

export type CycleDto = z.infer<typeof cycleSchema>;
export type GoalDto = z.infer<typeof goalSchema>;
export type MyGoalsDto = z.infer<typeof myGoalsSchema>;
export type CategoryAttainmentDto = z.infer<typeof categoryAttainmentSchema>;
export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateProgressInput = z.infer<typeof updateProgressSchema>;
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;
export type TeamGoalsRowDto = z.infer<typeof teamGoalsRowSchema>;
export type WorkUpdateDto = z.infer<typeof workUpdateSchema>;
export type SubmitUpdateInput = z.infer<typeof submitUpdateSchema>;
export type MyUpdatesDto = z.infer<typeof myUpdatesSchema>;
export type TeamUpdatesRowDto = z.infer<typeof teamUpdatesRowSchema>;
export type StripDayDto = z.infer<typeof stripDaySchema>;
export type DecideLateInput = z.infer<typeof decideLateSchema>;
export type LateUpdateDto = z.infer<typeof lateUpdateSchema>;
