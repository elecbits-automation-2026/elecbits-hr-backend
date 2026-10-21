import { z } from '../../shared/zod.js';

/** What one calendar day resolves to (precedence order in the service). */
const DAY_STATUSES = [
  'none', // future
  'weekend',
  'holiday',
  'leave',
  'half_leave',
  'wfh',
  'present',
  'half_day', // punched in, never out — auto-closed at midnight (0.5 present / 0.5 absent)
  'absent',
] as const;

// partially_approved only occurs on remote-work requests (dual RM+HR slots);
// regularizations remain single-approver.
const APPROVAL_STATUSES = [
  'pending',
  'partially_approved',
  'approved',
  'declined',
  'cancelled',
] as const;

/**
 * Punctuality of the punches vs the person's zone workday: green on time,
 * amber within grace, red beyond — and PURPLE `compensated` when a shifted
 * day still worked the full hours (both dots flip together).
 */
const CHECK_IN_TIMINGS = ['ontime', 'grace', 'late', 'compensated'] as const;
const CHECK_OUT_TIMINGS = ['ontime', 'grace', 'early', 'compensated'] as const;

/** One classified day in a month view. */
export const attendanceDaySchema = z
  .object({
    date: z.string(),
    status: z.enum(DAY_STATUSES),
    checkInAt: z.string().nullable(),
    checkOutAt: z.string().nullable(),
    source: z.enum(['office', 'remote', 'regularized']).nullable(),
    workedHours: z.number().nullable(),
    holidayName: z.string().nullable(),
    leaveType: z.string().nullable(),
    // Null when there is no corresponding punch.
    checkInTiming: z.enum(CHECK_IN_TIMINGS).nullable(),
    checkOutTiming: z.enum(CHECK_OUT_TIMINGS).nullable(),
  })
  .openapi('AttendanceDay');

export const attendanceSummarySchema = z
  .object({
    present: z.number(),
    absent: z.number(),
    leave: z.number(),
    wfh: z.number(),
    holiday: z.number(),
    weekend: z.number(),
    // grace + late/early punches — the amber and red dots, counted together.
    lateIns: z.number(),
    earlyOuts: z.number(),
  })
  .openapi('AttendanceSummary');

/** The own-month view: classified days + counts + today's punch state. */
export const myAttendanceSchema = z
  .object({
    month: z.string(), // YYYY-MM
    days: z.array(attendanceDaySchema),
    summary: attendanceSummarySchema,
    today: z
      .object({
        date: z.string(),
        checkedIn: z.boolean(),
        checkedOut: z.boolean(),
        checkInAt: z.string().nullable(),
        checkOutAt: z.string().nullable(),
        source: z.enum(['office', 'remote', 'regularized']).nullable(),
        checkInTiming: z.enum(CHECK_IN_TIMINGS).nullable(),
        checkOutTiming: z.enum(CHECK_OUT_TIMINGS).nullable(),
      })
      .nullable(), // null when the requested month is not the current one
  })
  .openapi('MyAttendance');

/** Team/org view: one classified month per person. */
export const employeeAttendanceSchema = z
  .object({
    employee: z.object({
      id: z.string().uuid(),
      name: z.string(),
      employeeCode: z.string(),
    }),
    days: z.array(attendanceDaySchema),
    summary: attendanceSummarySchema,
  })
  .openapi('EmployeeAttendance');

export const holidaySchema = z
  .object({ id: z.string().uuid(), date: z.string(), name: z.string() })
  .openapi('Holiday');

export const createHolidaySchema = z
  .object({ date: z.string().date(), name: z.string().min(1).max(200) })
  .strict()
  .openapi('CreateHoliday');

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The instant must fall on the attendance date it corrects (server-local,
 * the same convention punch rows use) — approval writes these timestamps
 * verbatim into that date's row, so a mismatch corrupts the calendar.
 */
const fallsOn = (iso: string, date: string): boolean =>
  new Date(iso).toLocaleDateString('en-CA') === date;

/** A punch zone (office/warehouse); null timings = the env default workday. */
export const punchZoneSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    lat: z.number(),
    lng: z.number(),
    radiusM: z.number().int(),
    workStart: z.string().nullable(),
    workEnd: z.string().nullable(),
  })
  .openapi('PunchZone');

export const createZoneSchema = z
  .object({
    name: z.string().min(1).max(100),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    // No 50 m floor (user decision) — any positive radius is allowed.
    radiusM: z.number().int().positive().max(5000).default(250),
    workStart: z.string().regex(HM, 'HH:mm').nullable().optional(),
    workEnd: z.string().regex(HM, 'HH:mm').nullable().optional(),
  })
  .strict()
  .refine((v) => Boolean(v.workStart) === Boolean(v.workEnd), {
    message: 'Provide both workStart and workEnd, or neither',
    path: ['workEnd'],
  })
  .openapi('CreatePunchZone');

/**
 * Check-in body: the browser's position, when the person shared it. The geo
 * policy decides the rest: inside an office zone (or covered by an approved
 * remote request) punches; otherwise the punch is REJECTED with 403
 * OUT_OF_OFFICE_RANGE — a denied/unavailable location only passes when a
 * remote request covers the day.
 */
export const punchSchema = z
  .object({
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  })
  .strict()
  .openapi('Punch');

