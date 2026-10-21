import createError from 'http-errors';
import type { AuthzRepository } from '../access/authz.repository.js';
import { createRmOrHrGate, type HrDoor } from '../access/rmOrHr.gate.js';
import { createSelfGovernance } from '../access/selfGovernance.js';
import type { SettingsReader } from '../settings/index.js';
import {
  REGULARIZE_WINDOW_DAYS,
  WORK_UPDATE_MISS_ALLOWANCE,
} from '../../shared/constants/constants.js';
import { isWeekendDay } from '../../shared/helpers/helpers.js';
import type {
  ActorContext,
  CycleRow,
  GoalRow,
  PerformanceRepository,
  WorkUpdateRow,
} from './performance.repository.js';
import type {
  CreateGoalInput,
  DecideLateInput,
  LateUpdateDto,
  StripDayDto,
  GoalDto,
  MyGoalsDto,
  MyUpdatesDto,
  SubmitUpdateInput,
  TeamGoalsRowDto,
  TeamUpdatesRowDto,
  UpdateGoalInput,
  UpdateProgressInput,
  WorkUpdateDto,
} from './performance.schema.js';
import { scoreUpdate, scoringEnabled } from './scoring.js';

const DAY_MS = 86_400_000;
const localDate = (d = new Date()): string => d.toLocaleDateString('en-CA');
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** At risk = under 40% with under 30 days to the due date (incl. overdue). */
const AT_RISK_PROGRESS = 40;
const AT_RISK_DAYS = 30;
const isAtRisk = (g: GoalRow, today: string): boolean =>
  g.progress < AT_RISK_PROGRESS &&
  (Date.parse(g.dueOn) - Date.parse(today)) / DAY_MS < AT_RISK_DAYS;

type ScoredGoal = Pick<GoalRow, 'progress' | 'weight' | 'category'>;

/** CGP category weights (Performance & Appraisal Policy §6). */
export const CATEGORY_WEIGHTS = { fundamental: 50, corporate: 25, general: 25 } as const;

/** Σ(progress×weight)/Σweight inside one set of goals; null without weight. */
const weightedProgress = (rows: Array<Pick<GoalRow, 'progress' | 'weight'>>): number | null => {
  const totalWeight = rows.reduce((acc, g) => acc + Number(g.weight), 0);
  if (totalWeight === 0) return null;
  return rows.reduce((acc, g) => acc + g.progress * Number(g.weight), 0) / totalWeight;
};

/** Per-category attainment (rounded), null where a category has no goals. */
export const categoryAttainment = (rows: ScoredGoal[]) => {
  const of = (c: keyof typeof CATEGORY_WEIGHTS) => {
    const v = weightedProgress(rows.filter((g) => g.category === c));
    return v === null ? null : Math.round(v);
  };
  return { fundamental: of('fundamental'), corporate: of('corporate'), general: of('general') };
};

/**
 * The one score formula in the app: 50% Fundamental + 25% Corporate + 25%
 * General. Categories without goals drop out and the others share their
 * weight, so a person with only fundamental goals scores on those alone.
 */
export const attainmentOf = (rows: ScoredGoal[]): number | null => {
  let num = 0;
  let den = 0;
  for (const c of Object.keys(CATEGORY_WEIGHTS) as Array<keyof typeof CATEGORY_WEIGHTS>) {
    const v = weightedProgress(rows.filter((g) => g.category === c));
    if (v === null) continue;
    num += v * CATEGORY_WEIGHTS[c];
    den += CATEGORY_WEIGHTS[c];
  }
  return den === 0 ? null : Math.round(num / den);
};

/** The quarter around `today`: '2026-Q4', Oct 1 – Dec 31. */
export const quarterOf = (today = new Date()) => {
  const q = Math.ceil((today.getMonth() + 1) / 3);
  const y = today.getFullYear();
  const startMonth = (q - 1) * 3 + 1;
  const endMonth = q * 3;
  const lastDay = new Date(y, endMonth, 0).getDate();
  return {
    name: `${y}-Q${q}`,
    startDate: `${y}-${String(startMonth).padStart(2, '0')}-01`,
    endDate: `${y}-${String(endMonth).padStart(2, '0')}-${lastDay}`,
  };
};

