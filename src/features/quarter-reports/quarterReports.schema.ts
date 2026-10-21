import { z } from '../../shared/zod.js';

const BAND = z.enum(['E3', 'E2', 'E1', 'below']);

export const quarterCycleSchema = z
  .object({
    name: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    closedAt: z.string().datetime().nullable(),
    closedByName: z.string().nullable(),
    reportCount: z.number().int(),
    /** True for the quarter around today. */
    current: z.boolean(),
  })
  .openapi('QuarterCycle');

export const quarterReportSchema = z
  .object({
    id: z.string().uuid(),
    cycleName: z.string(),
    employee: z.object({
      id: z.string().uuid(),
      name: z.string(),
      employeeCode: z.string(),
    }),
    rm: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
    departmentName: z.string().nullable(),
    goals: z.array(
      z.object({
        title: z.string(),
        category: z.enum(['fundamental', 'corporate', 'general']),
        weight: z.number(),
        progress: z.number(),
        target: z.string().nullable(),
        dueOn: z.string(),
      }),
    ),
    byCategory: z.object({
      fundamental: z.number().nullable(),
      corporate: z.number().nullable(),
      general: z.number().nullable(),
    }),
    /** Frozen at close: 50% Fundamental + 25% Corporate + 25% General. */
    computedScore: z.number().nullable(),
    computedBand: BAND.nullable(),
    /** The manager's final call (defaults to the computed score). */
    finalScore: z.number().nullable(),
    finalBand: BAND.nullable(),
    adjustReason: z.string().nullable(),
    adjustedByName: z.string().nullable(),
    adjustedAt: z.string().datetime().nullable(),
    updates: z.object({
      expected: z.number(),
      submitted: z.number(),
      monthsOverAllowance: z.number(),
    }),
    attendance: z.object({
      workingDays: z.number(),
      present: z.number(),
      wfh: z.number(),
      absent: z.number(),
      leave: z.number(),
      lateIns: z.number(),
      attendancePct: z.number().nullable(),
    }),
    recognitions: z.number().int(),
    feedback: z.object({ appreciation: z.number().int(), concern: z.number().int() }),
    atRiskGoals: z.number().int(),
    /** Final score under 50 — the PIP card says so (no PIP workflow yet). */
    pipCandidate: z.boolean(),
    /** Six months' service by the quarter's end (policy §18.11). */
    appraisalEligible: z.boolean(),
  })
  .openapi('QuarterReport');

export const teamOverviewSchema = z
  .object({
    rm: z.object({ id: z.string().uuid(), name: z.string() }).nullable(),
    people: z.number().int(),
    averageScore: z.number().nullable(),
    bands: z.object({
      E3: z.number().int(),
      E2: z.number().int(),
      E1: z.number().int(),
      below: z.number().int(),
      unscored: z.number().int(),
    }),
  })
  .openapi('QuarterTeamOverview');

export const quarterViewSchema = z
  .object({
    cycle: quarterCycleSchema,
    reports: z.array(quarterReportSchema),
    teams: z.array(teamOverviewSchema),
  })
  .openapi('QuarterReportView');

export const closeCycleSchema = z
  .object({
    /** Required to close the CURRENT quarter before its last day. */
    early: z.boolean().optional(),
  })
  .strict()
  .openapi('CloseQuarter');

export const adjustScoreSchema = z
  .object({
    finalScore: z.number().int().min(0).max(100),
    reason: z.string().trim().min(10).max(1000),
  })
  .strict()
  .openapi('AdjustQuarterScore');

export type QuarterCycleDto = z.infer<typeof quarterCycleSchema>;
export type QuarterReportDto = z.infer<typeof quarterReportSchema>;
export type TeamOverviewDto = z.infer<typeof teamOverviewSchema>;
export type QuarterViewDto = z.infer<typeof quarterViewSchema>;
export type CloseCycleInput = z.infer<typeof closeCycleSchema>;
export type AdjustScoreInput = z.infer<typeof adjustScoreSchema>;
export type Band = z.infer<typeof BAND>;