/**
 * HR marks a missed day directly (user decision): no approval loop — the row
 * lands as `regularized`. Any single-day approved leave on that date is
 * revoked and refunded.
 */
export const hrMarkSchema = z
  .object({
    employeeId: z.string().uuid(),
    date: z.string().date(),
    checkInAt: z.string().datetime(),
    checkOutAt: z.string().datetime(),
    reason: z.string().max(1000).optional(),
  })
  .strict()
  .refine((v) => Date.parse(v.checkOutAt) > Date.parse(v.checkInAt), {
    message: 'checkOutAt must be after checkInAt',
    path: ['checkOutAt'],
  })
  .refine((v) => fallsOn(v.checkInAt, v.date) && fallsOn(v.checkOutAt, v.date), {
    message: 'checkInAt and checkOutAt must fall on the given date',
    path: ['checkInAt'],
  })
  .openapi('HrMarkAttendance');

/** "Fix my punch": proposed in/out for one recent date. */
export const createRegularizationSchema = z
  .object({
    date: z.string().date(),
    proposedIn: z.string().datetime(),
    proposedOut: z.string().datetime(),
    reason: z.string().max(1000).optional(),
  })
  .strict()
  .refine((v) => Date.parse(v.proposedOut) > Date.parse(v.proposedIn), {
    message: 'proposedOut must be after proposedIn',
    path: ['proposedOut'],
  })
  .refine((v) => fallsOn(v.proposedIn, v.date) && fallsOn(v.proposedOut, v.date), {
    message: 'proposedIn and proposedOut must fall on the given date',
    path: ['proposedIn'],
  })
  .openapi('CreateRegularization');

export const regularizationSchema = z
  .object({
    id: z.string().uuid(),
    employee: z.object({
      id: z.string().uuid(),
      name: z.string(),
      employeeCode: z.string(),
    }),
    date: z.string(),
    proposedIn: z.string(),
    proposedOut: z.string(),
    reason: z.string().nullable(),
    status: z.enum(APPROVAL_STATUSES),
    decidedBy: z.string().uuid().nullable(),
    decisionReason: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('Regularization');

/**
 * Remote-work request (user decision): a REASON is mandatory — "client visit
 * at X", "WFH, plumber" — and BOTH the RM and HR approve, like a leave. It is
 * a request, never an auto-marker: only a fully approved one classifies days
 * or lifts the punch geo-block.
 */
export const createWfhSchema = z
  .object({
    startDate: z.string().date(),
    endDate: z.string().date(),
    reason: z.string().min(5, 'Give a reason (at least 5 characters)').max(1000),
  })
  .strict()
  .refine((v) => v.endDate >= v.startDate, {
    message: 'endDate must not be before startDate',
    path: ['endDate'],
  })
  .openapi('CreateRemoteWork');

export const wfhRequestSchema = z
  .object({
    id: z.string().uuid(),
    employee: z.object({
      id: z.string().uuid(),
      name: z.string(),
      employeeCode: z.string(),
    }),
    type: z.enum(['wfh', 'client_visit', 'remote']),
    startDate: z.string(),
    endDate: z.string(),
    reason: z.string().nullable(),
    status: z.enum(APPROVAL_STATUSES),
    rmApprovedBy: z.string().uuid().nullable(),
    hrApprovedBy: z.string().uuid().nullable(),
    // Display names for the filled slots — queues show WHO approved, not a tick.
    rmApprovedByName: z.string().nullable(),
    hrApprovedByName: z.string().nullable(),
    decidedBy: z.string().uuid().nullable(),
    decisionReason: z.string().nullable(),
    createdAt: z.string().datetime(),
  })
  .openapi('RemoteWorkRequest');

/** Approve or decline — RM-only; the service checks the relationship. */
export const decideSchema = z
  .object({
    decision: z.enum(['approve', 'decline']),
    reason: z.string().max(1000).optional(),
  })
  .strict()
  // Declines are terminal, so they must carry a reason (user decision) —
  // applies to remote-work and regularization decisions alike.
  .refine((v) => v.decision !== 'decline' || Boolean(v.reason?.trim()), {
    message: 'A reason is required to decline',
    path: ['reason'],
  })
  .openapi('DecideAttendanceRequest');

export type AttendanceDayDto = z.infer<typeof attendanceDaySchema>;
export type AttendanceSummaryDto = z.infer<typeof attendanceSummarySchema>;
export type MyAttendanceDto = z.infer<typeof myAttendanceSchema>;
export type EmployeeAttendanceDto = z.infer<typeof employeeAttendanceSchema>;
export type HolidayDto = z.infer<typeof holidaySchema>;
export type PunchInput = z.infer<typeof punchSchema>;
export type PunchZoneDto = z.infer<typeof punchZoneSchema>;
export type CreateZoneInput = z.infer<typeof createZoneSchema>;
export type HrMarkInput = z.infer<typeof hrMarkSchema>;
export type CreateHolidayInput = z.infer<typeof createHolidaySchema>;
export type CreateRegularizationInput = z.infer<typeof createRegularizationSchema>;
export type RegularizationDto = z.infer<typeof regularizationSchema>;
export type CreateWfhInput = z.infer<typeof createWfhSchema>;
export type WfhRequestDto = z.infer<typeof wfhRequestSchema>;
export type DecideInput = z.infer<typeof decideSchema>;
