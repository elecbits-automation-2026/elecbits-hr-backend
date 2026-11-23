import { z } from '../../shared/zod.js';
import { STRIP_STATUSES } from '../performance/performance.schema.js';

/** The Daily KPI alert rules (learner, 2026-11-16). */
export const ALERT_CODES = [
  'no_update', // a past working day without a work update
  'absent', // absent with no approved leave
  'short_day', // worked under the attendance short-day limit
  'goals_at_risk', // more than half the quarter's goals at risk
  'updates_below_target', // updates on fewer working days than the department target
  'attainment_below_target', // past mid-quarter, attainment under the department target
] as const;

export const dailyKpiQuerySchema = z.object({
  date: z.string().date().optional(),
});

const alertSchema = z.object({
  code: z.enum(ALERT_CODES),
  title: z.string(),
});

/** One person's day against the record — nothing here is typed in, all derived. */
export const dailyKpiRowSchema = z
  .object({
    employee: z.object({
      id: z.string().uuid(),
      name: z.string(),
      employeeCode: z.string(),
      department: z.string().nullable(),
    }),
    /** False before the joining date — such a day is never judged. */
    employed: z.boolean(),
    attendance: z.object({
      /** The classified day (leave type never shown here). */
      status: z.string(),
      checkInAt: z.string().nullable(),
      checkOutAt: z.string().nullable(),
      workedHours: z.number().nullable(),
      holidayName: z.string().nullable(),
      remote: z.boolean(),
    }),
    update: z.object({
      status: z.enum(STRIP_STATUSES),
      score: z.number().int().nullable(),
    }),
    /** The 7 days up to and including the date. */
    strip: z.array(z.object({ date: z.string(), status: z.enum(STRIP_STATUSES) })),
    /** Working days with an update over the last 7 working days before the date. */
    recentUpdates: z.object({ done: z.number().int(), workingDays: z.number().int() }),
    /** Average worked hours over the 7 days up to the date (days with hours only). */
    recentHours: z.object({ avg: z.number().nullable(), days: z.number().int() }),
    goals: z.object({
      count: z.number().int(),
      atRisk: z.number().int(),
      attainment: z.number().int().nullable(),
      /** Goals whose progress the person moved on the date (from the audit log). */
      moved: z.number().int(),
    }),
    targets: z.object({
      kpi: z.string().nullable(),
      updatesOnTimePct: z.number().int(),
      attainmentPct: z.number().int(),
    }),
    alerts: z.array(alertSchema),
  })
  .openapi('DailyKpiRow');

export const dailyKpiSchema = z
  .object({
    date: z.string(),
    /** The short-day limit in hours (Settings → Attendance → Hour rules). */
    shortDayBelowHours: z.number(),
    cycle: z.object({ name: z.string(), startDate: z.string(), endDate: z.string() }),
    rows: z.array(dailyKpiRowSchema),
  })
  .openapi('DailyKpi');

export type DailyKpiDto = z.infer<typeof dailyKpiSchema>;
export type DailyKpiRowDto = z.infer<typeof dailyKpiRowSchema>;
