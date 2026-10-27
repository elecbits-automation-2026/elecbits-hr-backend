import { env } from '../../config/env.js';
import { AWARD_TYPES } from '../../shared/constants/constants.js';
import { z } from '../../shared/zod.js';

/**
 * The registry of org-tunable settings (refinement plan X4): every key the
 * settings feature accepts, its zod shape, a human label and its DEFAULT —
 * which is today's constant, so an empty org_settings table changes nothing.
 *
 * Features ADOPT a setting by reading it through the settings repository in
 * their composition root (the same cross-feature composition payroll uses for
 * attendance); until a feature adopts its key, editing it has no effect, and
 * each phase of the plan says which keys go live. Structural policy (leave
 * quotas, payroll engine percentages, tax slabs) is deliberately NOT here.
 *
 * Every key belongs to an AREA, and the area's owning module decides who may
 * read/edit it (alongside access.settings, which opens every area).
 */

/** Settings areas and the module whose org/dept-scoped grant owns each. */
export const SETTING_AREAS = [
  'payroll',
  'attendance',
  'leaves',
  'people',
  'ops',
  'access',
] as const;
export type SettingArea = (typeof SETTING_AREAS)[number];

/** null = no owning module: access.settings (or Owner/SuperAdmin) only. */
export const AREA_MODULES: Record<SettingArea, string | null> = {
  payroll: 'pr.payroll',
  attendance: 'hrbp.attendance',
  leaves: 'hrbp.leaves',
  people: 'hrbp.people',
  ops: 'ops.assets',
  access: null,
};

const awardEntry = z.object({
  name: z.string().trim().min(2).max(60),
  cadence: z.enum(['any', 'monthly', 'quarterly']),
  valueInr: z.number().int().min(0).max(10_000_000),
  /** May name several recipients; the value is split equally between them. */
  team: z.boolean().default(false),
});

/** Saturday pattern for the work week (Sundays are always off). */
export const SATURDAY_PATTERNS = ['all_working', 'all_off', 'first_third_off'] as const;

/** Leave types payroll may draw on to cover unmarked absence, in order. */
export const AUTO_COVER_LEAVE_TYPES = ['earned', 'sick'] as const;

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (hm: string): number => {
  const [h, m] = hm.split(':').map(Number);
  return h! * 60 + m!;
};

