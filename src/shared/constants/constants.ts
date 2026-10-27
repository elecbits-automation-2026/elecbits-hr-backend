/**
 * Shared constant unions. These mirror the Postgres enums in db/schema/enums.ts
 * — one list per concept, referenced by Zod schemas so requests validate
 * against exactly what the DB accepts.
 */

/** The four HR portals (design doc §1). Every employee may hold several. */
export const PORTALS = ['ta', 'hrbp', 'pr', 'ops'] as const;
export type Portal = (typeof PORTALS)[number];

/** CRUD actions a grant can carry (§3.1). */
export const ACTIONS = ['create', 'read', 'update', 'delete'] as const;
export type Action = (typeof ACTIONS)[number];

/** How far a grant reaches (§3.1). */
export const SCOPES = ['me', 'team_direct', 'team', 'dept', 'org'] as const;
export type Scope = (typeof SCOPES)[number];

/** Seniority levels (§2.3) — describe ownership, never grant access. */
export const LEVELS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'] as const;
export type Level = (typeof LEVELS)[number];

/**
 * Rights levels (§4.1): an APP-LAYER convenience mapped to action sets when
 * writing batch_grants rows — not a schema concept. Prevents nonsensical
 * combinations like delete-without-read.
 */
/**
 * Baseline batch names created by `npm run db:seed-batches`. One source of
 * truth: the seed script creates them and the employee-create flow attaches
 * the Employee batch by this exact name (§5.3).
 */
export const BASELINE_BATCHES = {
  employee: 'Employee',
  hrbp: 'HRBP',
  pr: 'PR',
  ops: 'OPS',
} as const;

/**
 * Leave types per the Attendance/Leave policy v1 (19 Feb 2026), stored in the
 * policy library as `leave`. RAISABLE types — `casual` died with the policy
 * and survives only in historical rows (and the DB enum).
 */
export const LEAVE_TYPES = [
  'sick',
  'earned',
  'menstrual',
  'vacation_family',
  'compassionate',
  'unpaid',
] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];

/** Every value a stored row can carry (history included) + the RM-mask value. */
export const LEAVE_TYPE_VALUES = [...LEAVE_TYPES, 'casual'] as const;
export const LEAVE_DISPLAY_TYPES = [...LEAVE_TYPE_VALUES, 'private'] as const;

export const CAPPED_LEAVE_TYPES = [
  'sick',
  'earned',
  'menstrual',
  'vacation_family',
  'compassionate',
] as const;
export type CappedLeaveType = (typeof CAPPED_LEAVE_TYPES)[number];

/** Annual entitlements (policy §9.2). Earned/menstrual ACCRUE monthly. */
export const LEAVE_YEARLY_QUOTAS: Record<CappedLeaveType, number> = {
  sick: 6,
  earned: 18,
  menstrual: 12,
  vacation_family: 5,
  compassionate: 3,
};

/** Earned leave: 1.5/month accrual, 30-day total cap, 18 usable per year (§9.3a). */
export const EL_MONTHLY_ACCRUAL = 1.5;
export const EL_BALANCE_CAP = 30;
export const EL_YEARLY_USE_LIMIT = 18;
/** Menstrual leave: 1 day/month up to 12 (§9.2). */
export const MENSTRUAL_MONTHLY_ACCRUAL = 1;

/**
 * Round to the nearest half day, exact quarters rounding UP — the proration
 * rule (refinement plan, user decision): 3.71 -> 3.5, 2.33 -> 2.5, 1.25 -> 1.5.
 */
export const roundToHalfDay = (x: number): number => Math.round(x * 2) / 2;

/**
 * A fixed annual quota (sick / vacation_family) for the year someone JOINED is
 * prorated by the share of the calendar year left from their joining date
 * (inclusive), rounded to the half day. Joined in an earlier year: full quota;
 * joined in a later year: nothing. Compassionate is never prorated (user
 * decision 2026-10-22): bereavement isn't earned, so a new joiner gets all 3.
 */
const proratedQuota = (quota: number, year: number, joinedOn: string): number => {
  const joinedYear = Number(joinedOn.slice(0, 4));
  if (joinedYear < year) return quota;
  if (joinedYear > year) return 0;
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  const joined = Date.parse(`${joinedOn.slice(0, 10)}T00:00:00Z`);
  return roundToHalfDay((quota * (end - joined)) / (end - start));
};

/**
 * Allocation for a balance row: accrued-to-date for the monthly-accruing
 * types — counted from the JOINING month in the joining year (the joining
 * month always counts, user decision), a past year fully accrued from then, a
 * future year not at all; the full quota for the fixed types, prorated in the
 * joining year when `joinedOn` is known.
 */
