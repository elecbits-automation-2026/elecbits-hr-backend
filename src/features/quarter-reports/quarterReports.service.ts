import createError from 'http-errors';
import { addMonthsIso } from '../../shared/helpers/helpers.js';
import { reachesIn, type PeopleScope } from '../access/index.js';
import type { AttendanceService } from '../attendance/attendance.service.js';
import { attainmentOf, categoryAttainment, quarterOf } from '../performance/index.js';
import type {
  ActorContext,
  CycleRow,
  QuarterReportInsert,
  QuarterReportsRepository,
} from './quarterReports.repository.js';
import type {
  AdjustScoreInput,
  Band,
  QuarterCycleDto,
  QuarterReportDto,
  QuarterViewDto,
  TeamOverviewDto,
} from './quarterReports.schema.js';

const DAY_MS = 86_400_000;
const LINK = '/performance';

/**
 * CGP bands (Performance & Appraisal Policy §5/§9, user decision on the gap):
 * E3 85–100, E2 70–85, E1 50–70, below expectations under 50.
 */
export const bandOf = (score: number | null): Band | null => {
  if (score === null) return null;
  if (score >= 85) return 'E3';
  if (score >= 70) return 'E2';
  if (score >= 50) return 'E1';
  return 'below';
};

/** '2026-Q4' -> its dates; anything else is a 400. */
const cycleDates = (name: string) => {
  const m = /^(\d{4})-Q([1-4])$/.exec(name);
  if (!m)
    throw createError(400, 'Quarter names look like 2026-Q4', { code: 'BAD_QUARTER' });
  const y = Number(m[1]);
  const q = Number(m[2]);
  const startMonth = (q - 1) * 3 + 1;
  const endMonth = q * 3;
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    startDate: `${y}-${pad(startMonth)}-01`,
    endDate: `${y}-${pad(endMonth)}-${new Date(y, endMonth, 0).getDate()}`,
    months: [0, 1, 2].map((i) => `${y}-${pad(startMonth + i)}`),
  };
};

type ReportRow = Awaited<ReturnType<QuarterReportsRepository['listReports']>>[number];

const toReport = (r: ReportRow): QuarterReportDto => ({
  id: r.report.id,
  cycleName: r.cycleName,
  employee: {
    id: r.report.employeeId,
    name: r.employeeName,
    employeeCode: r.employeeCode,
  },
  rm: r.report.rmId && r.rmName ? { id: r.report.rmId, name: r.rmName } : null,
  departmentName: r.report.departmentName,
  goals: r.report.goals as QuarterReportDto['goals'],
  byCategory: {
    fundamental: r.report.fundamental,
    corporate: r.report.corporate,
    general: r.report.general,
  },
  computedScore: r.report.computedScore,
  computedBand: r.report.computedBand as Band | null,
  finalScore: r.report.finalScore,
  finalBand: r.report.finalBand as Band | null,
  adjustReason: r.report.adjustReason,
  adjustedByName: r.adjustedByName,
  adjustedAt: r.report.adjustedAt?.toISOString() ?? null,
  updates: r.report.updates as QuarterReportDto['updates'],
  attendance: r.report.attendance as QuarterReportDto['attendance'],
  recognitions: r.report.recognitions,
  feedback: r.report.feedback as QuarterReportDto['feedback'],
  atRiskGoals: r.report.atRiskGoals,
  pipCandidate: r.report.pipCandidate,
  appraisalEligible: r.report.appraisalEligible,
});

const overviewOf = (reports: QuarterReportDto[]): TeamOverviewDto[] => {
  const groups = new Map<string, QuarterReportDto[]>();
  for (const r of reports) {
    const key = r.rm?.id ?? '';
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.values()].map((rows) => {
    const scored = rows.filter((r) => r.finalScore !== null);
    const count = (b: Band) => rows.filter((r) => r.finalBand === b).length;
    return {
      rm: rows[0]!.rm,
      people: rows.length,
      averageScore: scored.length
        ? Math.round(scored.reduce((a, r) => a + r.finalScore!, 0) / scored.length)
        : null,
      bands: {
        E3: count('E3'),
        E2: count('E2'),
        E1: count('E1'),
        below: count('below'),
        unscored: rows.length - scored.length,
      },
    };
  });
};

/**
 * Quarter reports (refinement plan, Phase 4 — CGP Performance & Appraisal
 * Policy). HR (hrbp.people update, org) closes a quarter: goals freeze and one
 * report per person is written from the record — goals by category and the
 * computed score/band, work-update discipline, attendance, recognition,
 * notes, at-risk goals, PIP candidacy (score under 50) and appraisal
 * eligibility (six months' service). Nothing is recomputed later. The
 * person's manager at close — or HR whose grant reaches them — may set a
 * final score with a reason; no approval step (user decision).
 */
