import createError from 'http-errors';
import { APPROVAL_REMINDERS } from '../../shared/constants/constants.js';
import {
  addDaysIso,
  localDateOf,
  workingDaysBetween,
} from '../../shared/helpers/helpers.js';
import { reachesIn, type PeopleScope } from '../access/index.js';
import type { AuthzRepository } from '../access/authz.repository.js';
import type { SettingsReader } from '../settings/index.js';
import type { ActorContext, PersonRow, PipRepository, PipRow } from './pip.repository.js';
import type { CancelPipInput, CreatePipInput, PipDto, PipOutcomeInput } from './pip.schema.js';

const LENGTH_DAYS = 60;
const EXTENSION_DAYS = 30;
const LINK_TEAM = '/my-team';
const LINK_ME = '/performance';
const LINK_HR = '/hr/quarter-reports';
const today = () => localDateOf(new Date());

type Actor = ActorContext & { actorEmployeeId: string };

/**
 * PIP (learner, 2026-11-05 — restarted after the test run):
 *  - never suggested by a score — it is the RM's own decision;
 *  - the effective RM writes the reason, targets and support (HR in reach
 *    does it when the person has no RM of their own); it is ACTIVE at once
 *    and runs a fixed 60 days — no HR approval, no acknowledgement, no
 *    check-ins; HR in reach and the employee get a bell;
 *  - at the end the RM records passed, one 30-day extension, or not passed —
 *    not passed tells HR, who may start a termination (Exits);
 *  - the RM or HR may withdraw it; a dispute doesn't pause it (§3.5).
 */