const definitions = {
  'awards.catalog': {
    area: 'people',
    live: true,
    label: 'R&R award catalog',
    description:
      'Award types HR offers: name, ₹ value, cadence (one approved award per month/quarter, or any time) and whether it can go to a team (value split equally). Name and value snapshot onto each nomination, so editing or removing a type never changes awards already given. Approved awards pay in the next month’s payslip.',
    schema: z.record(z.string().regex(/^[a-z][a-z0-9_]{1,30}$/), awardEntry),
    default: AWARD_TYPES as Record<string, z.infer<typeof awardEntry>>,
  },
  'leaves.applicationWindowDays': {
    area: 'leaves',
    live: true,
    public: true,
    label: 'Leave application windows (days ahead)',
    description:
      'Planned leave must be raised this many days before it starts (0 = no window). Sick, menstrual, compassionate and unpaid are always exempt.',
    schema: z.object({
      earned: z.number().int().min(0).max(90),
      vacation_family: z.number().int().min(0).max(90),
    }),
    default: { earned: 7, vacation_family: 7 },
  },
  'attendance.workWeek': {
    area: 'attendance',
    live: true,
    public: true,
    label: 'Work week',
    description:
      'Sundays are always off. Saturday pattern: first_third_off = 1st & 3rd Saturdays off, the rest working — from the start date on; before it every Saturday is off. An off Saturday is like a weekend: a punch is recorded but earns nothing and has no hour rules or punctuality. Leave on it costs nothing.',
    schema: z.object({
      saturdays: z.enum(SATURDAY_PATTERNS),
      // Before this date every Saturday stays a weekend — past months never
      // grow new absences when the pattern changes.
      effectiveFrom: z.string().date(),
    }),
    default: {
      saturdays: 'first_third_off' as (typeof SATURDAY_PATTERNS)[number],
      effectiveFrom: '2026-11-01',
    },
  },
  'attendance.workHours': {
    area: 'attendance',
    live: true,
    public: true,
    label: 'Default work hours',
    description:
      'The workday for punctuality dots wherever a punch zone sets no hours of its own, and the late/early grace band (org-wide, every zone). Dots are computed, so past months re-colour too; LOP is unaffected.',
    schema: z
      .object({
        workStart: z.string().regex(HM, 'HH:mm'),
        workEnd: z.string().regex(HM, 'HH:mm'),
        graceMinutes: z.number().int().min(0).max(120),
      })
      .refine((v) => toMin(v.workStart) < toMin(v.workEnd), {
        message: 'Work start must be before work end',
        path: ['workEnd'],
      }),
    default: {
      workStart: env.attendance.workStart as string,
      workEnd: env.attendance.workEnd as string,
      graceMinutes: env.attendance.graceMinutes as number,
    },
  },
  'attendance.hourRules': {
    area: 'attendance',
    live: true,
    label: 'Hour rules',
    description:
      'On a working day with a check-out: under the half-day limit counts as a half day (the other half is LOP); under the short-day limit stays a full day but the person and their manager get a notification. Applies from the start date. A missed check-out is always a half day.',
    schema: z
      .object({
        halfDayBelowHours: z.number().min(0).max(12),
        shortDayBelowHours: z.number().min(0).max(16),
        // Days before this keep the old rules, so past months never grow new
        // half days (LOP) when the rules change.
        effectiveFrom: z.string().date(),
      })
      .refine((v) => v.halfDayBelowHours <= v.shortDayBelowHours, {
        message: 'The half-day limit must not exceed the short-day limit',
        path: ['halfDayBelowHours'],
      }),
    default: { halfDayBelowHours: 4, shortDayBelowHours: 8, effectiveFrom: '2026-11-01' },
  },
  'payroll.payslipHeader': {
    area: 'payroll',
    live: true,
    label: 'Payslip header',
    description:
      'The company name and address printed at the top of every payslip PDF. Changing it changes downloads of past payslips too — the numbers never change.',
    schema: z.object({
      companyName: z.string().trim().min(2).max(120),
      address: z.string().trim().max(300),
    }),
    default: { companyName: 'Elecbits', address: '' },
  },
  'payroll.ptStates': {
    area: 'payroll',
    live: true,
    label: 'Professional tax by state',
    description:
      'Each state lists the punch zones that belong to it (an employee\'s base zone name contains one of them, case-insensitive) and its monthly slabs: from a prorated monthly salary, the monthly PT, and the February amount where the state charges more that month. A state not listed (Delhi, for example) charges no PT. Draft payslips pick up a change when edited or finalized; finalized slips never change.',
    schema: z.object({
      states: z
        .array(
          z.object({
            state: z.string().trim().min(2).max(60),
            zoneNames: z.array(z.string().trim().min(2).max(80)).max(50),
            slabs: z
              .array(
                z.object({
                  fromMonthly: z.number().int().min(0).max(10_000_000),
                  amount: z.number().int().min(0).max(5_000),
                  februaryAmount: z.number().int().min(0).max(5_000).nullable(),
                }),
              )
              .min(1)
              .max(10),
          }),
        )
        .max(40),
    }),
    default: {
      states: [
        {
          state: 'Karnataka',
          zoneNames: ['Bangalore'] as string[],
          slabs: [{ fromMonthly: 25_000, amount: 200, februaryAmount: 300 as number | null }],
        },
      ],
    },
  },
  'payroll.monthEndAutoApprove': {
    area: 'payroll',
    live: true,
    label: 'Month-end auto-approval',
    description:
      'When payroll is generated, requests still half-approved (one of RM/HR) for the month count as approved. Turn one off and those requests must be decided before the month can be finalized.',
    schema: z.object({ leaves: z.boolean(), remote: z.boolean() }),
    default: { leaves: true, remote: true },
  },
  'payroll.autoCoverLeaveTypes': {
    area: 'payroll',
    live: true,
    label: 'Absence auto-cover',
    description:
      'Unmarked absent days are covered from these leave balances, in this order, before the rest becomes LOP. Empty = every absent day is LOP.',
    schema: z
      .array(z.enum(AUTO_COVER_LEAVE_TYPES))
      .max(AUTO_COVER_LEAVE_TYPES.length)
      .refine((v) => new Set(v).size === v.length, 'Each leave type at most once'),
    default: ['earned'] as (typeof AUTO_COVER_LEAVE_TYPES)[number][],
  },
  'people.newHireDefaults': {
    area: 'people',
    live: true,
    label: 'New-hire defaults',
    description:
      'Filled in when a new employee is added without them (blank = leave unset). Probation sets the confirmation date from the joining date — during probation only sick leave can be raised. An Admin invite gets probation only when it carries a joining date.',
    schema: z.object({
      noticeDays: z.number().int().min(0).max(180).nullable(),
      probationMonths: z.number().int().min(0).max(24).nullable(),
    }),
    default: {
      noticeDays: null as number | null,
      probationMonths: null as number | null,
    },
  },
  'career.selfRequest': {
    area: 'people',
    live: true,
    public: true,
    label: 'Promotion self-request minimums',
    description:
      'What an employee needs before they can ask for a promotion conversation themselves: months in their current band (from their last level change, else their joining date), last quarter\'s goal attainment (blank = not required; a quarter with no goals is not held against them), and days to wait after a conversation was closed without a promotion. A manager or HR opening the conversation skips all three.',
    schema: z.object({
      minMonthsInBand: z.number().int().min(0).max(60),
      minAttainment: z.number().int().min(0).max(100).nullable(),
      cooldownDays: z.number().int().min(0).max(365),
    }),
    default: {
      minMonthsInBand: 12,
      minAttainment: 60 as number | null,
      cooldownDays: 90,
    },
  },
  'concerns.timelines': {
    area: 'people',
    live: true,
    label: 'Concern timelines',
    description:
      'Deadlines for raised concerns, in WORKING days unless marked calendar. Disputes (Dispute Resolution Framework): manager decides at level 1, HR acknowledges and decides at level 2, the Management Review Committee decides at level 3, and the employee may escalate within the escalation window after a decision. Complaints (Equal Opportunity / anti-bullying): acknowledge, then an outcome within calendar days. Whistleblower reports: the policy sets no numbers — these are the targets the vigil team works to.',
    schema: z.object({
      l1Decide: z.number().int().min(1).max(60),
      l2Ack: z.number().int().min(1).max(60),
      l2Decide: z.number().int().min(1).max(60),
      l3Decide: z.number().int().min(1).max(90),
      escalateWithin: z.number().int().min(1).max(60),
      complaintAck: z.number().int().min(1).max(60),
      complaintResolveCalendarDays: z.number().int().min(1).max(365),
      vigilAck: z.number().int().min(1).max(60),
      vigilResolveCalendarDays: z.number().int().min(1).max(365),
    }),
    default: {
      l1Decide: 5,
      l2Ack: 3,
      l2Decide: 10,
      l3Decide: 15,
      escalateWithin: 10,
      complaintAck: 7,
      complaintResolveCalendarDays: 60,
      vigilAck: 7,
      vigilResolveCalendarDays: 60,
    },
  },
  'concerns.icContact': {
    area: 'people',
    live: true,
    public: true,
    label: 'Internal Committee (POSH) contact',
    description:
      'Shown when someone chooses "sexual harassment" in Raise a concern — nothing about it is stored in this system; it goes to the Internal Committee under the POSH policy. Blank shows "contact HR for the Internal Committee details".',
    schema: z.object({ contact: z.string().trim().max(300) }),
    default: { contact: '' },
  },
  'hiring.hrDepartment': {
    area: 'people',
    live: true,
    label: 'HR department (hiring approvals)',
    description:
      'The head of this department gives the HR approval on hiring lines, alongside Admin (department heads are assigned on the Seats page). Blank = no HR approver, so submitted lines wait.',
    schema: z.object({ departmentId: z.string().uuid().nullable() }),
    default: { departmentId: null as string | null },
  },
  'hiring.planWindow': {
    area: 'people',
    live: true,
    label: 'Quarterly hiring-plan window',
    description:
      'Department heads are reminded this many days before a quarter starts to add their hiring needs for it, with a deadline the second number of days before the start. Lines a head submits wait until the deadline; the day after, all of them go to the HR head and Admin together. Lines added after the deadline go into the plan for the quarter after (urgent needs use Urgent hire).',
    schema: z
      .object({
        remindDaysBefore: z.number().int().min(1).max(90),
        deadlineDaysBefore: z.number().int().min(0).max(89),
      })
      .refine((v) => v.deadlineDaysBefore < v.remindDaysBefore, {
        message: 'The deadline must come after the reminder',
      }),
    default: { remindDaysBefore: 30, deadlineDaysBefore: 10 },
  },
  'concerns.mrcMembers': {
    area: 'access',
    live: true,
    label: 'Management Review Committee',
    description:
      'The people who decide level-3 disputes (Dispute Resolution Framework). A member who is the subject of a case or decided it at level 2 is skipped for that case.',
    schema: z.object({ employeeIds: z.array(z.string().uuid()).max(20) }),
    default: { employeeIds: [] as string[] },
  },
} as const;

export type SettingKey = keyof typeof definitions;
export const SETTING_KEYS = Object.keys(definitions) as SettingKey[];

/** The typed value of one key — what `effective(key)` resolves to. */
export type SettingValue<K extends SettingKey> = z.infer<
  (typeof definitions)[K]['schema']
>;

export interface SettingDefinition {
  area: SettingArea;
  /**
   * True once a feature reads this key through the repository. Flip it in the
   * same commit that adopts the key, so the settings page never presents an
   * edit that has no effect.
   */
  live: boolean;
  /** Readable by every signed-in user (employee-side hints) via /settings/public. */
  public?: boolean;
  label: string;
  description: string;
  schema: z.ZodTypeAny;
  default: unknown;
}

export const SETTINGS_REGISTRY: Record<SettingKey, SettingDefinition> = definitions;

export const PUBLIC_SETTING_KEYS = SETTING_KEYS.filter(
  (k) => SETTINGS_REGISTRY[k].public,
);

export const isSettingKey = (key: string): key is SettingKey => key in definitions;

export const isSettingArea = (area: string): area is SettingArea =>
  (SETTING_AREAS as readonly string[]).includes(area);
