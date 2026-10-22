import createError from 'http-errors';
import { env } from '../../config/env.js';
import {
  APPROVAL_REMINDERS,
  RETURN_REMINDERS,
} from '../../shared/constants/constants.js';
import {
  addDaysIso,
  isWeekendDay,
  localDateOf,
  workingDaysBetween,
} from '../../shared/helpers/helpers.js';
import type { AuthzRepository } from '../access/authz.repository.js';
import type { ConcernsService } from '../concerns/index.js';
import type { ExitsService } from '../exits/index.js';
import type { OpenDoorService } from '../open-door/index.js';
import type { ProbationService } from '../probation/index.js';
import type { PipService } from '../pip/index.js';
import type { SettingsReader } from '../settings/index.js';
import type { JobRunRow, JobsRepository, ReminderToSend } from './jobs.repository.js';
import type { JobDto, JobRunDto } from './jobs.schema.js';

/** Re-exported for callers that imported it from here. */
export { workingDaysBetween };

const localDate = localDateOf;
const addDays = addDaysIso;

const toRun = (r: JobRunRow): JobRunDto => ({
  id: r.id,
  job: r.job,
  runKey: r.runKey,
  status: r.status as JobRunDto['status'],
  attempts: r.attempts,
  startedAt: r.startedAt.toISOString(),
  finishedAt: r.finishedAt?.toISOString() ?? null,
  summary: (r.summary as Record<string, unknown> | null) ?? null,
  error: r.error,
});

/**
 * Background jobs (end-of-pass scheduler). Each job says when it is due and
 * what one run does; the scheduler ticks, the job-run table makes each run
 * happen once across instances, and Admin can run a job by hand.
 *
 * approval-reminders (Phase 0 bell sources "aging approvals" + "stale
 * nominations", user decision): every request still waiting on someone rings
 * that person's bell after APPROVAL_REMINDERS.afterWorkingDays (2) working
 * days, then every repeatEveryWorkingDays (2) until decided. The clock starts
 * when the item last moved (raised, or its previous step decided). Never to
 * the requester; self-governed people's requests never wait.
 */