export const createQuarterReportsService = (deps: {
  repo: QuarterReportsRepository;
  attendance: AttendanceService;
}) => {
  const { repo, attendance } = deps;

  const toCycle = (
    r: Awaited<ReturnType<QuarterReportsRepository['listCycles']>>[number],
  ): QuarterCycleDto => ({
    name: r.cycle.name,
    startDate: r.cycle.startDate,
    endDate: r.cycle.endDate,
    closedAt: r.cycle.closedAt?.toISOString() ?? null,
    closedByName: r.closedByName,
    reportCount: r.reportCount,
    current: r.cycle.name === quarterOf().name,
  });

  const cycles = async (): Promise<QuarterCycleDto[]> => {
    const q = quarterOf();
    await repo.ensureCycle(q.name, q.startDate, q.endDate);
    return (await repo.listCycles()).map(toCycle);
  };

  const requireCycle = async (name: string): Promise<CycleRow> => {
    const dates = cycleDates(name);
    return repo.ensureCycle(name, dates.startDate, dates.endDate);
  };

  /** Close a quarter and write its reports. */
  const close = async (
    name: string,
    early: boolean,
    actor: ActorContext,
  ): Promise<QuarterCycleDto> => {
    const cycle = await requireCycle(name);
    if (cycle.closedAt) {
      throw createError(409, `${name} is already closed`, { code: 'ALREADY_CLOSED' });
    }
    const today = new Date().toLocaleDateString('en-CA');
    if (cycle.startDate > today) {
      throw createError(422, `${name} has not started yet`, { code: 'NOT_STARTED' });
    }
    if (cycle.endDate > today && !early) {
      throw createError(
        409,
        `${name} runs until ${cycle.endDate} — confirm closing it early`,
        {
          code: 'EARLY_CLOSE',
        },
      );
    }
    const closeDate = cycle.endDate < today ? cycle.endDate : today;
    const { months } = cycleDates(name);
    const pastMonths = months.filter((m) => m <= closeDate.slice(0, 7));

    const [people, goalRows, updateDays, missMonths, recognitions, feedback, monthViews] =
      await Promise.all([
        repo.listPeople(cycle.endDate),
        repo.goalsForCycle(cycle.id),
        repo.updateDays(cycle.startDate, closeDate),
        repo.missFlagMonths(months),
        repo.recognitionsBetween(cycle.startDate, closeDate),
        repo.feedbackBetween(cycle.startDate, closeDate),
        Promise.all(pastMonths.map((m) => attendance.orgMonth(m))),
      ]);

    // Attendance across the quarter, up to the close date.
    const att = new Map<
      string,
      {
        working: number;
        present: number;
        wfh: number;
        absent: number;
        leave: number;
        late: number;
      }
    >();
    for (const view of monthViews) {
      for (const person of view) {
        const a = att.get(person.employee.id) ?? {
          working: 0,
          present: 0,
          wfh: 0,
          absent: 0,
          leave: 0,
          late: 0,
        };
        for (const d of person.days) {
          if (d.date < cycle.startDate || d.date > closeDate) continue;
          if (d.status === 'present') a.present += 1;
          else if (d.status === 'wfh') a.wfh += 1;
          else if (d.status === 'half_day') {
            a.present += 0.5;
            a.absent += 0.5;
          } else if (d.status === 'half_leave') {
            a.present += 0.5;
            a.leave += 0.5;
          } else if (d.status === 'absent') a.absent += 1;
          else if (d.status === 'leave') a.leave += 1;
          if (['present', 'wfh', 'half_day', 'half_leave', 'absent'].includes(d.status)) {
            a.working += 1;
          }
          if (d.checkInTiming === 'late') a.late += 1;
        }
        att.set(person.employee.id, a);
      }
    }

    const rows: QuarterReportInsert[] = people.map((p) => {
      const own = goalRows.filter((g) => g.employeeId === p.id);
      const byCat = categoryAttainment(own);
      const score = attainmentOf(own);
      const band = bandOf(score);
      const a = att.get(p.id);
      const worked = a ? a.present + a.wfh : 0;
      return {
        cycleId: cycle.id,
        employeeId: p.id,
        rmId: p.leaveApprover ?? p.reportsTo,
        departmentName: p.departmentName,
        goals: own.map((g) => ({
          title: g.title,
          category: g.category,
          weight: Number(g.weight),
          progress: g.progress,
          target: g.target,
          dueOn: g.dueOn,
        })),
        fundamental: byCat.fundamental,
        corporate: byCat.corporate,
        general: byCat.general,
        computedScore: score,
        computedBand: band,
        finalScore: score,
        finalBand: band,
        updates: {
          expected: a?.working ?? 0,
          submitted: updateDays.get(p.id) ?? 0,
          monthsOverAllowance: missMonths.get(p.id) ?? 0,
        },
        attendance: {
          workingDays: a?.working ?? 0,
          present: a?.present ?? 0,
          wfh: a?.wfh ?? 0,
          absent: a?.absent ?? 0,
          leave: a?.leave ?? 0,
          lateIns: a?.late ?? 0,
          attendancePct:
            a && a.working > 0 ? Math.round((worked / a.working) * 100) : null,
        },
        recognitions: recognitions.get(p.id) ?? 0,
        feedback: feedback.get(p.id) ?? { appreciation: 0, concern: 0 },
        atRiskGoals: own.filter(
          (g) =>
            g.progress < 40 &&
            (Date.parse(g.dueOn) - Date.parse(closeDate)) / DAY_MS < 30,
        ).length,
        pipCandidate: score !== null && score < 50,
        appraisalEligible:
          p.dateOfJoining !== null && addMonthsIso(p.dateOfJoining, 6) <= cycle.endDate,
      };
    });

    const rms = [...new Set(rows.map((r) => r.rmId).filter((id): id is string => !!id))];
    // Poor performance rings the RM, who decides on a PIP (close-out) — no auto start.
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    const pipBells = rows
      .filter((r) => r.pipCandidate && r.rmId)
      .map((r) => ({
        to: [r.rmId!],
        event: {
          type: 'quarter.pip_candidate',
          title: `${name}: ${nameOf.get(r.employeeId) ?? 'someone in your team'} scored below 50 — consider a performance improvement plan`,
          link: '/my-team',
        },
      }));
    const ok = await repo.closeWithReports(cycle.id, rows, actor, [
      ...pipBells,
      {
        to: rows.map((r) => r.employeeId),
        event: {
          type: 'quarter.closed',
          title: `Your ${name} report is ready`,
          link: LINK,
        },
      },
      {
        to: rms,
        event: {
          type: 'quarter.closed',
          title: `${name} reports for your team are ready`,
          body: 'Review the scores and set a final score where needed.',
          link: LINK,
        },
      },
    ]);
    if (!ok)
      throw createError(409, `${name} is already closed`, { code: 'ALREADY_CLOSED' });
    return (await cycles()).find((c) => c.name === name)!;
  };

  /**
   * A quarter's reports the caller may see: their own people (the manager at
   * close) plus whoever their hrbp.people grant reaches.
   */
  const view = async (
    name: string,
    viewerId: string,
    hr: PeopleScope,
  ): Promise<QuarterViewDto> => {
    const cycle = await requireCycle(name);
    const all = (await repo.listReports({ cycleId: cycle.id })).map(toReport);
    const reports = all.filter(
      (r) =>
        r.rm?.id === viewerId ||
        (reachesIn(hr, r.employee.id) && r.employee.id !== viewerId),
    );
    const cycleDto = (await cycles()).find((c) => c.name === name)!;
    return { cycle: cycleDto, reports, teams: overviewOf(reports) };
  };

  /** Own reports, newest quarter first — the CGP transparency rule. */
  const mine = async (employeeId: string): Promise<QuarterReportDto[]> =>
    (await repo.listReports({ employeeId })).map(toReport);

  const adjust = async (
    id: string,
    input: AdjustScoreInput,
    actor: ActorContext,
    hr: PeopleScope,
  ): Promise<QuarterReportDto> => {
    const report = await repo.findReport(id);
    if (!report) throw createError(404, 'Report not found', { code: 'REPORT_NOT_FOUND' });
    if (report.employeeId === actor.actorEmployeeId) {
      throw createError(403, 'You cannot set your own score', {
        code: 'NO_SELF_APPROVAL',
      });
    }
    if (report.rmId !== actor.actorEmployeeId && !reachesIn(hr, report.employeeId)) {
      throw createError(403, "Only this person's manager or HR sets the final score", {
        code: 'NOT_AN_APPROVER',
      });
    }
    const band = bandOf(input.finalScore)!;
    await repo.adjust(
      id,
      { finalScore: input.finalScore, finalBand: band, adjustReason: input.reason },
      actor,
      {
        to: [report.employeeId],
        event: {
          type: 'quarter.adjusted',
          title: `Your quarter score was set to ${input.finalScore} (${band === 'below' ? 'below expectations' : band})`,
          body: input.reason,
          link: LINK,
        },
      },
    );
    const rows = await repo.listReports({ employeeId: report.employeeId });
    return toReport(rows.find((r) => r.report.id === id)!);
  };

  /**
   * One person's reports for their sheet: the person themselves, their
   * current manager, or HR whose grant reaches them see all; a manager at an
   * earlier close sees the quarters they managed.
   */
  const forPerson = async (
    employeeId: string,
    viewerId: string,
    currentRmId: string | null,
    hr: PeopleScope,
  ): Promise<QuarterReportDto[]> => {
    const all = (await repo.listReports({ employeeId })).map(toReport);
    if (viewerId === employeeId || viewerId === currentRmId || reachesIn(hr, employeeId)) {
      return all;
    }
    return all.filter((r) => r.rm?.id === viewerId);
  };

  return { cycles, close, view, mine, adjust, forPerson };
};

export type QuarterReportsService = ReturnType<typeof createQuarterReportsService>;
