import createError from 'http-errors';
import type { AttendanceService } from '../attendance/attendance.service.js';
import type { PerformanceService } from '../performance/performance.service.js';
import type { SettingsReader } from '../settings/index.js';
import type { DailyKpiRepository, KpiPerson } from './dailyKpi.repository.js';
import type { ALERT_CODES, DailyKpiDto, DailyKpiRowDto } from './dailyKpi.schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const localDate = (d = new Date()): string => d.toLocaleDateString('en-CA');
/** How far back the day picker may go. */
const MAX_DAYS_BACK = 60;

const WORKING = new Set(['done', 'missed', 'late_pending', 'late_approved']);
const WRITTEN = new Set(['done', 'late_approved']);

type Alert = { code: (typeof ALERT_CODES)[number]; title: string };

/**
 * The Daily KPI page (learner, 2026-11-16): nothing is typed in — each
 * person's day is read from attendance, work updates and goals and held
 * against their department's targets (Settings → People → Department KPI
 * targets). Six alert rules, applied only to days on or after joining:
 *  - no work update on a past working day;
 *  - absent on a past day with no approved leave;
 *  - worked under the short-day limit (attendance hour rules);
 *  - more than half the quarter's goals at risk;
 *  - updates on fewer of the last 7 working days than the target (needs 3+);
 *  - past mid-quarter, goal attainment under the target.
 * Leave types are never shown (menstrual leave stays confidential).
 */
