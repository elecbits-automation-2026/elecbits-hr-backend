import { z } from 'zod';
import { reachesIn, type PeopleScope } from '../access/authz.repository.js';
import type { AttendanceService } from '../attendance/attendance.service.js';
import type { ConcernsService } from '../concerns/concerns.service.js';
import type { DailyKpiService } from '../daily-kpi/dailyKpi.service.js';
import type { EmployeesService } from '../employees/employees.service.js';
import type { LeavesService } from '../leaves/leaves.service.js';
import type { OnboardingService } from '../onboarding/onboarding.service.js';
import type { PerformanceService } from '../performance/performance.service.js';
import type { PoliciesService } from '../policies/policies.service.js';

/**
 * The HR Assistant's tools — read-only, each a thin wrapper over a service
 * the pages already use, so every access rule still holds (design: the model
 * never touches the database). Results are trimmed to names, dates and
 * counts. Deliberately absent: payroll / salary / bank, documents, concern
 * contents, POSH, leave reasons, and leave balances (that read writes accruals).
 */

/** Who is asking — resolved once per message from grants, never from the token. */
export interface Caller {
  userId: string;
  employeeId: string;
  /** Anyone routes to them as RM or leave approver. */
  manager: boolean;
  /** Reach under hrbp.people read (null = no grant beyond self). */
  hrPeople: PeopleScope | null;
  /** hrbp.people read at org scope (the Daily KPI org view needs it). */
  hrPeopleOrg: boolean;
  /** Reach under hrbp.attendance read. */
  hrAttendance: PeopleScope | null;
}

export interface ToolServices {
  attendance: AttendanceService;
  leaves: LeavesService;
  dailyKpi: DailyKpiService;
  performance: PerformanceService;
  onboarding: OnboardingService;
  employees: EmployeesService;
  concerns: ConcernsService;
  policies: PoliciesService;
}

interface AssistantTool<S extends z.ZodObject> {
  name: string;
  /** Shown to the user under the answer ("Used: …"). */
  label: string;
  description: string;
  input: S;
  allowed(c: Caller): boolean;
  // Method syntax on purpose: the list below holds tools of different inputs.
  run(c: Caller, input: z.infer<S>, s: ToolServices): Promise<unknown>;
}

export type AnyTool = AssistantTool<z.ZodObject>;

const tool = <S extends z.ZodObject>(t: AssistantTool<S>): AnyTool => t as unknown as AnyTool;

/** Lists the model sees are capped; the total says when more exist. */
const MAX_ROWS = 60;
const capped = <T>(rows: T[]) => ({
  total: rows.length,
  rows: rows.slice(0, MAX_ROWS),
  ...(rows.length > MAX_ROWS ? { note: `showing the first ${MAX_ROWS}` } : {}),
});

const today = (): string => new Date().toLocaleDateString('en-CA');
const monthOf = (date: string): string => date.slice(0, 7);
const plusDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Monday..Sunday around `date`. */
const weekOf = (date: string): string[] => {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const monday = plusDays(date, dow === 0 ? -6 : 1 - dow);
  return Array.from({ length: 7 }, (_, i) => plusDays(monday, i));
};

/** Menstrual leave is confidential to the employee and HR — RMs see "leave". */
const rmLeaveType = (type: string | null) => (type === 'menstrual' ? 'leave' : type);

const isManager = (c: Caller) => c.manager;
const isHr = (c: Caller) => c.hrPeople !== null || c.hrAttendance !== null;
const isEither = (c: Caller) => isManager(c) || isHr(c);
const keep = <T>(scope: PeopleScope | null, rows: T[], personOf: (r: T) => string) =>
  scope === null ? [] : rows.filter((r) => reachesIn(scope, personOf(r)));

const monthInput = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional()
    .describe('YYYY-MM; defaults to the current month'),
});
const dateInput = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional()
    .describe('YYYY-MM-DD; defaults to today'),
});

/** Day statuses that mean "not in the office as usual". */
const OUT_STATUSES = new Set(['leave', 'half_leave', 'absent', 'wfh']);
/** Work-update strip statuses that need a nudge. */
const UPDATE_GAPS = new Set(['missed', 'late_pending', 'today']);