export const createPipService = (deps: {
  repo: PipRepository;
  authz: AuthzRepository;
  settings: SettingsReader;
}) => {
  const { repo, authz, settings } = deps;

  const hrScope = async (
    id: string,
    action: 'read' | 'update',
  ): Promise<PeopleScope | null> => {
    const access = await authz.resolveAccess(id, 'hrbp.people', action);
    if (!access.bypass && access.scopes.length === 0) return null;
    return authz.reachable(id, access);
  };

  const decorate = async (rows: PipRow[], viewerId: string): Promise<PipDto[]> => {
    const [people, hrU] = await Promise.all([
      repo.people(rows.flatMap((r) => [r.employeeId, r.rmId, r.outcomeBy ?? ''])),
      hrScope(viewerId, 'update'),
    ]);
    const name = (id: string | null) =>
      id ? { id, name: people.get(id)?.name ?? '' } : null;
    return rows.map((p) => {
      const emp = people.get(p.employeeId);
      const isRm = emp?.rm_id === viewerId || p.rmId === viewerId;
      const hr = !!hrU && reachesIn(hrU, p.employeeId) && viewerId !== p.employeeId;
      return {
        id: p.id,
        employee: {
          id: p.employeeId,
          name: emp?.name ?? '',
          employeeCode: emp?.employee_code ?? '',
          designation: emp?.designation ?? null,
        },
        rm: name(p.rmId)!,
        status: p.status,
        reason: p.reason,
        targets: p.targets as PipDto['targets'],
        support: p.support,
        startOn: p.startOn,
        endOn: p.endOn,
        extended: p.extended,
        outcomeNote: p.outcomeNote,
        outcomeBy: name(p.outcomeBy),
        outcomeAt: p.outcomeAt?.toISOString() ?? null,
        can: {
          outcome:
            p.status === 'active' &&
            today() >= p.endOn &&
            (isRm || (!emp?.rm_id && hr)) &&
            viewerId !== p.employeeId,
          cancel: p.status === 'active' && (isRm || hr) && viewerId !== p.employeeId,
        },
        createdAt: p.createdAt.toISOString(),
      };
    });
  };

  /** Visible to the person, their RM and HR in reach. */
  const visibleTo = async (rows: PipRow[], viewerId: string) => {
    const [hrR, people] = await Promise.all([
      hrScope(viewerId, 'read'),
      repo.people(rows.map((r) => r.employeeId)),
    ]);
    return rows.filter(
      (r) =>
        r.employeeId === viewerId ||
        r.rmId === viewerId ||
        people.get(r.employeeId)?.rm_id === viewerId ||
        (!!hrR && reachesIn(hrR, r.employeeId)),
    );
  };

  const list = async (viewerId: string, employeeId?: string) => {
    const rows = await visibleTo(await repo.list({ employeeId }), viewerId);
    rows.sort(
      (a, b) =>
        Number(b.status === 'active') - Number(a.status === 'active') ||
        b.createdAt.getTime() - a.createdAt.getTime(),
    );
    return decorate(rows, viewerId);
  };

  const get = async (id: string, viewerId: string) => {
    const p = await repo.find(id);
    if (!p || (await visibleTo([p], viewerId)).length === 0) {
      throw createError(404, 'PIP not found', { code: 'PIP_NOT_FOUND' });
    }
    return (await decorate([p], viewerId))[0]!;
  };

  const hrAudience = async (employeeId: string, except: string[] = []) =>
    (await authz.listBroadHolders('hrbp.people', 'update', employeeId)).filter(
      (x) => x !== employeeId && !except.includes(x),
    );

  /**
   * Who may open a PIP for this person: their RM; HR in reach only when they
   * have no RM of their own (none, or the administration account).
   */
  const mayStart = async (emp: PersonRow, viewerId: string) => {
    if (emp.id === viewerId) return false;
    const ownerId = await authz.ownerId();
    const hasRm = !!emp.rm_id && emp.rm_id !== ownerId;
    if (hasRm) return emp.rm_id === viewerId;
    const hr = await hrScope(viewerId, 'update');
    return !!hr && reachesIn(hr, emp.id);
  };

  /** For the person sheet: may the viewer start a PIP now (none running)? */
  const canStart = async (employeeId: string, viewerId: string) => {
    const emp = (await repo.people([employeeId])).get(employeeId) as PersonRow | undefined;
    if (!emp || emp.status !== 'active' || !(await mayStart(emp, viewerId))) return false;
    const live = (await repo.list({ employeeId })).some((p) =>
      ['pending_hr', 'active'].includes(p.status),
    );
    return !live;
  };

  const create = async (input: CreatePipInput, actor: Actor) => {
    const emp = (await repo.people([input.employeeId])).get(input.employeeId) as
      PersonRow | undefined;
    if (!emp)
      throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
    if (emp.id === actor.actorEmployeeId) {
      throw createError(403, 'You cannot open a PIP for yourself', { code: 'NO_SELF' });
    }
    if (!(await mayStart(emp, actor.actorEmployeeId))) {
      throw createError(403, 'Only their reporting manager opens a PIP', {
        code: 'NOT_THEIR_MANAGER',
      });
    }
    if (emp.status !== 'active') {
      throw createError(409, `${emp.name} is not active`, { code: 'NOT_ACTIVE' });
    }
    const start = input.startOn ?? today();
    if (start < today()) {
      throw createError(422, 'The start date cannot be in the past', {
        code: 'PAST_START',
      });
    }
    const id = await repo.insert(
      {
        employeeId: emp.id,
        rmId: actor.actorEmployeeId,
        reason: input.reason,
        targets: input.targets,
        support: input.support,
        startOn: start,
        endOn: addDaysIso(start, LENGTH_DAYS),
        status: 'active',
      },
      actor,
      [
        {
          to: [emp.id],
          event: {
            type: 'pip.started',
            title: `A performance improvement plan starts on ${start} and runs to ${addDaysIso(start, LENGTH_DAYS)}`,
            link: LINK_ME,
          },
        },
        {
          to: await hrAudience(emp.id, [actor.actorEmployeeId]),
          event: {
            type: 'pip.opened',
            title: `A PIP for ${emp.name} starts on ${start} (60 days)`,
            link: LINK_HR,
          },
        },
      ],
    );
    // TODO(email): also email the employee the plan once email is integrated.
    return get(id, actor.actorEmployeeId);
  };

  const load = async (id: string, actor: Actor) => {
    const p = await repo.find(id);
    if (!p) throw createError(404, 'PIP not found', { code: 'PIP_NOT_FOUND' });
    const [dto] = await decorate([p], actor.actorEmployeeId);
    return { p, dto: dto! };
  };

  const outcome = async (id: string, input: PipOutcomeInput, actor: Actor) => {
    const { p, dto } = await load(id, actor);
    if (!dto.can.outcome) {
      throw createError(
        409,
        `The outcome is recorded on or after ${p.endOn}, by their manager`,
        {
          code: 'NOT_YET',
        },
      );
    }
    if (input.outcome === 'extend') {
      if (p.extended) {
        throw createError(409, 'A PIP can be extended once', {
          code: 'ALREADY_EXTENDED',
        });
      }
      const end = addDaysIso(p.endOn, EXTENSION_DAYS);
      await repo.transition(
        id,
        ['active'],
        { extended: true, endOn: end, outcomeNote: input.note },
        actor,
        'pip.extended',
        [
          {
            to: [
              p.employeeId,
              ...(await hrAudience(p.employeeId, [actor.actorEmployeeId])),
            ],
            event: {
              type: 'pip.extended',
              title: `${dto.employee.name}'s PIP is extended to ${end}`,
              link: LINK_ME,
            },
          },
        ],
      );
      return get(id, actor.actorEmployeeId);
    }
    const passed = input.outcome === 'passed';
    await repo.transition(
      id,
      ['active'],
      {
        status: passed ? 'passed' : 'not_passed',
        outcomeNote: input.note,
        outcomeBy: actor.actorEmployeeId,
        outcomeAt: new Date(),
      },
      actor,
      passed ? 'pip.passed' : 'pip.not_passed',
      [
        {
          to: [p.employeeId],
          event: {
            type: 'pip.closed',
            title: passed
              ? 'Your performance improvement plan is completed — well done'
              : 'Your performance improvement plan was not met — HR will be in touch',
            link: LINK_ME,
          },
        },
        {
          to: await hrAudience(p.employeeId, [actor.actorEmployeeId]),
          event: {
            type: 'pip.closed',
            title: passed
              ? `${dto.employee.name} passed the PIP`
              : `${dto.employee.name} did not meet the PIP — you may start a termination (HR → Exits)`,
            link: passed ? LINK_HR : '/hr/exits',
          },
        },
      ],
    );
    return get(id, actor.actorEmployeeId);
  };

  const cancel = async (id: string, input: CancelPipInput, actor: Actor) => {
    const { p, dto } = await load(id, actor);
    if (!dto.can.cancel) throw createError(403, 'Not allowed', { code: 'FORBIDDEN' });
    await repo.transition(
      id,
      ['active'],
      {
        status: 'cancelled',
        outcomeNote: input.note,
        outcomeBy: actor.actorEmployeeId,
        outcomeAt: new Date(),
      },
      actor,
      'pip.cancelled',
      [
        {
          to: [p.employeeId, p.rmId].filter((x) => x !== actor.actorEmployeeId),
          event: {
            type: 'pip.cancelled',
            title: `${dto.employee.name}'s PIP was withdrawn`,
            link: LINK_ME,
          },
        },
      ],
    );
    return get(id, actor.actorEmployeeId);
  };

  /**
   * pip job (working days): ring the RM + HR (every 2 working days) once the
   * end date has passed with no outcome.
   */
  const daily = async (now: Date) => {
    const t = localDateOf(now);
    const rows = (await repo.list()).filter((p) => p.status === 'active');
    const rules = APPROVAL_REMINDERS;
    const [people, workWeek, holidays] = await Promise.all([
      repo.people(rows.map((r) => r.employeeId)),
      settings.effective('attendance.workWeek'),
      repo.holidaysBetween(addDaysIso(t, -60), t),
    ]);
    let overdue = 0;
    for (const p of rows) {
      const name = people.get(p.employeeId)?.name ?? 'Someone';
      if (p.endOn <= t) {
        const last = await repo.lastReminder('pip_outcome', p.id);
        if (
          last &&
          workingDaysBetween(localDateOf(last), t, workWeek, holidays) <
            rules.repeatEveryWorkingDays
        ) {
          continue;
        }
        await repo.remind('pip_outcome', p.id, {
          to: [p.rmId, ...(await hrAudience(p.employeeId))],
          event: {
            type: 'pip.outcome_due',
            title: `${name}'s PIP ended on ${p.endOn} — record the outcome`,
            link: LINK_TEAM,
          },
        });
        overdue += 1;
      }
    }
    return { active: rows.length, overdue };
  };

  return { list, get, canStart, create, outcome, cancel, daily };
};

export type PipService = ReturnType<typeof createPipService>;
