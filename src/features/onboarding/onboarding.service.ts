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
import { ONBOARDING_TEMPLATE } from './onboarding.template.js';
import type { TeamTaskDto } from './onboarding.schema.js';
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
 * Onboarding rules (adopted from the hr-tool review, user decisions):
 *  - one journey per hire, tasks COPIED from the template at start;
 *  - a task is ticked only by its OWNER — the employee for employee tasks,
 *    the effective RM for manager tasks, broad HR for hr/admin tasks; broad
 *    HR (hrbp.people update) may tick anything, like the drill-in queue;
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

  /** Join tasks + policy states into DTOs; policy tasks derive their done. */
  const buildTasks = async (
    employeeId: string,
    tasks: TaskRow[],
  ): Promise<OnboardingTaskDto[]> => {
    const codes = tasks.map((t) => t.policyCode).filter((c): c is string => c !== null);
    const needsAuto = tasks.some((t) => t.owner === 'ops' || t.owner === 'payroll');
    const [policyStates, names, auto] = await Promise.all([
      repo.policyStates(employeeId, codes),
      repo.namesByIds(tasks.map((t) => t.doneBy).filter((v): v is string => v !== null)),
      needsAuto ? repo.autoDone(employeeId) : Promise.resolve({ ops: false, payroll: false }),
    ]);
    return tasks.map((t) => {
      const policy = t.policyCode ? policyStates.get(t.policyCode) : undefined;
      // OPS / payroll tasks also finish on their own from the records.
      const autoDone = (t.owner === 'ops' && auto.ops) || (t.owner === 'payroll' && auto.payroll);
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
      };
    });
  };

  const toJourney = async (
    row: JourneyRow,
    employee: { id: string; name: string; employeeCode: string },
  ): Promise<JourneyDto> => {
    const tasks = await buildTasks(row.employeeId, await repo.listTasks(row.id));
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
    // The hand-off: OPS prepares the kit, payroll sets up salary + bank.
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
            title: `${name} joins on ${start} — issue their joiner kit`,
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
    const dto = await toJourney(row, {
      id: employee.id,
      name: employee.name,
      employeeCode: employee.employeeCode,
    });
    return syncStatus(row, dto);
  };

  /** One journey by employee — the HR drill-in (route gated hrbp.people read). */
  const forEmployee = async (employeeId: string): Promise<JourneyDto> => {
    const employee = await repo.findEmployee(employeeId);
    if (!employee)
      throw createError(404, 'Employee record not found', { code: 'EMPLOYEE_NOT_FOUND' });
    const row = await repo.findJourneyByEmployee(employeeId);
    if (!row)
      throw createError(404, 'No onboarding journey for this employee', {
        code: 'JOURNEY_NOT_FOUND',
      });
    const dto = await toJourney(row, {
      id: employee.id,
      name: employee.name,
      employeeCode: employee.employeeCode,
    });
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
    return toJourney(row, {
      id: employee.id,
      name: employee.name,
      employeeCode: employee.employeeCode,
    });
  };

  const toggleTask = async (taskId: string, actor: ActorContext): Promise<JourneyDto> => {
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

    // Owner gate: HR reaching this person ticks anything; otherwise only the
    // task's owner — OPS / payroll tasks by an org holder of that team's grant.
    const broadHr = await hrReaches(actor.actorEmployeeId, employee.id);
    const teamOwner =
      (task.owner === 'ops' || task.owner === 'payroll') &&
      actor.actorEmployeeId !== employee.id &&
      hasOrgScope(
        await authz.resolveAccess(actor.actorEmployeeId, TEAM_GRANT[task.owner], 'update'),
      );
    if (!broadHr && !teamOwner) {
      const effectiveRm = employee.leaveApprover ?? employee.reportsTo;
      const allowed =
        (task.owner === 'employee' && actor.actorEmployeeId === employee.id) ||
        (task.owner === 'manager' && actor.actorEmployeeId === effectiveRm);
      if (!allowed) {
        throw createError(
          403,
          `This step waits on ${task.owner === 'employee' ? 'the employee' : task.owner}`,
          {
            code: 'NOT_TASK_OWNER',
          },
        );
      }
    }

    await repo.setTaskDone(task, task.doneAt === null, actor);
    const dto = await toJourney(journey, {
      id: employee.id,
      name: employee.name,
      employeeCode: employee.employeeCode,
    });
    return syncStatus(journey, dto);
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
        const auto = (await repo.autoDone(r.employee_id))[owner];
        return {
          taskId: r.task_id,
          title: r.title,
          done: r.done_at !== null || auto,
          autoDone: auto,
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

  return { mine, forEmployee, start, toggleTask, queue, teamTasks };
};

export type OnboardingService = ReturnType<typeof createOnboardingService>;