export const TOOLS: AnyTool[] = [
  tool({
    name: 'team_who_is_out',
    label: "Who's out",
    description:
      "The caller's own team (direct and leave-approver reports): who is on leave, half-day leave, remote, or absent today or this week, plus approved leave coming up in that week. Leave type 'menstrual' is never shown.",
    input: z.object({ period: z.enum(['today', 'this_week']).default('today') }),
    allowed: isManager,
    run: async (c, { period }, s) => {
      const dates = period === 'today' ? [today()] : weekOf(today());
      const months = [...new Set(dates.map(monthOf))];
      const views = (
        await Promise.all(months.map((m) => s.attendance.teamMonth(c.employeeId, m)))
      ).flat();
      const out = views.flatMap((v) =>
        v.days
          .filter((d) => dates.includes(d.date) && OUT_STATUSES.has(d.status))
          .map((d) => ({
            name: v.employee.name,
            date: d.date,
            status: d.status,
            leaveType: rmLeaveType(d.leaveType),
          })),
      );
      const [first, last] = [dates[0]!, dates[dates.length - 1]!];
      const upcoming = (await s.leaves.listTeam(c.employeeId))
        .filter(
          (l) =>
            l.status === 'approved' &&
            l.startDate <= last &&
            l.endDate >= first &&
            l.endDate >= today(),
        )
        .map((l) => ({
          name: l.employee.name,
          type: rmLeaveType(l.type),
          from: l.startDate,
          to: l.endDate,
          dayPart: l.dayPart,
        }));
      return { period, dates: { from: first, to: last }, out, approvedLeave: upcoming };
    },
  }),

  tool({
    name: 'team_attendance_summary',
    label: 'Team attendance',
    description:
      "Month attendance counts for each person in the caller's own team: present, absent, leave, remote, late check-ins, early check-outs.",
    input: monthInput,
    allowed: isManager,
    run: async (c, { month }, s) => {
      const m = month ?? monthOf(today());
      const views = await s.attendance.teamMonth(c.employeeId, m);
      return {
        month: m,
        ...capped(
          views.map((v) => ({
            name: v.employee.name,
            present: v.summary.present,
            absent: v.summary.absent,
            leave: v.summary.leave,
            remote: v.summary.wfh,
            lateIns: v.summary.lateIns,
            earlyOuts: v.summary.earlyOuts,
          })),
        ),
      };
    },
  }),

  tool({
    name: 'team_missing_updates',
    label: 'Work updates',
    description:
      "Who in the caller's own team has not sent a daily work update for a date (missed, sent late and awaiting approval, or not yet sent today), with their Daily KPI alerts.",
    input: dateInput,
    allowed: isManager,
    run: async (c, { date }, s) => {
      const kpi = await s.dailyKpi.team(c.employeeId, date);
      return {
        date: kpi.date,
        ...capped(
          kpi.rows
            .filter((r) => r.employed && UPDATE_GAPS.has(r.update.status))
            .map((r) => ({
              name: r.employee.name,
              update: r.update.status,
              recentUpdates: `${r.recentUpdates.done}/${r.recentUpdates.workingDays}`,
              alerts: r.alerts.map((a) => a.title),
            })),
        ),
      };
    },
  }),

  tool({
    name: 'team_goal_progress',
    label: 'Team goals',
    description:
      "This quarter's goals for each person in the caller's reporting chain: goal count, attainment percent, and goals at risk.",
    input: z.object({}),
    allowed: isManager,
    run: async (c, _input, s) =>
      capped(
        (
          await s.performance.teamGoals({
            actorUserId: c.userId,
            actorEmployeeId: c.employeeId,
          })
        ).map((r) => ({
          name: r.employee.name,
          goals: r.goalCount,
          attainment: r.attainment,
          atRisk: r.atRisk,
        })),
      ),
  }),

  tool({
    name: 'team_pending_leave_requests',
    label: 'Leave requests',
    description:
      "Leave and remote-work requests from the caller's team that are still waiting for a decision. Reasons are not included.",
    input: z.object({}),
    allowed: isManager,
    run: async (c, _input, s) =>
      capped(
        (await s.leaves.listTeam(c.employeeId))
          .filter((l) => l.status === 'pending' || l.status === 'partially_approved')
          .map((l) => ({
            name: l.employee.name,
            type: rmLeaveType(l.type),
            from: l.startDate,
            to: l.endDate,
            days: l.days,
            status: l.status,
          })),
      ),
  }),

  tool({
    name: 'org_attendance_summary',
    label: 'Org attendance',
    description:
      'HR: month attendance totals across everyone the caller\'s HR access covers, and the people with the most absences and late check-ins.',
    input: monthInput,
    allowed: (c) => c.hrAttendance !== null,
    run: async (c, { month }, s) => {
      const m = month ?? monthOf(today());
      const views = keep(c.hrAttendance, await s.attendance.orgMonth(m), (v) => v.employee.id);
      const sum = (k: 'present' | 'absent' | 'leave' | 'wfh' | 'lateIns' | 'earlyOuts') =>
        views.reduce((n, v) => n + v.summary[k], 0);
      const top = (k: 'absent' | 'lateIns') =>
        [...views]
          .filter((v) => v.summary[k] > 0)
          .sort((a, b) => b.summary[k] - a.summary[k])
          .slice(0, 10)
          .map((v) => ({ name: v.employee.name, [k]: v.summary[k] }));
      return {
        month: m,
        people: views.length,
        totals: {
          presentDays: sum('present'),
          absentDays: sum('absent'),
          leaveDays: sum('leave'),
          remoteDays: sum('wfh'),
          lateIns: sum('lateIns'),
          earlyOuts: sum('earlyOuts'),
        },
        mostAbsent: top('absent'),
        mostLate: top('lateIns'),
      };
    },
  }),

  tool({
    name: 'org_missing_updates',
    label: 'Org work updates',
    description:
      'HR (org-wide access): everyone without a daily work update for a date, with their department and Daily KPI alerts.',
    input: dateInput,
    allowed: (c) => c.hrPeopleOrg,
    run: async (_c, { date }, s) => {
      const kpi = await s.dailyKpi.org(date);
      return {
        date: kpi.date,
        ...capped(
          kpi.rows
            .filter((r) => r.employed && UPDATE_GAPS.has(r.update.status))
            .map((r) => ({
              name: r.employee.name,
              department: r.employee.department,
              update: r.update.status,
              alerts: r.alerts.map((a) => a.title),
            })),
        ),
      };
    },
  }),

  tool({
    name: 'onboarding_gaps',
    label: 'Onboarding',
    description:
      'HR: onboarding numbers (joined in the last 90 days, in progress, past day 30, done) and recent joiners who have no onboarding journey yet.',
    input: z.object({}),
    allowed: (c) => c.hrPeople !== null,
    run: async (c, _input, s) => {
      const o = await s.onboarding.overview();
      return {
        stats: o.stats,
        noJourney: capped(
          keep(c.hrPeople, o.noJourney, (r) => r.employee.id).map((r) => ({
            name: r.employee.name,
            code: r.employee.employeeCode,
            joining: r.dateOfJoining,
            status: r.status,
          })),
        ),
      };
    },
  }),

  tool({
    name: 'incomplete_records',
    label: 'Incomplete records',
    description:
      'HR: employee records missing intake fields (joining date, department, designation) or with no manager / a manager who has left.',
    input: z.object({}),
    allowed: (c) => c.hrPeople !== null,
    run: async (c, _input, s) =>
      capped(
        keep(c.hrPeople, await s.employees.incomplete(), (r) => r.employee.id).map((r) => ({
          name: r.employee.name,
          code: r.employee.employeeCode,
          missing: r.missing,
          manager: r.managerIssue,
        })),
      ),
  }),

  tool({
    name: 'concern_queue_counts',
    label: 'Concern counts',
    description:
      'Counts only for the concern queues the caller handles: open, overdue, unassigned, by severity. Never titles, names, or contents.',
    input: z.object({}),
    allowed: isEither,
    run: async (c, _input, s) =>
      (await s.concerns.queues(c.employeeId)).map((q) => ({
        queue: q.label,
        open: q.open,
        overdue: q.overdue,
        unassigned: q.unassigned,
        bySeverity: q.bySeverity,
        closedThisQuarter: q.closedThisQuarter,
      })),
  }),

  tool({
    name: 'policy_search',
    label: 'Policies',
    description:
      "Search the company's live policies by words in their title, code, category and summary. Returns the best matches with the summary; the full document is on the Policies page.",
    input: z.object({ query: z.string().trim().min(2).max(100) }),
    allowed: isEither,
    run: async (_c, { query }, s) => {
      const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
      const scored = (await s.policies.list())
        .map((p) => {
          const hay = `${p.title} ${p.code} ${p.category ?? ''} ${p.summary ?? ''}`.toLowerCase();
          return { p, score: words.filter((w) => hay.includes(w)).length };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
      return {
        matches: scored.map(({ p }) => ({
          title: p.title,
          code: p.code,
          version: p.version,
          effectiveFrom: p.effectiveFrom,
          summary: p.summary,
          link: p.docUrl,
        })),
        where: 'Full documents: My policies page',
      };
    },
  }),

  tool({
    name: 'holidays',
    label: 'Holidays',
    description: "The company's holiday list for a year.",
    input: z.object({
      year: z.number().int().min(2020).max(2100).optional().describe('defaults to this year'),
    }),
    allowed: isEither,
    run: async (_c, { year }, s) =>
      (await s.attendance.listHolidays(year ?? new Date().getFullYear())).map((h) => ({
        date: h.date,
        name: h.name,
      })),
  }),
];