export const accruedAllocation = (
  type: CappedLeaveType,
  year: number,
  opts: { joinedOn?: string | null; now?: Date } = {},
): number => {
  const now = opts.now ?? new Date();
  const monthly =
    type === 'earned' ? EL_MONTHLY_ACCRUAL : type === 'menstrual' ? MENSTRUAL_MONTHLY_ACCRUAL : null;
  if (monthly === null) {
    if (!opts.joinedOn) return LEAVE_YEARLY_QUOTAS[type];
    if (type === 'compassionate') {
      return Number(opts.joinedOn.slice(0, 4)) > year ? 0 : LEAVE_YEARLY_QUOTAS[type];
    }
    return proratedQuota(LEAVE_YEARLY_QUOTAS[type], year, opts.joinedOn);
  }
  const lastMonth = year < now.getFullYear() ? 12 : year > now.getFullYear() ? 0 : now.getMonth() + 1;
  const joinedYear = opts.joinedOn ? Number(opts.joinedOn.slice(0, 4)) : null;
  if (joinedYear !== null && joinedYear > year) return 0;
  const firstMonth = joinedYear === year ? Number(opts.joinedOn!.slice(5, 7)) : 1;
  const months = Math.max(0, lastMonth - firstMonth + 1);
  return Math.min(LEAVE_YEARLY_QUOTAS[type], monthly * months);
};

export const RIGHTS_LEVELS = {
  viewer: ['read'],
  contributor: ['create', 'read'],
  editor: ['create', 'read', 'update'],
  manager: ['create', 'read', 'update', 'delete'],
} as const satisfies Record<string, readonly Action[]>;
export type RightsLevel = keyof typeof RIGHTS_LEVELS;

/**
 * R&R award plan (carried over from the previous HR tool): cadence and value
 * are the PLAN's, snapshotted onto each nomination. `any` has no window;
 * monthly/quarterly allow ONE approved award of that type per window.
 */
export const AWARD_TYPES = {
  spot: { name: 'Spot Award', cadence: 'any', valueInr: 2500, team: false },
  owner: { name: 'Ownership Award', cadence: 'monthly', valueInr: 5000, team: false },
  customer: { name: 'Customer Champion', cadence: 'monthly', valueInr: 5000, team: false },
  innov: { name: 'Innovation Award', cadence: 'quarterly', valueInr: 10000, team: false },
  team: { name: 'Team of the Quarter', cadence: 'quarterly', valueInr: 25000, team: true },
} as const;
export type AwardType = keyof typeof AWARD_TYPES;

/**
 * The career ladder (carried over from the previous HR tool): expectation
 * statements per level. Levels themselves live on employees.level (L1–L6);
 * this is the WORDING, versioned with the BAND policy, not a table.
 */
export const BAND_LADDER: Record<
  Level,
  { name: string; next: Level | null; expects: string }
> = {
  L1: { name: 'Associate', next: 'L2', expects: 'Executes defined tasks with supervision. Owns quality of their own output.' },
  L2: { name: 'Engineer / Executive', next: 'L3', expects: 'Owns a workstream end to end. Raises risks before they land.' },
  L3: { name: 'Senior Engineer / Specialist', next: 'L4', expects: "Owns a subsystem. Reviews others' work. Unblocks juniors." },
  L4: { name: 'Lead', next: 'L5', expects: 'Owns delivery across a team. Answers for outcomes, not effort.' },
  L5: { name: 'Department Head', next: 'L6', expects: 'Owns a function: its people, its plan and its budget.' },
  L6: { name: 'Leadership', next: null, expects: 'Owns the direction of the company.' },
};

/**
 * Fixed operating rules — internal knobs that used to be org settings and are
 * deliberately NOT tunable (user decision 2026-10-20): the settings panel
 * keeps real policy only.
 */
/** Shortest / longest R&R nomination citation, in characters. */
export const CITATION_MIN_LENGTH = 50;
export const CITATION_MAX_LENGTH = 500;
/** Missed work-update days per month before the RM is told and the month flagged. */
export const WORK_UPDATE_MISS_ALLOWANCE = 2;
/** A new onboarding journey is due this many days after it starts. */
export const ONBOARDING_DUE_DAYS = 30;
/** A journey self-creates on first visit only within this many days of joining. */
export const ONBOARDING_AUTO_CREATE_WINDOW_DAYS = 90;
/** How far ahead an open-door slot can be booked, in days. */
export const OPEN_DOOR_HORIZON_DAYS = 21;
/** How long a newly issued claim (invite) link stays usable, in days. */
export const INVITE_LINK_DAYS = 7;
/** Days back a punch may be regularized or a late work update entered. */
export const REGULARIZE_WINDOW_DAYS = 14;
/** Waiting approvals ring after / repeat every this many working days. */
export const APPROVAL_REMINDERS = { afterWorkingDays: 2, repeatEveryWorkingDays: 2 } as const;
/** Overdue lab loans / gate passes: ask again every N, escalate after M working days. */
export const RETURN_REMINDERS = { repeatEveryWorkingDays: 2, escalateAfterWorkingDays: 5 } as const;