const toGoal = (row: GoalRow, names: Map<string, string>): GoalDto => ({
  id: row.id,
  employeeId: row.employeeId,
  cycleId: row.cycleId,
  title: row.title,
  category: row.category,
  metric: row.metric,
  target: row.target,
  weight: Number(row.weight),
  progress: row.progress,
  dueOn: row.dueOn,
  createdByName: names.get(row.createdBy) ?? null,
  createdAt: row.createdAt.toISOString(),
});

const toUpdate = (row: WorkUpdateRow): WorkUpdateDto => ({
  id: row.id,
  date: row.date,
  note: row.note,
  score: row.score,
  feedback: row.feedback,
  kpiHits: row.kpiHits,
  goalIds: row.goalIds,
  lateStatus: (row.lateStatus as WorkUpdateDto['lateStatus']) ?? null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

/**
 * Performance rules (adopted from the hr-tool review, user decisions):
 *  - a review cycle is the calendar quarter, materialized lazily;
 *  - goals are SET by the person's RM or broad HR (never for yourself, except
 *    the self-governing top) — and, while the cycle is open, EDITED or
 *    DELETED by the same people, audited; only the OWNER moves progress —
 *    "only the person who owns it moves this";
 *  - one work update per working day, written on the day; re-submitting
 *    replaces and re-scores. A MISSED day can be filled in late within the
 *    regularization window — pending until the RM approves (clears the miss)
 *    or declines; a self-governing person's late entry is approved as written;
 *  - a miss is a past WORKING day (work week, holidays) with no approved
 *    full-day leave and no on-time or approved-late update; over the monthly
 *    allowance the month is flagged (quarter report) and the RM notified once;
 *  - scoring grades the note against the person's OWN goals; off or failed
 *    scoring stores NULL ("unscored"), never 0.
 */
export const createPerformanceService = (deps: {
  repo: PerformanceRepository;
  authz: AuthzRepository;
  settings: SettingsReader;
}) => {
  const { repo, authz, settings } = deps;
  const rmOrHr = createRmOrHrGate(authz);
  const selfGoverned = createSelfGovernance(authz);
  /** Goals and work updates are people data: HR opens them with hrbp.people. */
  const PEOPLE_HR: HrDoor = { moduleKey: 'hrbp.people', action: 'update' };

  /** A closed quarter (HR closed it early) takes no new goals. */
  const requireOpen = (cycle: CycleRow): void => {
    if (cycle.closedAt) {
      throw createError(409, 'This quarter is closed — goals are frozen in its report', {
        code: 'CYCLE_CLOSED',
      });
    }
  };

  const currentCycle = async (): Promise<CycleRow> => {
    const q = quarterOf();
    return repo.ensureCycle(q.name, q.startDate, q.endDate);
  };

  const myGoalsFor = async (employeeId: string): Promise<MyGoalsDto> => {
    const cycle = await currentCycle();
    const rows = await repo.listGoals(employeeId, cycle.id);
    const names = await repo.namesByIds(rows.map((g) => g.createdBy));
    const today = localDate();
    return {
      cycle: {
        id: cycle.id,
        name: cycle.name,
        startDate: cycle.startDate,
        endDate: cycle.endDate,
      },
      goals: rows.map((g) => toGoal(g, names)),
      attainment: attainmentOf(rows),
      byCategory: categoryAttainment(rows),
      atRisk: rows.filter((g) => isAtRisk(g, today)).length,
      weightTotal: round1(rows.reduce((acc, g) => acc + Number(g.weight), 0)),
    };
  };

  const myGoals = async (actor: ActorContext): Promise<MyGoalsDto> =>
    myGoalsFor(actor.actorEmployeeId);

  /** The person-sheet gate (shared, access/rmOrHr.gate.ts) for per-member reads. */
  const requireRmOrHr = (employeeId: string, actor: ActorContext): Promise<void> =>
    rmOrHr(
      actor.actorEmployeeId,
      employeeId,
      PEOPLE_HR,
      "Only this person's RM or HR reads their sheet",
    );

  /** One report's FULL goal sheet (the team list only carries counts). */
  const teamMemberGoals = async (
    employeeId: string,
    actor: ActorContext,
  ): Promise<MyGoalsDto> => {
    await requireRmOrHr(employeeId, actor);
    return myGoalsFor(employeeId);
  };

  /** One report's recent work updates — the HR People page has no chain. */
  const teamMemberUpdates = async (
    employeeId: string,
    actor: ActorContext,
    days: number,
  ): Promise<WorkUpdateDto[]> => {
    await requireRmOrHr(employeeId, actor);
    const from = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    return (await repo.listUpdates(employeeId, from)).map(toUpdate);
  };

  const createGoal = async (
    input: CreateGoalInput,
    actor: ActorContext,
  ): Promise<GoalDto> => {
    if (input.employeeId === actor.actorEmployeeId) {
      // The one exception (refinement plan, Phase 2): a SELF-GOVERNED person
      // (the org chart's apex) has nobody above them to set goals, so they
      // set their own.
      const me = await repo.findEmployee(actor.actorEmployeeId);
      if (!(await selfGoverned(me))) {
        throw createError(403, 'Goals are set by your manager or HR, not by yourself', {
          code: 'SELF_GOAL',
        });
      }
    } else {
      await rmOrHr(
        actor.actorEmployeeId,
        input.employeeId,
        PEOPLE_HR,
        "Only this person's RM or HR sets their goals",
      );
    }
    const cycle = await currentCycle();
    requireOpen(cycle);
    const row = await repo.insertGoal(
      {
        employeeId: input.employeeId,
        cycleId: cycle.id,
        title: input.title,
        category: input.category ?? 'fundamental',
        metric: input.metric ?? null,
        target: input.target ?? null,
        weight: String(input.weight),
        dueOn: input.dueOn ?? cycle.endDate,
        createdBy: actor.actorEmployeeId,
      },
      actor,
    );
    return toGoal(row, new Map([[actor.actorEmployeeId, '']]));
  };

  /**
   * May the caller change this goal's DEFINITION? The person's RM or broad HR
   * — never the owner, unless they are self-governing (they set their own) —
   * and only while the goal's cycle is the open (current) quarter.
   */
  const requireGoalEditor = async (goal: GoalRow, actor: ActorContext): Promise<void> => {
    const cycle = await currentCycle();
    if (goal.cycleId !== cycle.id || cycle.closedAt) {
      throw createError(
        409,
        'This goal belongs to a closed quarter and can no longer change',
        {
          code: 'CYCLE_CLOSED',
        },
      );
    }
    if (goal.employeeId === actor.actorEmployeeId) {
      const me = await repo.findEmployee(actor.actorEmployeeId);
      if (!(await selfGoverned(me))) {
        throw createError(
          403,
          'Your manager or HR changes your goals; you move the progress',
          {
            code: 'OWNER_CANNOT_EDIT',
          },
        );
      }
      return;
    }
    await rmOrHr(
      actor.actorEmployeeId,
      goal.employeeId,
      PEOPLE_HR,
      "Only this person's RM or HR changes their goals",
    );
  };

  const updateGoal = async (
    goalId: string,
    input: UpdateGoalInput,
    actor: ActorContext,
  ): Promise<GoalDto> => {
    const goal = await repo.findGoal(goalId);
    if (!goal) throw createError(404, 'Goal not found', { code: 'GOAL_NOT_FOUND' });
    await requireGoalEditor(goal, actor);
    const row = await repo.updateGoal(
      goalId,
      {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.category !== undefined ? { category: input.category } : {}),
        ...('metric' in input ? { metric: input.metric ?? null } : {}),
        ...('target' in input ? { target: input.target ?? null } : {}),
        ...(input.weight !== undefined ? { weight: String(input.weight) } : {}),
        ...(input.dueOn !== undefined ? { dueOn: input.dueOn } : {}),
      },
      actor,
    );
    if (!row) throw createError(404, 'Goal not found', { code: 'GOAL_NOT_FOUND' });
    return toGoal(row, await repo.namesByIds([row.createdBy]));
  };

  const deleteGoal = async (goalId: string, actor: ActorContext): Promise<void> => {
    const goal = await repo.findGoal(goalId);
    if (!goal) throw createError(404, 'Goal not found', { code: 'GOAL_NOT_FOUND' });
    await requireGoalEditor(goal, actor);
    await repo.deleteGoal(goal, actor);
  };

  const updateProgress = async (
    goalId: string,
    input: UpdateProgressInput,
    actor: ActorContext,
  ): Promise<GoalDto> => {
    const goal = await repo.findGoal(goalId);
    if (!goal) throw createError(404, 'Goal not found', { code: 'GOAL_NOT_FOUND' });
    if (goal.employeeId !== actor.actorEmployeeId) {
      throw createError(403, 'Only the person who owns a goal moves its progress', {
        code: 'OWNER_ONLY',
      });
    }
    const cycle = await currentCycle();
    if (goal.cycleId !== cycle.id || cycle.closedAt) {
      throw createError(409, 'This quarter is closed — its goals are frozen in the report', {
        code: 'CYCLE_CLOSED',
      });
    }
    const row = await repo.updateProgress(goalId, input.progress, actor);
    return toGoal(row!, new Map());
  };

  /** The RM's view: chain rows with count / attainment / at-risk. */
  const teamGoals = async (actor: ActorContext): Promise<TeamGoalsRowDto[]> => {
    const [cycle, chain] = await Promise.all([
      currentCycle(),
      repo.listChain(actor.actorEmployeeId),
    ]);
    const rows = await repo.goalsForEmployees(
      chain.map((p) => p.id),
      cycle.id,
    );
    const today = localDate();
    return chain.map((p) => {
      const own = rows.filter((g) => g.employeeId === p.id);
      return {
        employee: p,
        goalCount: own.length,
        attainment: attainmentOf(own),
        atRisk: own.filter((g) => isAtRisk(g, today)).length,
      };
    });
  };

  const updatePolicy = () =>
    settings.effectiveMany(['attendance.workWeek'] as const);

  /** Every date from `from` to `to` inclusive (YYYY-MM-DD, UTC-safe). */
  const datesBetween = (from: string, to: string): string[] => {
    const out: string[] = [];
    for (let t = Date.parse(`${from}T00:00:00Z`); ; t += DAY_MS) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (d > to) break;
      out.push(d);
    }
    return out;
  };

  /**
   * The update strip for several people over [from, to]: each day classified
   * the same way the miss count and the RM's view are. Today never counts as a
   * miss — the day isn't over.
   */
  const stripsFor = async (
    employeeIds: string[],
    from: string,
    to: string,
    policy: Awaited<ReturnType<typeof updatePolicy>>,
  ): Promise<Map<string, StripDayDto[]>> => {
    const today = localDate();
    const [lines, holidays, leaves, updates] = await Promise.all([
      repo.findLines(employeeIds),
      repo.holidayDates(from, to),
      repo.fullLeaveRanges(employeeIds, from, to),
      repo.updatesForEmployees(employeeIds, from),
    ]);
    const days = datesBetween(from, to);
    const out = new Map<string, StripDayDto[]>();
    for (const id of employeeIds) {
      const joined = lines.find((l) => l.id === id)?.dateOfJoining ?? null;
      const byDate = new Map(
        updates.filter((u) => u.employeeId === id).map((u) => [u.date, u]),
      );
      const myLeave = leaves.filter((l) => l.employeeId === id);
      out.set(
        id,
        days.map((date): StripDayDto => {
          const u = byDate.get(date);
          if (joined && date < joined) return { date, status: 'not_joined' };
          if (isWeekendDay(date, policy['attendance.workWeek']))
            return { date, status: 'weekend' };
          if (holidays.has(date)) return { date, status: 'holiday' };
          if (myLeave.some((l) => date >= l.startDate && date <= l.endDate)) {
            return { date, status: 'leave' };
          }
          if (u && !u.lateStatus) return { date, status: 'done' };
          if (u?.lateStatus === 'approved') return { date, status: 'late_approved' };
          if (u?.lateStatus === 'pending') return { date, status: 'late_pending' };
          if (date >= today) return { date, status: 'today' };
          return { date, status: 'missed' };
        }),
      );
    }
    return out;
  };

  const monthStart = (today: string) => `${today.slice(0, 7)}-01`;

  /** Misses so far this calendar month, per person. */
  const missesThisMonth = async (
    employeeIds: string[],
    policy: Awaited<ReturnType<typeof updatePolicy>>,
  ): Promise<Map<string, number>> => {
    const today = localDate();
    const strips = await stripsFor(employeeIds, monthStart(today), today, policy);
    return new Map(
      employeeIds.map((id) => [
        id,
        (strips.get(id) ?? []).filter((d) => d.status === 'missed').length,
      ]),
    );
  };

  /**
   * Over the allowance this month? Flag the month (the quarter report reads
   * the flag) and, the first time only, ring the RM. Runs lazily whenever the
   * person's updates are viewed — there is no scheduler.
   */
  const checkAllowance = async (
    employeeIds: string[],
    misses: Map<string, number>,
    allowance: number,
  ): Promise<void> => {
    const month = localDate().slice(0, 7);
    const over = employeeIds.filter((id) => (misses.get(id) ?? 0) > allowance);
    if (over.length === 0) return;
    const [lines, ownerId] = await Promise.all([repo.findLines(over), authz.ownerId()]);
    for (const id of over) {
      const first = await repo.flagMonth(id, month, misses.get(id)!);
      const line = lines.find((l) => l.id === id);
      const rm = line ? (line.leaveApprover ?? line.reportsTo) : null;
      if (first && rm && rm !== ownerId) {
        await repo.notify([rm], {
          type: 'work_updates.over_allowance',
          title: `${line!.name} has missed ${misses.get(id)} work updates this month`,
          body: `Over the allowance of ${allowance}. The month is flagged for the quarter report.`,
          link: '/performance',
        });
      }
    }
  };

  /** Tags must be the writer's own goals in the current quarter. */
  const checkGoalTags = async (
    employeeId: string,
    goalIds: string[] | undefined,
  ): Promise<string[] | null> => {
    if (!goalIds || goalIds.length === 0) return null;
    const cycle = await currentCycle();
    const own = new Set((await repo.listGoals(employeeId, cycle.id)).map((g) => g.id));
    if (goalIds.some((g) => !own.has(g))) {
      throw createError(422, 'You can only tag your own goals for this quarter', {
        code: 'NOT_YOUR_GOAL',
      });
    }
    return [...new Set(goalIds)];
  };

  /**
   * A late entry for a missed day: within the regularization window, on a day
   * the strip shows as missed (or declined before). Pending for the RM, or
   * approved at once for a self-governing person.
   */
  const submitLate = async (
    input: SubmitUpdateInput & { date: string },
    actor: ActorContext,
  ): Promise<WorkUpdateDto> => {
    const policy = await updatePolicy();
    const windowDays = REGULARIZE_WINDOW_DAYS;
    const floor = localDate(new Date(Date.now() - windowDays * DAY_MS));
    if (input.date < floor) {
      throw createError(
        422,
        `Missed updates can be filled in for the last ${windowDays} days only`,
        {
          code: 'TOO_OLD',
        },
      );
    }
    const strip = (
      await stripsFor([actor.actorEmployeeId], input.date, input.date, policy)
    ).get(actor.actorEmployeeId)!;
    if (strip[0]?.status !== 'missed') {
      throw createError(409, "That day doesn't need a late update", {
        code: 'NOT_A_MISSED_DAY',
      });
    }
    const goalIds = await checkGoalTags(actor.actorEmployeeId, input.goalIds);
    const [me] = await repo.findLines([actor.actorEmployeeId]);
    const self = await selfGoverned(me);
    const rm = me ? (me.leaveApprover ?? me.reportsTo) : null;
    const row = await repo
      .insertLateUpdate(
        {
          employeeId: actor.actorEmployeeId,
          date: input.date,
          note: input.note,
          goalIds,
          lateStatus: self ? 'approved' : 'pending',
        },
        actor,
        !self && rm
          ? {
              recipientIds: [rm],
              event: {
                type: 'work_updates.late_entry',
                title: `${me!.name} filled in a missed update for ${input.date}`,
                body: 'Approve it to clear the miss, or decline to let it stand.',
                link: '/performance',
              },
            }
          : null,
      )
      .catch((err: unknown) => {
        const e = err as { code?: string; cause?: { code?: string } };
        if (e.code === '23505' || e.cause?.code === '23505') {
          throw createError(409, 'There is already an update for that day', {
            code: 'ALREADY_SUBMITTED',
          });
        }
        throw err;
      });
    return toUpdate(row);
  };

  const submitUpdate = async (
    input: SubmitUpdateInput,
    actor: ActorContext,
  ): Promise<WorkUpdateDto> => {
    const today = localDate();
    if (input.date && input.date > today) {
      throw createError(422, "You can't write an update for a future day", {
        code: 'FUTURE_DATE',
      });
    }
    if (input.date && input.date < today)
      return submitLate({ ...input, date: input.date }, actor);
    const goalIds = await checkGoalTags(actor.actorEmployeeId, input.goalIds);
    // Score against the person's OWN goals; null = unscored, by design.
    const cycle = await currentCycle();
    const ownGoals = await repo.listGoals(actor.actorEmployeeId, cycle.id);
    const scored = await scoreUpdate(
      input.note,
      ownGoals.map((g) => ({
        title: g.title,
        metric: g.metric,
        target: g.target,
        progress: g.progress,
      })),
    );
    const row = await repo.upsertUpdate(
      actor.actorEmployeeId,
      today,
      input.note,
      scored,
      actor,
      goalIds,
    );
    return toUpdate(row);
  };

  const myUpdates = async (actor: ActorContext, days: number): Promise<MyUpdatesDto> => {
    const today = localDate();
    const from = localDate(new Date(Date.now() - (days - 1) * DAY_MS));
    const policy = await updatePolicy();
    const [rows, strips, misses] = await Promise.all([
      repo.listUpdates(actor.actorEmployeeId, from),
      stripsFor([actor.actorEmployeeId], from, today, policy),
      missesThisMonth([actor.actorEmployeeId], policy),
    ]);
    const allowance = WORK_UPDATE_MISS_ALLOWANCE;
    await checkAllowance([actor.actorEmployeeId], misses, allowance);
    return {
      updates: rows.map(toUpdate),
      scoringEnabled: scoringEnabled(),
      strip: strips.get(actor.actorEmployeeId) ?? [],
      missesThisMonth: misses.get(actor.actorEmployeeId) ?? 0,
      missAllowance: allowance,
      lateWindowDays: REGULARIZE_WINDOW_DAYS,
    };
  };

  /** The RM's queue of late entries from people they are the effective RM of. */
  const latePending = async (actor: ActorContext): Promise<LateUpdateDto[]> => {
    const chain = await repo.listChain(actor.actorEmployeeId);
    const lines = await repo.findLines(chain.map((p) => p.id));
    const mine = lines.filter(
      (l) => (l.leaveApprover ?? l.reportsTo) === actor.actorEmployeeId,
    );
    const rows = await repo.listPendingLate(mine.map((l) => l.id));
    return rows.map((u) => ({
      employee: {
        id: u.employeeId,
        name: mine.find((l) => l.id === u.employeeId)?.name ?? '',
      },
      update: toUpdate(u),
    }));
  };

  const decideLate = async (
    id: string,
    input: DecideLateInput,
    actor: ActorContext,
  ): Promise<WorkUpdateDto> => {
    const row = await repo.findUpdate(id);
    if (!row || row.lateStatus === null) {
      throw createError(404, 'Late update not found', { code: 'NOT_FOUND' });
    }
    if (row.employeeId === actor.actorEmployeeId) {
      throw createError(403, 'You cannot approve your own late update', {
        code: 'NO_SELF_APPROVAL',
      });
    }
    await rmOrHr(
      actor.actorEmployeeId,
      row.employeeId,
      PEOPLE_HR,
      "Only this person's RM or HR decides",
    );
    const approved = input.decision === 'approve';
    const updated = await repo.decideLate(id, approved ? 'approved' : 'declined', actor, {
      recipientIds: [row.employeeId],
      event: {
        type: 'work_updates.late_decided',
        title: approved
          ? `Your late update for ${row.date} was accepted`
          : `Your late update for ${row.date} was not accepted`,
        body: approved ? 'The miss is cleared.' : 'The day still counts as missed.',
        link: '/performance',
      },
    });
    if (!updated) {
      throw createError(409, 'This late update has already been decided', {
        code: 'ALREADY_DECIDED',
      });
    }
    return toUpdate(updated);
  };

  /** The RM's team sheet, read-only — a manager never writes on it. */
  const teamUpdates = async (
    actor: ActorContext,
    days: number,
  ): Promise<TeamUpdatesRowDto[]> => {
    const chain = await repo.listChain(actor.actorEmployeeId);
    const from = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    const ids = chain.map((p) => p.id);
    const policy = await updatePolicy();
    const [rows, misses] = await Promise.all([
      repo.updatesForEmployees(ids, from),
      missesThisMonth(ids, policy),
    ]);
    const allowance = WORK_UPDATE_MISS_ALLOWANCE;
    await checkAllowance(ids, misses, allowance);
    return chain.map((p) => ({
      employee: p,
      updates: rows.filter((u) => u.employeeId === p.id).map(toUpdate),
      missesThisMonth: misses.get(p.id) ?? 0,
      overAllowance: (misses.get(p.id) ?? 0) > allowance,
    }));
  };

  return {
    myGoals,
    myGoalsFor,
    teamMemberGoals,
    teamMemberUpdates,
    createGoal,
    updateGoal,
    deleteGoal,
    updateProgress,
    teamGoals,
    submitUpdate,
    myUpdates,
    latePending,
    decideLate,
    teamUpdates,
  };
};

export type PerformanceService = ReturnType<typeof createPerformanceService>;