export const createDailyKpiService = (deps: {
  repo: DailyKpiRepository;
  attendance: AttendanceService;
  performance: PerformanceService;
  settings: SettingsReader;
}) => {
  const { repo, attendance, performance, settings } = deps;

  const resolveDate = (date: string | undefined): string => {
    const today = localDate();
    const d = date ?? today;
    const oldest = localDate(new Date(Date.now() - MAX_DAYS_BACK * DAY_MS));
    if (d > today) {
      throw createError(422, 'A day that has not happened yet has no record', {
        code: 'FUTURE_DATE',
      });
    }
    if (d < oldest) {
      throw createError(422, `Pick a day within the last ${MAX_DAYS_BACK} days`, {
        code: 'TOO_OLD',
      });
    }
    return d;
  };

  const build = async (people: KpiPerson[], date: string): Promise<DailyKpiDto> => {
    const today = localDate();
    const ids = people.map((p) => p.id);
    const who = people.map((p) => ({ id: p.id, name: p.name, employeeCode: p.employeeCode }));
    // The 7-day hours window can start in the previous month.
    const weekStart = localDate(new Date(Date.parse(`${date}T12:00:00`) - 6 * DAY_MS));
    const crosses = weekStart.slice(0, 7) !== date.slice(0, 7);
    const [months, before, perf, targets, rules] = await Promise.all([
      attendance.peopleMonth(who, date.slice(0, 7)),
      crosses ? attendance.peopleMonth(who, weekStart.slice(0, 7)) : Promise.resolve([]),
      performance.dailyKpiInputs(ids, date),
      settings.effective('performance.departmentTargets'),
      settings.effective('attendance.hourRules'),
    ]);
    const { cycle } = perf;
    const mid =
      Date.parse(cycle.startDate) +
      (Date.parse(cycle.endDate) - Date.parse(cycle.startDate)) / 2;
    const pastMidQuarter = Date.parse(date) >= mid;

    const rows = people.map((p): DailyKpiRowDto => {
      const day = months
        .find((m) => m.employee.id === p.id)
        ?.days.find((d) => d.date === date);
      const inputs = perf.people.get(p.id);
      const strip = inputs?.strip ?? [];
      const update = strip.find((s) => s.date === date)?.status ?? 'today';
      const employed = update !== 'not_joined';
      const own = targets.departments.find((t) => t.departmentId === p.departmentId);
      const target = {
        kpi: own?.kpi || null,
        updatesOnTimePct: own?.updatesOnTimePct ?? targets.updatesOnTimePct,
        attainmentPct: own?.attainmentPct ?? targets.attainmentPct,
      };
      const recent = strip
        .filter((s) => s.date < date && WORKING.has(s.status))
        .slice(-7);
      const recentUpdates = {
        done: recent.filter((s) => WRITTEN.has(s.status)).length,
        workingDays: recent.length,
      };
      const goals = inputs?.goals ?? { count: 0, atRisk: 0, attainment: null };
      // Average hours over the 7 days up to the date (days with hours only).
      const week = [...before, ...months]
        .filter((m) => m.employee.id === p.id)
        .flatMap((m) => m.days)
        .filter((d) => d.date >= weekStart && d.date <= date && d.workedHours !== null)
        .map((d) => d.workedHours as number);
      const recentHours = {
        avg: week.length
          ? Math.round((week.reduce((n, h) => n + h, 0) / week.length) * 10) / 10
          : null,
        days: week.length,
      };
      const status = day?.status ?? 'none';
      const worked = day?.workedHours ?? null;

      const alerts: Alert[] = [];
      if (employed) {
        if (update === 'missed')
          alerts.push({ code: 'no_update', title: 'No work update' });
        if (status === 'absent' && date < today) {
          alerts.push({ code: 'absent', title: 'Absent with no approved leave' });
        }
        if (
          (status === 'present' || status === 'wfh') &&
          day?.checkOutAt &&
          worked !== null &&
          worked < rules.shortDayBelowHours
        ) {
          alerts.push({
            code: 'short_day',
            title: `Worked ${worked}h — under ${rules.shortDayBelowHours}h`,
          });
        }
        if (goals.count > 0 && goals.atRisk * 2 > goals.count) {
          alerts.push({
            code: 'goals_at_risk',
            title: `${goals.atRisk} of ${goals.count} goals at risk`,
          });
        }
        if (
          recentUpdates.workingDays >= 3 &&
          (recentUpdates.done / recentUpdates.workingDays) * 100 < target.updatesOnTimePct
        ) {
          alerts.push({
            code: 'updates_below_target',
            title: `Updates on ${recentUpdates.done} of the last ${recentUpdates.workingDays} working days — target ${target.updatesOnTimePct}%`,
          });
        }
        if (
          pastMidQuarter &&
          goals.attainment !== null &&
          goals.attainment < target.attainmentPct
        ) {
          alerts.push({
            code: 'attainment_below_target',
            title: `Goal attainment ${goals.attainment}% — target ${target.attainmentPct}% past mid-quarter`,
          });
        }
      }

      return {
        employee: {
          id: p.id,
          name: p.name,
          employeeCode: p.employeeCode,
          department: p.departmentName,
        },
        employed,
        attendance: {
          status,
          checkInAt: day?.checkInAt ?? null,
          checkOutAt: day?.checkOutAt ?? null,
          workedHours: worked,
          holidayName: day?.holidayName ?? null,
          remote: day?.source === 'remote',
        },
        update: { status: update, score: inputs?.score ?? null },
        strip: strip.slice(-7),
        recentUpdates,
        recentHours,
        goals,
        targets: target,
        alerts,
      };
    });

    return { date, shortDayBelowHours: rules.shortDayBelowHours, cycle, rows };
  };

  const mine = async (employeeId: string, date?: string) => {
    const person = await repo.person(employeeId);
    if (!person)
      throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
    return build([person], resolveDate(date));
  };

  /** Worst first: most alerts, then name. */
  const sorted = (dto: DailyKpiDto): DailyKpiDto => ({
    ...dto,
    rows: [...dto.rows].sort(
      (a, b) =>
        b.alerts.length - a.alerts.length ||
        a.employee.name.localeCompare(b.employee.name),
    ),
  });

  const team = async (rmId: string, date?: string) =>
    sorted(await build(await repo.team(rmId), resolveDate(date)));

  const org = async (date?: string) =>
    sorted(await build(await repo.org(), resolveDate(date)));

  return { mine, team, org };
};

export type DailyKpiService = ReturnType<typeof createDailyKpiService>;
