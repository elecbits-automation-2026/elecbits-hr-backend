import { z } from 'zod';
import { reachesIn, type PeopleScope } from '../access/authz.repository.js';
import type { AttendanceService } from '../attendance/attendance.service.js';
import type { ConcernsService } from '../concerns/concerns.service.js';
import type { DailyKpiService } from '../daily-kpi/dailyKpi.service.js';
import type { EmployeesService } from '../employees/employees.service.js';
import type { LeavesService } from '../leaves/leaves.service.js';
import type { OnboardingService } from '../onboarding/onboarding.service.js';
import { isAtRisk, type PerformanceService } from '../performance/performance.service.js';
import type { PoliciesService } from '../policies/policies.service.js';
import type { HiringService } from '../hiring/hiring.service.js';
import type { RecognitionsService } from '../recognitions/recognitions.service.js';
import type { ActionablePerson } from './assistant.repository.js';

/**
 * The HR Assistant's read tools — each a thin wrapper over a service
 * the pages already use, so every access rule still holds (design: the model
 * never touches the database). Results are trimmed to names, dates and
 * counts. Deliberately absent: payroll / salary / bank, documents, concern
 * contents, POSH, leave reasons, and leave balances (that read writes accruals).
 * The action tools (phase 2) live in assistant.actions.ts: they only propose.
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
  /** hrbp.policies read at org scope — the same gate as the Policies tracker page. */
  hrPoliciesOrg: boolean;
  /** Reach under hrbp.people update — who HR may set goals / assign trainings for. */
  hrPeopleWrite: PeopleScope | null;
  /** hrbp.people update at org scope — the R&R "broad HR" (nominates the top people). */
  hrPeopleWriteOrg: boolean;
  /** Holds a department-head seat — the hiring plan's author. */
  deptHead: boolean;
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
  recognitions: RecognitionsService;
  hiring: HiringService;
  /** Current people with their relationship to the caller (for name lookups). */
  actionablePeople(employeeId: string): Promise<ActionablePerson[]>;
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
  /** What the audit row records of the input (default: all of it). */
  audit?(input: z.infer<S>): unknown;
}

export type AnyTool = AssistantTool<z.ZodObject>;

export const tool = <S extends z.ZodObject>(t: AssistantTool<S>): AnyTool =>
  t as unknown as AnyTool;

/** Lists the model sees are capped; the total says when more exist. */
const MAX_ROWS = 60;
export const capped = <T>(rows: T[]) => ({
  total: rows.length,
  rows: rows.slice(0, MAX_ROWS),
  ...(rows.length > MAX_ROWS ? { note: `showing the first ${MAX_ROWS}` } : {}),
});

