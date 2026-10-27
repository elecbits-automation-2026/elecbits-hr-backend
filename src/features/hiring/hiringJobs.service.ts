import { addDaysIso, localDateOf } from '../../shared/helpers/helpers.js';
import { quarterOf } from '../performance/index.js';
import type { SettingsReader } from '../settings/index.js';
import type { HiringRepository, PositionStatus } from './hiring.repository.js';
import { POSITION_PROGRESS, planningQuarter } from './hiring.service.js';
import type { HiringJobsRepository, QuarterlyBell } from './hiringJobs.repository.js';

const LINK_PLAN = '/hiring/plan';
const LINK_APPROVALS = '/hiring/approvals';
const LINK_ADMIN_APPROVALS = '/admin/hiring-approvals';

/** The quarter after the one containing `today`, with its first day. */
const nextQuarter = (today: string) => {
  const q = quarterOf(new Date(`${today}T00:00:00`));
  const start = addDaysIso(q.endDate, 1);
  return { ...quarterOf(new Date(`${start}T00:00:00`)), start };
};

const longDate = (iso: string) =>
  new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

/**
 * The hiring scheduled jobs (TA Step F), run daily by the scheduler:
 *
 *  - plan window: N days before a quarter starts every department head is
 *    reminded (once) to add that quarter's needs by the deadline. Submitted
 *    lines wait (queued); once the deadline passes they ALL go to the HR
 *    head and Admin together, and drafts left behind move to the next
 *    quarter's plan (late lines wait a quarter; urgent needs use Urgent hire).
 *  - talent-pool retention: candidates 6 months past their last
 *    consideration, with nothing in play and never hired, are anonymised.
 *  - goal carry-over: a position still being worked gets its recruiter's
 *    hiring goal in the CURRENT quarter (same weight, progress from its
 *    stage). The earlier quarter's goal stays as it was (frozen when HR
 *    closes that quarter).
 */
export const createHiringJobsService = (deps: {
  repo: HiringJobsRepository;
  hiring: HiringRepository;
  settings: SettingsReader;
}) => {
  const { repo, hiring, settings } = deps;

  const planWindow = async (now: Date): Promise<Record<string, number>> => {
    const today = localDateOf(now);
    const window = await settings.effective('hiring.planWindow');

    // Closed plans first — every day, so a missed run can't strand lines.
    const planning = planningQuarter(today, window).quarter;
    const h = await hiring.approverHolders(
      (await settings.effective('hiring.hrDepartment')).departmentId,
    );
    const closed = await repo.releasePlans(planning, (rows) => {
      if (rows.length === 0) return [];
      const quarters = [...new Set(rows.map((r) => r.quarter))].sort().join(', ');
      const title = `${rows.length} hiring line(s) for ${quarters} are waiting for your approval`;
      const perHead = new Map<string, number>();
      for (const r of rows) {
        if (r.submitted_by) perHead.set(r.submitted_by, (perHead.get(r.submitted_by) ?? 0) + 1);
      }
      return [
        ...(h.hr_head ? [{ to: [h.hr_head], type: 'hiring.plan_due', title, link: LINK_APPROVALS }] : []),
        ...(h.admin ? [{ to: [h.admin], type: 'hiring.plan_due', title, link: LINK_ADMIN_APPROVALS }] : []),
        ...[...perHead].map(([head, n]) => ({
          to: [head],
          type: 'hiring.plan_sent',
          title: `${n} of your hiring line(s) for ${quarters} went to the HR head and Admin`,
          link: LINK_PLAN,
        })),
      ];
    });

    const next = nextQuarter(today);
    const remindOn = addDaysIso(next.start, -window.remindDaysBefore);
    const deadline = addDaysIso(next.start, -window.deadlineDaysBefore);
    if (today < remindOn || today > deadline) return { ...closed, reminded: 0 };

    const bells: QuarterlyBell[] = [];
    let reminded = 0;
    {
      for (const h of await repo.headsNotSent(`hiring_plan:${next.name}`)) {
        bells.push({
          kind: `hiring_plan:${next.name}`,
          subjectId: h.department_id,
          recipientId: h.head_id,
          type: 'hiring.plan_window',
          title: `Add ${h.department_name}'s hiring needs for ${next.name} by ${longDate(deadline)}`,
          link: LINK_PLAN,
        });
        reminded += 1;
      }
    }
    await repo.sendBells(bells);
    return { ...closed, reminded };
  };

  const retention = async (now: Date): Promise<Record<string, number>> => {
    const ids = await repo.expiredCandidateIds(localDateOf(now));
    return { anonymised: await repo.anonymise(ids) };
  };

  const carryOver = async (now: Date): Promise<Record<string, number>> => {
    const q = quarterOf(now);
    const cycle = await repo.ensureCycle(q.name, q.startDate, q.endDate);
    if (cycle.closed_at) return { carried: 0 };
    const rows = await repo.positionsWithoutGoal(cycle.id);
    const carried = await repo.insertCarryOver(
      { id: cycle.id, endDate: cycle.end_date, name: q.name },
      rows.map((r) => ({
        positionId: r.position_id,
        recruiterId: r.recruiter_id,
        title: r.title,
        weight: r.weight,
        progress: POSITION_PROGRESS[r.status as PositionStatus] ?? 0,
      })),
    );
    return { carried };
  };

  return { planWindow, retention, carryOver };
};

export type HiringJobsService = ReturnType<typeof createHiringJobsService>;
