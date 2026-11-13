import createError from 'http-errors';
import type { AuthzRepository } from '../access/authz.repository.js';
import {
  ONBOARDING_AUTO_CREATE_WINDOW_DAYS,
  ONBOARDING_DUE_DAYS,
} from '../../shared/constants/constants.js';
import type {
  ActorContext,
  JourneyRow,
  OnboardingRepository,
  TaskRow,
} from './onboarding.repository.js';
import type {
  JourneyDto,
  OnboardingTaskDto,
  QueueRowDto,
  StartJourneyInput,
} from './onboarding.schema.js';
import { AUTO_TASK_KEYS, FILE_TASK_KEYS, ONBOARDING_TEMPLATE } from './onboarding.template.js';
import { checkUpload } from '../../shared/helpers/uploads.js';
import type { TeamTaskDto, ToggleTaskInput } from './onboarding.schema.js';
import { hasOrgScope } from '../../shared/helpers/helpers.js';

/** The grant that lets a team tick its own joiner tasks. */
const TEAM_GRANT: Record<'ops' | 'payroll', string> = {
  ops: 'ops.assets',
  payroll: 'pr.payroll',
};

const DAY_MS = 86_400_000;
const localDate = (d = new Date()): string => d.toLocaleDateString('en-CA');
const plusDays = (date: string, days: number): string =>
  new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);

/**
 * Onboarding rules (adopted from the hr-tool review, user decisions; owner
 * ticks + proof reworked 2026-11-05):
 *  - one journey per hire, tasks COPIED from the template at start;
 *  - a task is ticked ONLY by its owner — the joiner their own steps, the
 *    effective RM the manager steps (HR in reach when the joiner has no RM of
 *    their own), HR in reach the HR / admin steps, OPS / payroll (org grant)
 *    theirs. HR no longer ticks other people's steps;
 *  - a hand tick needs a short note of what was done (shown with who and
 *    when); document steps complete by uploading the file (the signed offer
 *    by HR); the account and payroll steps complete on their own;
 *  - OPS is told when a journey starts and decides the joiner's assets;
 *  - a policy-linked task is never ticked: acknowledging the policy is what
 *    completes it (any version — version currency is the Policies tracker's
 *    job, so a journey never regresses when HR bumps a policy later);
 *  - nothing is pre-ticked: an old record starts empty rather than pretending;
 *  - journeys auto-create on first visit only for RECENT joiners; anyone
 *    older is a conscious HR start.
 */