export const today = (): string => new Date().toLocaleDateString('en-CA');
export const monthOf = (date: string): string => date.slice(0, 7);
const plusDays = (date: string, n: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Monday..Sunday around `date`. */
const weekOf = (date: string): string[] => {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const monday = plusDays(date, dow === 0 ? -6 : 1 - dow);
  return Array.from({ length: 7 }, (_, i) => plusDays(monday, i));
};

/** Menstrual leave is confidential to the employee and HR — RMs see "leave". */
export const rmLeaveType = (type: string | null) =>
  type === 'menstrual' ? 'leave' : type;

export const isManager = (c: Caller) => c.manager;
const isHr = (c: Caller) => c.hrPeople !== null || c.hrAttendance !== null;
export const isEither = (c: Caller) => isManager(c) || isHr(c);
export const keep = <T>(
  scope: PeopleScope | null,
  rows: T[],
  personOf: (r: T) => string,
) => (scope === null ? [] : rows.filter((r) => reachesIn(scope, personOf(r))));

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

/**
 * Today across the team. Absent is only decided once a day is over, so a
 * person with no check-in today is "not checked in yet" — never present and
 * never absent (the model must not read silence as presence).
 */
const todayPicture = (
  views: Array<{
    employee: { name: string };
    days: Array<{
      date: string;
      status: string;
      checkInAt: string | null;
      checkOutAt: string | null;
      holidayName: string | null;
      leaveType: string | null;
    }>;
  }>,
  t: string,
) => {
  const rows = views.flatMap((v) => {
    const d = v.days.find((x) => x.date === t);
    return d ? [{ name: v.employee.name, d }] : [];
  });
  const off = rows.find((r) => r.d.status === 'holiday' || r.d.status === 'weekend')?.d;
  const dayType = off?.status === 'holiday' ? 'holiday' : off ? 'weekend' : 'working';
  return {
    date: t,
    dayType,
    ...(off?.holidayName ? { holiday: off.holidayName } : {}),
    // User decision (23 Nov): names only, never check-in / check-out times,
    // so the assistant can't be used to track when people arrive or leave.
    checkedIn: rows
      .filter((r) => r.d.checkInAt)
      .map((r) => ({ name: r.name, remote: r.d.status === 'wfh' })),
    away: rows
      .filter((r) => !r.d.checkInAt && OUT_STATUSES.has(r.d.status))
      .map((r) => ({
        name: r.name,
        status: r.d.status,
        leaveType: rmLeaveType(r.d.leaveType),
      })),
    // Weekends and holidays expect nobody in.
    notCheckedInYet:
      dayType === 'working'
        ? rows.filter((r) => !r.d.checkInAt && r.d.status === 'none').map((r) => r.name)
        : [],
  };
};

/**
 * People whose name matches a typed one: every word first ("rahul verma"),
 * then any longer word so a typo ("kiran roa") still finds the person.
 */
export const matchPeople = <T extends { name: string }>(
  rows: T[],
  query: string,
): T[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const all = rows.filter((r) => words.every((w) => r.name.toLowerCase().includes(w)));
  return all.length
    ? all
    : rows.filter((r) =>
        words.some((w) => w.length > 2 && r.name.toLowerCase().includes(w)),
      );
};

/** Work-update strip statuses that need a nudge. */
const UPDATE_GAPS = new Set(['missed', 'late_pending', 'today']);

export const TOOLS: AnyTool[] = [
  tool({
    name: 'team_who_is_out',
    label: "Who's out",
    description:
      "The caller's own team (direct and leave-approver reports): who is away (leave, half-day leave, remote, absent) today or this week, plus approved leave in that week. For today it also says who has checked in (names only, no times) and who has not checked in yet, and whether today is a working day, weekend or holiday. Leave type 'menstrual' is never shown.",
    input: z.object({ period: z.enum(['today', 'this_week']).default('today') }),
    allowed: isManager,
    run: async (c, { period }, s) => {
      const t = today();
      const dates = period === 'today' ? [t] : weekOf(t);
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
      return {
        period,
        dates: { from: first, to: last },
        out,
        approvedLeave: upcoming,
        today: todayPicture(views, t),
      };
    },
  }),

  tool({
    name: 'org_who_is_out',
    label: "Who's out (org)",
    description:
      "HR: today across everyone the caller's HR attendance access covers — who is away (leave, half-day leave, remote, absent), who has checked in (names only, no times), and who has not checked in yet, and whether today is a working day, weekend or holiday. Leave type 'menstrual' is never shown.",
    input: z.object({}),
    allowed: (c) => c.hrAttendance !== null,
    run: async (c, _input, s) => {
      const t = today();
      const views = keep(
        c.hrAttendance,
        await s.attendance.orgMonth(monthOf(t)),
        (v) => v.employee.id,
      );
      const p = todayPicture(views, t);
      return {
        ...p,
        checkedIn: capped(p.checkedIn),
        away: capped(p.away),
        notCheckedInYet: capped(p.notCheckedInYet),
      };
    },
  }),

  tool({
    name: 'team_attendance_summary',
    label: 'Team attendance',
    description:
      "Month attendance counts for each person in the caller's own team: present, absent, leave, remote. Late check-ins and early check-outs are not available here (Attendance page).",
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
    name: 'person_goals',
    label: 'Goals',
    description:
      "One person's goals this quarter, goal by goal: title, category, metric and target, weight, progress, due date and whether it is at risk, plus overall attainment and their department KPI. Only for people in the caller's reporting chain or within the caller's HR access.",
    input: z.object({
      person: z.string().trim().min(2).max(80).describe('a name; partial is fine'),
    }),
    allowed: isEither,
    run: async (c, { person }, s) => {
      const actor = { actorUserId: c.userId, actorEmployeeId: c.employeeId };
      // Who the caller may ask about: their chain, plus whoever their HR grant reaches.
      const [chain, everyone] = await Promise.all([
        c.manager ? s.performance.teamGoals(actor) : Promise.resolve([]),
        c.hrPeople ? s.employees.list() : Promise.resolve([]),
      ]);
      const pool = new Map<string, { id: string; name: string }>();
      for (const r of chain)
        pool.set(r.employee.id, { id: r.employee.id, name: r.employee.name });
      for (const e of keep(c.hrPeople, everyone, (x) => x.id)) {
        if (e.status !== 'inactive') pool.set(e.id, { id: e.id, name: e.name });
      }
      const found = matchPeople([...pool.values()], person);
      if (found.length === 0)
        return { note: 'No one by that name within your team or HR access' };
      if (found.length > 1) {
        return {
          note: 'More than one person matches — ask which one',
          matches: found.slice(0, 8).map((p) => p.name),
        };
      }
      const target = found[0]!;
      // The service's own RM-or-HR check runs here too, as on the person sheet.
      const g = await s.performance.teamMemberGoals(target.id, actor);
      const t = today();
      return {
        name: target.name,
        cycle: g.cycle.name,
        cycleEnds: g.cycle.endDate,
        attainment: g.attainment,
        weightTotal: g.weightTotal,
        departmentKpi: g.departmentKpi,
        goals: g.goals.map((x) => ({
          title: x.title,
          category: x.category,
          metric: x.metric,
          target: x.target,
          weight: x.weight,
          progress: x.progress,
          due: x.dueOn,
          atRisk: isAtRisk(x, t),
        })),
      };
    },
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
      "HR: month attendance totals across everyone the caller's HR access covers, and the people with the most absences. Late check-ins and early check-outs are not available here (Attendance page).",
    input: monthInput,
    allowed: (c) => c.hrAttendance !== null,
    run: async (c, { month }, s) => {
      const m = month ?? monthOf(today());
      const views = keep(
        c.hrAttendance,
        await s.attendance.orgMonth(m),
        (v) => v.employee.id,
      );
      const sum = (k: 'present' | 'absent' | 'leave' | 'wfh') =>
        views.reduce((n, v) => n + v.summary[k], 0);
      // User decision (23 Nov): no late / early counts reach the model —
      // timing data stays on the Attendance page.
      return {
        month: m,
        people: views.length,
        totals: {
          presentDays: sum('present'),
          absentDays: sum('absent'),
          leaveDays: sum('leave'),
          remoteDays: sum('wfh'),
        },
        mostAbsent: [...views]
          .filter((v) => v.summary.absent > 0)
          .sort((a, b) => b.summary.absent - a.summary.absent)
          .slice(0, 10)
          .map((v) => ({ name: v.employee.name, absent: v.summary.absent })),
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
        keep(c.hrPeople, await s.employees.incomplete(), (r) => r.employee.id).map(
          (r) => ({
            name: r.employee.name,
            code: r.employee.employeeCode,
            missing: r.missing,
            manager: r.managerIssue,
          }),
        ),
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
      const words = query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 1);
      const scored = (await s.policies.list())
        .map((p) => {
          const hay =
            `${p.title} ${p.code} ${p.category ?? ''} ${p.summary ?? ''}`.toLowerCase();
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
    name: 'policy_acknowledgements',
    label: 'Policy sign-offs',
    description:
      "HR: who has acknowledged the policies that need it (the Policies tracker). With a person's name: each policy's state for them — acknowledged (version and date), needs to re-acknowledge a newer version, or never acknowledged. Without a name: signed counts per policy and the people with anything missing.",
    input: z.object({
      person: z
        .string()
        .trim()
        .min(2)
        .max(80)
        .optional()
        .describe('a name; partial is fine'),
      onlyMissing: z.boolean().optional().describe('list only what is not up to date'),
    }),
    allowed: (c) => c.hrPoliciesOrg,
    run: async (_c, { person, onlyMissing }, s) => {
      const tracker = await s.policies.tracker();
      const titleOf = new Map(
        tracker.policies.map((p) => [p.id, `${p.title} (v${p.version})`]),
      );
      const STATE = {
        ok: 'acknowledged',
        stale: 'needs to re-acknowledge the new version',
        none: 'not acknowledged',
      };
      if (person) {
        const found = matchPeople(
          tracker.rows.map((r) => ({ ...r, name: r.employee.name })),
          person,
        );
        return {
          policiesNeedingAcknowledgement: tracker.policies.length,
          people: found.slice(0, 5).map((r) => {
            const cells = r.cells.filter((c) => !onlyMissing || c.state !== 'ok');
            return {
              name: r.employee.name,
              department: r.employee.department,
              done: `${r.cells.filter((c) => c.state === 'ok').length} of ${r.cells.length}`,
              policies: cells.map((c) => ({
                policy: titleOf.get(c.policyId),
                state: STATE[c.state],
                ...(c.ackedAt
                  ? { acknowledged: `v${c.ackedVersion} on ${c.ackedAt.slice(0, 10)}` }
                  : {}),
              })),
            };
          }),
          ...(found.length === 0 ? { note: 'No active person matches that name' } : {}),
        };
      }
      return {
        perPolicy: tracker.policies.map((p) => ({
          policy: titleOf.get(p.id),
          signed: `${tracker.rows.filter((r) => r.cells.some((c) => c.policyId === p.id && c.state === 'ok')).length} of ${tracker.rows.length}`,
        })),
        missing: capped(
          tracker.rows
            .map((r) => ({
              name: r.employee.name,
              missing: r.cells
                .filter((c) => c.state !== 'ok')
                .map((c) => `${titleOf.get(c.policyId)}: ${STATE[c.state]}`),
            }))
            .filter((r) => r.missing.length > 0),
        ),
      };
    },
  }),

  tool({
    name: 'holidays',
    label: 'Holidays',
    description: "The company's holiday list for a year.",
    input: z.object({
      year: z
        .number()
        .int()
        .min(2020)
        .max(2100)
        .optional()
        .describe('defaults to this year'),
    }),
    allowed: isEither,
    run: async (_c, { year }, s) =>
      (await s.attendance.listHolidays(year ?? new Date().getFullYear())).map((h) => ({
        date: h.date,
        name: h.name,
      })),
  }),
];