export const createJobsService = (deps: {
  repo: JobsRepository;
  authz: AuthzRepository;
  settings: SettingsReader;
  concerns: ConcernsService;
  openDoor: Pick<OpenDoorService, 'unanswered'>;
  exits: ExitsService;
  probation: ProbationService;
  pip: PipService;
}) => {
  const { repo, authz, settings, concerns, openDoor, exits, probation, pip } = deps;

  const approvalReminders = async (now: Date): Promise<Record<string, number>> => {
    const today = localDate(now);
    const rules = APPROVAL_REMINDERS;
    const [workWeek, last] = await Promise.all([
      settings.effective('attendance.workWeek'),
      repo.lastReminders(),
    ]);
    const holidays = await repo.holidaysBetween(addDays(today, -400), today);
    const days = (fromIso: string) =>
      workingDaysBetween(fromIso, today, workWeek, holidays);

    const holderCache = new Map<string, string[]>();
    const holders = async (moduleKey: string, action: 'update', subjectId?: string) => {
      const key = `${moduleKey}:${subjectId ?? ''}`;
      if (!holderCache.has(key)) {
        holderCache.set(key, await authz.listBroadHolders(moduleKey, action, subjectId));
      }
      return holderCache.get(key)!;
    };

    const out: ReminderToSend[] = [];
    const counts: Record<string, number> = {};
    let waiting = 0;

    /** Queue one item for each of its approvers whose turn has come. */
    const consider = (
      kind: string,
      subjectId: string,
      ownerId: string,
      since: Date,
      label: string,
      approvers: Array<{ id: string; link: string }>,
    ) => {
      waiting += 1;
      const waited = days(localDate(since));
      const seen = new Set<string>();
      for (const a of approvers) {
        if (a.id === ownerId || seen.has(a.id)) continue;
        seen.add(a.id);
        const lastSent = last.get(`${kind}:${subjectId}:${a.id}`);
        const due = lastSent
          ? days(localDate(lastSent)) >= rules.repeatEveryWorkingDays
          : waited >= rules.afterWorkingDays;
        if (!due) continue;
        out.push({
          kind,
          subjectId,
          recipientId: a.id,
          title: `Reminder: ${label} has waited ${waited} working day${waited === 1 ? '' : 's'}`,
          link: a.link,
        });
        counts[kind] = (counts[kind] ?? 0) + 1;
      }
    };

    const range = (a: string, b: string) => (a === b ? a : `${a} – ${b}`);

    for (const l of await repo.pendingLeaves()) {
      const approvers = [
        ...(l.rm_open && l.effective_rm
          ? [{ id: l.effective_rm, link: '/team-leaves' }]
          : []),
        ...(l.hr_open
          ? (await holders('hrbp.leaves', 'update', l.employee_id)).map((id) => ({
              id,
              link: '/hr/leaves',
            }))
          : []),
      ];
      // The leave type is never named — menstrual leave is confidential.
      consider(
        'leave',
        l.id,
        l.employee_id,
        l.since,
        `${l.name}'s leave (${range(l.start_date, l.end_date)})`,
        approvers,
      );
    }

    for (const w of await repo.pendingRemoteWork()) {
      const approvers = [
        ...(w.rm_open && w.effective_rm
          ? [{ id: w.effective_rm, link: '/team-attendance' }]
          : []),
        ...(w.hr_open
          ? (await holders('hrbp.attendance', 'update', w.employee_id)).map((id) => ({
              id,
              link: '/hr/attendance',
            }))
          : []),
      ];
      consider(
        'remote_work',
        w.id,
        w.employee_id,
        w.since,
        `${w.name}'s remote-work request (${range(w.start_date, w.end_date)})`,
        approvers,
      );
    }

    for (const r of await repo.pendingRegularizations()) {
      const approvers = r.effective_rm
        ? [{ id: r.effective_rm, link: '/team-attendance' }]
        : (await holders('hrbp.attendance', 'update', r.employee_id)).map((id) => ({
            id,
            link: '/hr/attendance',
          }));
      consider(
        'regularization',
        r.id,
        r.employee_id,
        r.since,
        `${r.name}'s attendance fix for ${r.date}`,
        approvers,
      );
    }

    for (const c of await repo.pendingReimbursements()) {
      const amount = `₹${Number(c.amount).toLocaleString('en-IN')}`;
      const approvers =
        c.status === 'pending_rm'
          ? c.effective_rm
            ? [{ id: c.effective_rm, link: '/reimbursements' }]
            : []
          : (await holders('pr.payroll', 'update')).map((id) => ({
              id,
              link: '/hr/payroll',
            }));
      consider(
        'reimbursement',
        c.id,
        c.employee_id,
        c.since,
        `${c.name}'s ${amount} claim`,
        approvers,
      );
    }

    for (const u of await repo.pendingLateUpdates()) {
      const approvers = u.effective_rm
        ? [{ id: u.effective_rm, link: '/performance' }]
        : [];
      consider(
        'late_update',
        u.id,
        u.employee_id,
        u.since,
        `${u.name}'s late work update for ${u.date}`,
        approvers,
      );
    }

    const deciders = await repo.accessDeciders();
    for (const g of await repo.pendingAccessRequests()) {
      consider(
        'access_request',
        g.id,
        g.employee_id,
        g.since,
        `The access request for ${g.name}`,
        deciders
          .filter((id) => id !== g.requested_by)
          .map((id) => ({ id, link: '/admin/grant-requests' })),
      );
    }

    // Nominations wait on HR's final approval — the same rule (user decision).
    const hr = await holders('hrbp.people', 'update');
    for (const n of await repo.pendingNominations()) {
      consider(
        'nomination',
        n.id,
        n.employee_id,
        n.since,
        `${n.name}'s ${n.award_name ?? 'award'} nomination`,
        hr
          .filter((id) => id !== n.nominated_by)
          .map((id) => ({ id, link: '/recognition' })),
      );
    }

    await repo.sendReminders(out);
    return { waiting, reminded: out.length, ...counts };
  };

  /**
   * concern-deadlines (Batch 4): every case past its acknowledge / decide /
   * resolve date (or its extension) rings its handlers, then again every
   * APPROVAL_REMINDERS.repeatEveryWorkingDays. The bell names the case code
   * only — never the subject or details (confidentiality, policy §9).
   */
  const concernDeadlines = async (now: Date): Promise<Record<string, number>> => {
    const today = localDate(now);
    const rules = APPROVAL_REMINDERS;
    const [workWeek, last, overdue] = await Promise.all([
      settings.effective('attendance.workWeek'),
      repo.lastReminders(),
      concerns.overdue(),
    ]);
    const holidays = await repo.holidaysBetween(addDays(today, -400), today);
    const out: ReminderToSend[] = [];
    for (const { concern, handlers, due } of overdue) {
      for (const h of handlers) {
        const lastSent = last.get(`concern_overdue:${concern.id}:${h}`);
        if (
          lastSent &&
          workingDaysBetween(localDate(lastSent), today, workWeek, holidays) <
            rules.repeatEveryWorkingDays
        ) {
          continue;
        }
        out.push({
          kind: 'concern_overdue',
          subjectId: concern.id,
          recipientId: h,
          title: `Overdue: ${concern.code} was due ${due}`,
          link: '/grievances?tab=concerns',
        });
      }
    }
    await repo.sendReminders(out);
    return { overdue: overdue.length, reminded: out.length };
  };

  /**
   * open-door-requests (test-pass fix 2026-10-22): a session request nobody
   * has answered rings its host (or the case's handlers) after
   * APPROVAL_REMINDERS.afterWorkingDays, then every repeatEveryWorkingDays,
   * until it is offered, declined or withdrawn. The bell names no topic.
   */
  const openDoorRequests = async (now: Date): Promise<Record<string, number>> => {
    const today = localDate(now);
    const rules = APPROVAL_REMINDERS;
    const [workWeek, last, waiting] = await Promise.all([
      settings.effective('attendance.workWeek'),
      repo.lastReminders(),
      openDoor.unanswered(),
    ]);
    const holidays = await repo.holidaysBetween(addDays(today, -400), today);
    const out: ReminderToSend[] = [];
    for (const { request, answerers } of waiting) {
      const since = localDate(request.createdAt);
      if (workingDaysBetween(since, today, workWeek, holidays) < rules.afterWorkingDays) {
        continue;
      }
      for (const a of answerers) {
        const lastSent = last.get(`open_door_request:${request.id}:${a}`);
        if (
          lastSent &&
          workingDaysBetween(localDate(lastSent), today, workWeek, holidays) <
            rules.repeatEveryWorkingDays
        ) {
          continue;
        }
        out.push({
          kind: 'open_door_request',
          subjectId: request.id,
          recipientId: a,
          title: `An open-door session request has waited since ${since} — offer a time or decline`,
          link: '/grievances?tab=requests',
        });
      }
    }
    await repo.sendReminders(out);
    return { waiting: waiting.length, reminded: out.length };
  };

  /**
   * return-reminders (OPS asset manager, user decisions 2026-10-15): once a
   * lab loan or gate-pass item is past its return date, its holder is asked
   * "is it back or still out?" (OPS is told once, with the first ask), and
   * again every RETURN_REMINDERS.repeatEveryWorkingDays until they answer.
   * After escalateAfterWorkingDays it escalates once to OPS and the holder's
   * RM. Answering "still out" moves the date, which restarts all of it.
   */
  const returnReminders = async (now: Date): Promise<Record<string, number>> => {
    const today = localDate(now);
    const rules = RETURN_REMINDERS;
    const [workWeek, last, items] = await Promise.all([
      settings.effective('attendance.workWeek'),
      repo.lastReminders(),
      repo.overdueReturns(today),
    ]);
    const holidays = await repo.holidaysBetween(addDays(today, -400), today);
    const days = (fromIso: string) =>
      workingDaysBetween(fromIso, today, workWeek, holidays);
    // Only reminders sent for the CURRENT due date count.
    const sentSince = (key: string, due: string) => {
      const d = last.get(key);
      return d && localDate(d) > due ? d : undefined;
    };
    const out: ReminderToSend[] = [];
    let asked = 0;
    let escalated = 0;
    for (const it of items) {
      const overdue = days(it.due_on);
      if (overdue < 1) continue;
      const what = `${it.asset_name} (${it.asset_code})`;
      const opsLink = it.kind === 'pass' ? '/hr/gate-passes' : '/hr/assets';
      const opsPeople = (
        await authz.listBroadHolders(
          it.kind === 'pass' ? 'ops.gate_passes' : 'ops.assets',
          'update',
          it.employee_id,
        )
      ).filter((id) => id !== it.employee_id);

      const lastAsk = sentSince(
        `return_due:${it.subject_id}:${it.employee_id}`,
        it.due_on,
      );
      if (!lastAsk || days(localDate(lastAsk)) >= rules.repeatEveryWorkingDays) {
        asked += 1;
        out.push({
          kind: 'return_due',
          subjectId: it.subject_id,
          recipientId: it.employee_id,
          title: `Is ${what} back at ${it.zone_name}? It was due ${it.due_on} — answer in My assets`,
          link: '/my-assets',
        });
        if (!lastAsk) {
          for (const id of opsPeople) {
            out.push({
              kind: 'return_due_ops',
              subjectId: it.subject_id,
              recipientId: id,
              title: `${it.name}'s ${what} was due back ${it.due_on} — they have been asked`,
              link: opsLink,
            });
          }
        }
      }

      if (overdue >= rules.escalateAfterWorkingDays) {
        const audience = [
          ...opsPeople.map((id) => ({ id, link: opsLink })),
          ...(it.effective_rm && it.effective_rm !== it.employee_id
            ? [{ id: it.effective_rm, link: '/my-team' }]
            : []),
        ];
        const already = audience.some((a) =>
          sentSince(`return_escalated:${it.subject_id}:${a.id}`, it.due_on),
        );
        if (!already) {
          escalated += 1;
          const seen = new Set<string>();
          for (const a of audience) {
            if (seen.has(a.id)) continue;
            seen.add(a.id);
            out.push({
              kind: 'return_escalated',
              subjectId: it.subject_id,
              recipientId: a.id,
              title: `Not returned: ${it.name} still has ${what} — due ${it.due_on}, ${overdue} working days ago`,
              link: a.link,
            });
          }
        }
      }
    }
    await repo.sendReminders(out);
    return { overdue: items.length, asked, escalated, bells: out.length };
  };

  /** Registry: what each job is, when it is due, and what one run does. */
  const JOBS: Record<
    string,
    {
      description: string;
      schedule: string;
      run: (now: Date) => Promise<Record<string, number>>;
    }
  > = {
    'approval-reminders': {
      description:
        'Rings approvers whose requests have waited past the reminder setting.',
      schedule: `Working days at ${env.scheduler.dailyAt}`,
      run: approvalReminders,
    },
    'concern-deadlines': {
      description: 'Rings the handlers of concerns past their deadline.',
      schedule: `Working days at ${env.scheduler.dailyAt}`,
      run: concernDeadlines,
    },
    'open-door-requests': {
      description:
        'Rings hosts (or case handlers) whose open-door session requests are still unanswered.',
      schedule: `Working days at ${env.scheduler.dailyAt}`,
      run: openDoorRequests,
    },
    'exit-day': {
      description:
        "On a leaver's last working day asks for the exit interview and tells OPS; afterwards relieves them (login off, open requests cancelled, team without an RM — HR told).",
      schedule: `Working days at ${env.scheduler.dailyAt}`,
      run: (now) => exits.daily(now),
    },
    probation: {
      description:
        'Asks the RM a week before a probation ends; reminds HR past the date; confirms automatically 7 days after it.',
      schedule: `Working days at ${env.scheduler.dailyAt}`,
      run: (now) => probation.daily(now),
    },
    pip: {
      description:
        'Rings the RM when a fortnightly PIP check-in is due, and the RM + HR once a PIP has ended without an outcome.',
      schedule: `Working days at ${env.scheduler.dailyAt}`,
      run: (now) => pip.daily(now),
    },
    'return-reminders': {
      description:
        'Asks holders of overdue lab loans and gate-pass items whether they are back; escalates to OPS and the RM.',
      schedule: `Working days at ${env.scheduler.dailyAt}`,
      run: returnReminders,
    },
  };

  /** Today's run key when a daily job is due (working day, past the hour). */
  const dueKey = async (now: Date): Promise<string | null> => {
    const today = localDate(now);
    const hhmm = now.toTimeString().slice(0, 5);
    if (hhmm < env.scheduler.dailyAt) return null;
    const [workWeek, holidays] = await Promise.all([
      settings.effective('attendance.workWeek'),
      repo.holidaysBetween(today, today),
    ]);
    if (isWeekendDay(today, workWeek) || holidays.has(today)) return null;
    return today;
  };

  /** Claim, run, record. Undefined = someone else has (or had) this run. */
  const runJob = async (
    name: string,
    runKey: string,
    now: Date,
  ): Promise<JobRunDto | undefined> => {
    const job = JOBS[name];
    if (!job) throw createError(404, `No job named ${name}`, { code: 'JOB_NOT_FOUND' });
    const id = await repo.claimRun(name, runKey);
    if (!id) return undefined;
    try {
      const summary = await job.run(now);
      await repo.finishRun(id, { status: 'succeeded', summary });
    } catch (err) {
      await repo.finishRun(id, { status: 'failed', error: (err as Error).message });
    }
    return (await repo.listRuns(20)).map(toRun).find((r) => r.id === id);
  };

  /** One scheduler tick: run every job that is due and not yet claimed. */
  const tick = async (now = new Date()): Promise<string[]> => {
    const key = await dueKey(now);
    if (!key) return [];
    const ran: string[] = [];
    for (const name of Object.keys(JOBS)) {
      if (await runJob(name, key, now)) ran.push(name);
    }
    return ran;
  };

  const jobs = (): JobDto[] =>
    Object.entries(JOBS).map(([name, j]) => ({
      name,
      description: j.description,
      schedule: j.schedule,
    }));

  const runs = async (): Promise<JobRunDto[]> => (await repo.listRuns(30)).map(toRun);

  /** Admin "run now": its own key, so it never blocks the daily run. */
  const runNow = async (name: string): Promise<JobRunDto> => {
    const now = new Date();
    const run = await runJob(name, `manual-${now.toISOString()}`, now);
    return run!;
  };

  return {
    tick,
    jobs,
    runs,
    runNow,
    approvalReminders,
    concernDeadlines,
    returnReminders,
  };
};

export type JobsService = ReturnType<typeof createJobsService>;