export const createOnboardingService = (deps: {
  repo: OnboardingRepository;
  authz: AuthzRepository;
}) => {
  const { repo, authz } = deps;

  /** HR whose hrbp.people grant reaches this person (Phase 3). */
  const hrReaches = (actorId: string, employeeId: string): Promise<boolean> =>
    authz.reaches(actorId, 'hrbp.people', 'update', employeeId);

  /**
   * Which owners' steps this viewer may act on for this joiner — the task's
   * OWNER only: the joiner, their effective RM (HR in reach when they have no
   * RM of their own — none, or the administration account), HR in reach for
   * hr / admin steps, an org OPS / payroll grant for those teams.
   */
  const ownersFor = async (
    viewerId: string,
    employee: { id: string; reportsTo: string | null; leaveApprover: string | null },
  ): Promise<Set<TaskRow['owner']>> => {
    const out = new Set<TaskRow['owner']>();
    if (viewerId === employee.id) {
      out.add('employee');
      return out;
    }
    const [hr, ownerId, ops, pay] = await Promise.all([
      hrReaches(viewerId, employee.id),
      authz.ownerId(),
      authz.resolveAccess(viewerId, TEAM_GRANT.ops, 'update'),
      authz.resolveAccess(viewerId, TEAM_GRANT.payroll, 'update'),
    ]);
    const rm = employee.leaveApprover ?? employee.reportsTo;
    const hasRm = !!rm && rm !== ownerId;
    if (hasRm ? viewerId === rm : hr) out.add('manager');
    if (hr) {
      out.add('hr');
      out.add('admin');
    }
    if (hasOrgScope(ops)) out.add('ops');
    if (hasOrgScope(pay)) out.add('payroll');
    return out;
  };

  /** Join tasks + policy states into DTOs; policy tasks derive their done. */
  const buildTasks = async (
    employeeId: string,
    tasks: TaskRow[],
    may: Set<TaskRow['owner']> = new Set(),
  ): Promise<OnboardingTaskDto[]> => {
    const codes = tasks.map((t) => t.policyCode).filter((c): c is string => c !== null);
    const [policyStates, names, auto, files] = await Promise.all([
      repo.policyStates(employeeId, codes),
      repo.namesByIds(tasks.map((t) => t.doneBy).filter((v): v is string => v !== null)),
      repo.autoDone(employeeId),
      repo.fileMeta(tasks.filter((t) => FILE_TASK_KEYS.has(t.taskKey)).map((t) => t.id)),
    ]);
    return tasks.map((t) => {
      const policy = t.policyCode ? policyStates.get(t.policyCode) : undefined;
      // The payroll and account steps finish on their own from the records.
      const isAuto = AUTO_TASK_KEYS.has(t.taskKey);
      const autoDone =
        (t.taskKey === 'payroll' && auto.payroll) || (t.taskKey === 'claim' && auto.claim);
      const done = t.policyCode ? (policy?.acked ?? false) : t.doneAt !== null || autoDone;
      return {
        id: t.id,
        seq: t.seq,
        phase: t.phase,
        taskKey: t.taskKey,
        title: t.title,
        owner: t.owner,
        policyCode: t.policyCode,
        policyId: policy?.policyId ?? null,
        done,
        doneAt: t.policyCode
          ? (policy?.ackedAt?.toISOString() ?? null)
          : (t.doneAt?.toISOString() ?? null),
        doneByName: t.doneBy ? (names.get(t.doneBy) ?? null) : null,
        doneNote: t.doneNote,
        needsFile: FILE_TASK_KEYS.has(t.taskKey),
        auto: isAuto,
        canAct: !t.policyCode && !isAuto && may.has(t.owner),
        file: (() => {
          const f = files.get(t.id);
          return f
            ? { fileName: f.fileName, sizeBytes: f.sizeBytes, uploadedAt: f.uploadedAt.toISOString() }
            : null;
        })(),
      };
    });
  };

  const toJourney = async (
    row: JourneyRow,
    employee: { id: string; name: string; employeeCode: string },
    viewerId?: string,
  ): Promise<JourneyDto> => {
    const person = viewerId ? await repo.findEmployee(row.employeeId) : undefined;
    const may = viewerId && person ? await ownersFor(viewerId, person) : new Set<TaskRow['owner']>();
    const tasks = await buildTasks(row.employeeId, await repo.listTasks(row.id), may);
    const done = tasks.filter((t) => t.done).length;
    return {
      id: row.id,
      employee,
      startedOn: row.startedOn,
      dueOn: row.dueOn,
      status: row.status,
      progress: { done, total: tasks.length },
      tasks,
    };
  };

  /** Derived-complete keeps `status` honest after policy acks land. */
  const syncStatus = async (row: JourneyRow, dto: JourneyDto): Promise<JourneyDto> => {
    const complete = dto.progress.done === dto.progress.total && dto.progress.total > 0;
    const status = complete ? 'done' : 'open';
    if (status !== row.status) {
      await repo.setJourneyStatus(row.id, status);
      return { ...dto, status };
    }
    return dto;
  };

  const startJourney = async (
    employee: { id: string; dateOfJoining: string | null },
    startedOn: string | undefined,
    actor: ActorContext,
  ): Promise<JourneyRow> => {
    const start = startedOn ?? employee.dateOfJoining ?? localDate();
    const dueDays = ONBOARDING_DUE_DAYS;
    // The hand-off: OPS decides and issues the joiner's assets (the system
    // asks them — nobody picks a kit), payroll sets up salary + bank.
    const [ops, payroll, who] = await Promise.all([
      authz.listBroadHolders('ops.assets', 'update'),
      authz.listBroadHolders('pr.payroll', 'update'),
      repo.findEmployee(employee.id),
    ]);
    const name = who?.name ?? 'A new joiner';
    return repo.insertJourney(
      { employeeId: employee.id, startedOn: start, dueOn: plusDays(start, dueDays) },
      ONBOARDING_TEMPLATE,
      actor,
      [
        {
          to: ops.filter((id) => id !== employee.id),
          event: {
            type: 'onboarding.handoff',
            title: `${name} joins on ${start} — decide and issue their assets (laptop, mobile, ID card…)`,
            link: '/hr/assets',
          },
        },
        {
          to: payroll.filter((id) => id !== employee.id),
          event: {
            type: 'onboarding.handoff',
            title: `${name} joins on ${start} — put salary and bank details on record`,
            link: '/hr/payroll',
          },
        },
      ],
    );
  };

  /**
   * HR just created / invited / imported this person, or set their joining
   * date: start the journey NOW so OPS and payroll hear on day one, not when
   * the joiner first opens their page (test-pass fix, 2026-10-22). Same
   * recency rule as `mine` — an older record stays a conscious HR start.
   * Idempotent; returns whether a journey was started.
   */
  const ensureForNewHire = async (
    employeeId: string,
    actor: ActorContext,
  ): Promise<boolean> => {
    const employee = await repo.findEmployee(employeeId);
    if (!employee || employee.status === 'inactive' || employee.dateOfJoining === null) {
      return false;
    }
    if (daysBetween(employee.dateOfJoining, localDate()) > ONBOARDING_AUTO_CREATE_WINDOW_DAYS) {
      return false;
    }
    if (await repo.findJourneyByEmployee(employeeId)) return false;
    await startJourney(employee, undefined, actor);
    return true;
  };

  /** The caller's journey; auto-created for recent joiners, null otherwise. */
  const mine = async (actor: ActorContext): Promise<JourneyDto | null> => {
    const employee = await repo.findEmployee(actor.actorEmployeeId);
    if (!employee)
      throw createError(404, 'Employee record not found', { code: 'EMPLOYEE_NOT_FOUND' });
    let row = await repo.findJourneyByEmployee(employee.id);
    if (!row) {
      // A journey auto-creates only for RECENT joiners — older records start via HR.
      const joined = employee.dateOfJoining;
      const recent =
        joined !== null &&
        daysBetween(joined, localDate()) <= ONBOARDING_AUTO_CREATE_WINDOW_DAYS;
      if (!recent) return null;
      row = await startJourney(employee, undefined, actor);
    }
    const dto = await toJourney(
      row,
      { id: employee.id, name: employee.name, employeeCode: employee.employeeCode },
      employee.id,
    );
    return syncStatus(row, dto);
  };

  /** The RM's joiners (Onboarding → My team): their journeys, with what the RM may tick. */
  const team = async (actor: ActorContext): Promise<JourneyDto[]> => {
    const rows = await repo.journeysForRm(actor.actorEmployeeId);
    return Promise.all(
      rows.map(async (r) =>
        syncStatus(
          r.row,
          await toJourney(
            r.row,
            { id: r.row.employeeId, name: r.employeeName, employeeCode: r.employeeCode },
            actor.actorEmployeeId,
          ),
        ),
      ),
    );
  };

  /** One journey by employee — the HR drill-in (route gated hrbp.people read). */
  const forEmployee = async (employeeId: string, viewerId: string): Promise<JourneyDto> => {
    const employee = await repo.findEmployee(employeeId);
    if (!employee)
      throw createError(404, 'Employee record not found', { code: 'EMPLOYEE_NOT_FOUND' });
    const row = await repo.findJourneyByEmployee(employeeId);
    if (!row)
      throw createError(404, 'No onboarding journey for this employee', {
        code: 'JOURNEY_NOT_FOUND',
      });
    const dto = await toJourney(
      row,
      { id: employee.id, name: employee.name, employeeCode: employee.employeeCode },
      viewerId,
    );
    return syncStatus(row, dto);
  };

  const start = async (
    input: StartJourneyInput,
    actor: ActorContext,
  ): Promise<JourneyDto> => {
    const employee = await repo.findEmployee(input.employeeId);
    if (!employee || employee.status === 'inactive') {
      throw createError(404, 'Employee record not found', { code: 'EMPLOYEE_NOT_FOUND' });
    }
    if (await repo.findJourneyByEmployee(input.employeeId)) {
      throw createError(409, 'This person already has an onboarding journey', {
        code: 'JOURNEY_EXISTS',
      });
    }
    const row = await startJourney(employee, input.startedOn, actor);
    return toJourney(
      row,
      { id: employee.id, name: employee.name, employeeCode: employee.employeeCode },
      actor.actorEmployeeId,
    );
  };

  const toggleTask = async (
    taskId: string,
    input: ToggleTaskInput,
    actor: ActorContext,
  ): Promise<JourneyDto> => {
    const task = await repo.findTask(taskId);
    if (!task) throw createError(404, 'Task not found', { code: 'TASK_NOT_FOUND' });
    if (task.policyCode) {
      throw createError(409, 'This step completes when the policy is acknowledged', {
        code: 'POLICY_TASK',
      });
    }
    const journey = await repo.findJourneyById(task.journeyId);
    const employee = journey && (await repo.findEmployee(journey.employeeId));
    if (!journey || !employee)
      throw createError(404, 'Journey not found', { code: 'JOURNEY_NOT_FOUND' });

    // Owner gate: only the task's owner (see ownersFor) — HR no longer ticks
    // the joiner's, the manager's or the teams' steps.
    if (!(await ownersFor(actor.actorEmployeeId, employee)).has(task.owner)) {
      throw createError(
        403,
        `This step waits on ${task.owner === 'employee' ? 'the joiner' : task.owner === 'manager' ? 'their manager' : task.owner}`,
        { code: 'NOT_TASK_OWNER' },
      );
    }
    if (AUTO_TASK_KEYS.has(task.taskKey)) {
      throw createError(409, 'This step completes on its own from the records', {
        code: 'AUTO_TASK',
      });
    }

    // A document step is done by its upload; un-ticking one keeps the file.
    if (FILE_TASK_KEYS.has(task.taskKey) && task.doneAt === null) {
      throw createError(409, 'Upload the document — that completes this step', {
        code: 'FILE_REQUIRED',
      });
    }
    // Proof: a hand tick says what was done (learner, 2026-11-05).
    const ticking = task.doneAt === null;
    const note = input.note?.trim() ?? '';
    if (ticking && note.length < 3) {
      throw createError(422, 'Add a short note of what was done', { code: 'NOTE_REQUIRED' });
    }

    await repo.setTaskDone(task, ticking, ticking ? note : null, actor);
    const dto = await toJourney(
      journey,
      { id: employee.id, name: employee.name, employeeCode: employee.employeeCode },
      actor.actorEmployeeId,
    );
    return syncStatus(journey, dto);
  };

  /** A document step's task + its journey + the joiner, or 404. */
  const loadFileTask = async (taskId: string) => {
    const task = await repo.findTask(taskId);
    if (!task || !FILE_TASK_KEYS.has(task.taskKey)) {
      throw createError(404, 'No document step with this id', { code: 'TASK_NOT_FOUND' });
    }
    const journey = await repo.findJourneyById(task.journeyId);
    const employee = journey && (await repo.findEmployee(journey.employeeId));
    if (!journey || !employee)
      throw createError(404, 'Journey not found', { code: 'JOURNEY_NOT_FOUND' });
    return { task, journey, employee };
  };

  /** The step's owner uploads the document (the joiner theirs, HR the signed offer); that completes it. */
  const uploadTaskFile = async (
    taskId: string,
    file: { fileName: string; contentType: string; data: Buffer },
    actor: ActorContext,
  ): Promise<JourneyDto> => {
    const { task, journey, employee } = await loadFileTask(taskId);
    if (!(await ownersFor(actor.actorEmployeeId, employee)).has(task.owner)) {
      throw createError(
        403,
        task.owner === 'hr' ? 'HR uploads this document' : 'Only the joiner uploads this document',
        { code: 'NOT_TASK_OWNER' },
      );
    }
    const contentType = checkUpload(file, ['pdf', 'jpg', 'png'], { what: 'The document' });
    await repo.saveTaskFile(task, { ...file, contentType }, actor);
    const dto = await toJourney(
      journey,
      { id: employee.id, name: employee.name, employeeCode: employee.employeeCode },
      actor.actorEmployeeId,
    );
    return syncStatus(journey, dto);
  };

  /** Open the uploaded document: the joiner, or HR whose people grant reaches them. */
  const taskFile = async (taskId: string, viewerId: string) => {
    const { employee } = await loadFileTask(taskId);
    if (viewerId !== employee.id && !(await authz.reaches(viewerId, 'hrbp.people', 'read', employee.id))) {
      throw createError(404, 'No document step with this id', { code: 'TASK_NOT_FOUND' });
    }
    const f = await repo.findTaskFile(taskId);
    if (!f) throw createError(404, 'Nothing uploaded yet', { code: 'NO_FILE' });
    return { fileName: f.fileName, contentType: f.contentType, data: f.data };
  };

  /** HR queue: progress + days-left per journey, open and overdue first. */
  const queue = async (): Promise<QueueRowDto[]> => {
    const rows = await repo.listJourneys();
    const tasks = await repo.tasksForJourneys(rows.map((r) => r.row.id));
    const byJourney = new Map<string, TaskRow[]>();
    for (const t of tasks) {
      const list = byJourney.get(t.journeyId) ?? [];
      list.push(t);
      byJourney.set(t.journeyId, list);
    }
    const today = localDate();
    return Promise.all(
      rows.map(async (r) => {
        const own = byJourney.get(r.row.id) ?? [];
        const built = await buildTasks(r.row.employeeId, own);
        return {
          id: r.row.id,
          employee: {
            id: r.row.employeeId,
            name: r.employeeName,
            employeeCode: r.employeeCode,
          },
          startedOn: r.row.startedOn,
          dueOn: r.row.dueOn,
          status: r.row.status,
          progress: { done: built.filter((t) => t.done).length, total: built.length },
          daysLeft: daysBetween(today, r.row.dueOn),
        };
      }),
    );
  };

  /** OPS / payroll: the joiner tasks waiting on their team (org grant). */
  const teamTasks = async (owner: 'ops' | 'payroll', actor: ActorContext): Promise<TeamTaskDto[]> => {
    const access = await authz.resolveAccess(actor.actorEmployeeId, TEAM_GRANT[owner], 'read');
    if (!hasOrgScope(access)) {
      throw createError(403, 'Joiner tasks are for the OPS and payroll teams', {
        code: 'FORBIDDEN',
      });
    }
    const rows = await repo.teamTasks(owner);
    return Promise.all(
      rows.map(async (r) => {
        const auto = owner === 'payroll' && (await repo.autoDone(r.employee_id)).payroll;
        return {
          taskId: r.task_id,
          title: r.title,
          done: r.done_at !== null || auto,
          autoDone: auto,
          doneNote: r.done_note,
          employee: {
            id: r.employee_id,
            name: r.name,
            employeeCode: r.employee_code,
            designation: r.designation,
            dateOfJoining: r.date_of_joining,
          },
        };
      }),
    );
  };

  return {
    mine,
    forEmployee,
    team,
    start,
    ensureForNewHire,
    toggleTask,
    uploadTaskFile,
    taskFile,
    queue,
    teamTasks,
  };
};

export type OnboardingService = ReturnType<typeof createOnboardingService>;
