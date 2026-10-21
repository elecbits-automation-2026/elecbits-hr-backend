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
import type {
  ActorContext,
  CheckinRow,
  PersonRow,
  PipRepository,
  PipRow,
} from './pip.repository.js';
import type {
  CancelPipInput,
  CreateCheckinInput,
  CreatePipInput,
  DecidePipInput,
  PipDto,
  PipOutcomeInput,
} from './pip.schema.js';

const LENGTH_DAYS = 60;
const EXTENSION_DAYS = 30;
const CHECKIN_EVERY_DAYS = 14;
const LINK_TEAM = '/my-team';
const LINK_ME = '/performance';
const LINK_HR = '/hr/quarter-reports';
const today = () => localDateOf(new Date());

type Actor = ActorContext & { actorEmployeeId: string };

/**
 * PIP (close-out, user decisions 2026-10-16):
 *  - never automatic — a poor quarter score only rings the RM, who decides;
 *  - the RM (effective) writes the reason, targets and support; HR
 *    (hrbp.people update in reach) approves or declines;
 *  - the employee acknowledges; 60 days, a check-in every 2 weeks (the
 *    scheduler reminds the RM);
 *  - at the end the RM records passed, one 30-day extension, or not passed —
 *    not passed tells HR, who may start a termination (Exits);
 *  - a dispute doesn't pause it (Dispute policy §3.5).
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

  const nextCheckin = (p: PipRow, checkins: CheckinRow[]) => {
    if (p.status !== 'active') return null;
    const last = checkins.filter((c) => c.pipId === p.id).at(-1)?.on ?? p.startOn;
    const next = addDaysIso(last, CHECKIN_EVERY_DAYS);
    return next < p.endOn ? next : p.endOn;
  };

  const decorate = async (rows: PipRow[], viewerId: string): Promise<PipDto[]> => {
    const [checkins, people, hrU] = await Promise.all([
      repo.checkins(rows.map((r) => r.id)),
      repo.people(
        rows.flatMap((r) => [r.employeeId, r.rmId, r.hrBy ?? '', r.outcomeBy ?? '']),
      ),
      hrScope(viewerId, 'update'),
    ]);
    const more = await repo.people(checkins.map((c) => c.by));
    const name = (id: string | null) =>
      id ? { id, name: people.get(id)?.name ?? more.get(id)?.name ?? '' } : null;
    return rows.map((p) => {
      const emp = people.get(p.employeeId);
      const isRm = emp?.rm_id === viewerId || p.rmId === viewerId;
      const hr = !!hrU && reachesIn(hrU, p.employeeId) && viewerId !== p.employeeId;
      const own = checkins.filter((c) => c.pipId === p.id);
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
        hrBy: name(p.hrBy),
        hrAt: p.hrAt?.toISOString() ?? null,
        hrNote: p.hrNote,
        acknowledgedAt: p.acknowledgedAt?.toISOString() ?? null,
        outcomeNote: p.outcomeNote,
        outcomeBy: name(p.outcomeBy),
        outcomeAt: p.outcomeAt?.toISOString() ?? null,
        checkins: own.map((c) => ({
          id: c.id,
          on: c.on,
          rating: c.rating,
          note: c.note,
          by: name(c.by)!,
        })),
        nextCheckinOn: nextCheckin(p, checkins),
        can: {
          decide: p.status === 'pending_hr' && hr,
          acknowledge:
            p.status === 'active' && viewerId === p.employeeId && !p.acknowledgedAt,
          checkin:
            p.status === 'active' &&
            (isRm || (!emp?.rm_id && hr)) &&
            viewerId !== p.employeeId,
          outcome:
            p.status === 'active' &&
            today() >= p.endOn &&
            (isRm || (!emp?.rm_id && hr)) &&
            viewerId !== p.employeeId,
          cancel:
            (p.status === 'pending_hr' && (isRm || hr)) || (p.status === 'active' && hr),
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
        Number(['pending_hr', 'active'].includes(b.status)) -
          Number(['pending_hr', 'active'].includes(a.status)) ||
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

  const create = async (input: CreatePipInput, actor: Actor) => {
    const emp = (await repo.people([input.employeeId])).get(input.employeeId) as
      PersonRow | undefined;
    if (!emp)
      throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
    if (emp.rm_id !== actor.actorEmployeeId) {
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
      },
      actor,
      [
        {
          to: await hrAudience(emp.id, [actor.actorEmployeeId]),
          event: {
            type: 'pip.opened',
            title: `A PIP for ${emp.name} is waiting for your approval`,
            link: LINK_HR,
          },
        },
      ],
    );
    return get(id, actor.actorEmployeeId);
  };

  const load = async (id: string, actor: Actor) => {
    const p = await repo.find(id);
    if (!p) throw createError(404, 'PIP not found', { code: 'PIP_NOT_FOUND' });
    const [dto] = await decorate([p], actor.actorEmployeeId);
    return { p, dto: dto! };
  };

  const decide = async (id: string, input: DecidePipInput, actor: Actor) => {
    const { p, dto } = await load(id, actor);
    if (!dto.can.decide)
      throw createError(403, 'HR approves a PIP', { code: 'FORBIDDEN' });
    if (!input.approve && !input.note?.trim()) {
      throw createError(422, 'Say why it is declined', { code: 'REASON_REQUIRED' });
    }
    const ok = await repo.transition(
      id,
      ['pending_hr'],
      {
        status: input.approve ? 'active' : 'cancelled',
        hrBy: actor.actorEmployeeId,
        hrAt: new Date(),
        hrNote: input.note?.trim() || null,
      },
      actor,
      input.approve ? 'pip.approved' : 'pip.declined',
      input.approve
        ? [
            {
              to: [p.employeeId],
              event: {
                type: 'pip.started',
                title: `A performance improvement plan starts on ${p.startOn} — please read and acknowledge it`,
                link: LINK_ME,
              },
            },
            {
              to: [p.rmId],
              event: {
                type: 'pip.started',
                title: `HR approved ${dto.employee.name}'s PIP (${p.startOn} → ${p.endOn})`,
                link: LINK_TEAM,
              },
            },
          ]
        : [
            {
              to: [p.rmId],
              event: {
                type: 'pip.declined',
                title: `HR declined ${dto.employee.name}'s PIP`,
                body: input.note,
                link: LINK_TEAM,
              },
            },
          ],
    );
    if (!ok) throw createError(409, 'The PIP changed meanwhile', { code: 'CHANGED' });
    return get(id, actor.actorEmployeeId);
  };

  const acknowledge = async (id: string, actor: Actor) => {
    const { p, dto } = await load(id, actor);
    if (!dto.can.acknowledge) {
      throw createError(409, 'Nothing to acknowledge', { code: 'NOTHING_TO_ACK' });
    }
    await repo.transition(
      id,
      ['active'],
      { acknowledgedAt: new Date() },
      actor,
      'pip.acknowledged',
      [
        {
          to: [p.rmId],
          event: {
            type: 'pip.acknowledged',
            title: `${dto.employee.name} acknowledged the PIP`,
            link: LINK_TEAM,
          },
        },
      ],
    );
    return get(id, actor.actorEmployeeId);
  };

  const checkin = async (id: string, input: CreateCheckinInput, actor: Actor) => {
    const { p, dto } = await load(id, actor);
    if (!dto.can.checkin) {
      throw createError(403, 'Their manager logs the check-ins', { code: 'FORBIDDEN' });
    }
    await repo.addCheckin(
      {
        pipId: id,
        on: today(),
        rating: input.rating,
        note: input.note,
        by: actor.actorEmployeeId,
      },
      actor,
      [
        {
          to: [p.employeeId],
          event: {
            type: 'pip.checkin',
            title: 'Your manager logged a PIP check-in',
            link: LINK_ME,
          },
        },
      ],
    );
    return get(id, actor.actorEmployeeId);
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
      ['pending_hr', 'active'],
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
   * pip job (working days): ring the RM when a fortnightly check-in is due,
   * and the RM + HR (every 2 working days) once the end date has passed with
   * no outcome.
   */
  const daily = async (now: Date) => {
    const t = localDateOf(now);
    const rows = (await repo.list()).filter((p) => p.status === 'active');
    const rules = APPROVAL_REMINDERS;
    const [checkins, people, workWeek, holidays] = await Promise.all([
      repo.checkins(rows.map((r) => r.id)),
      repo.people(rows.map((r) => r.employeeId)),
      settings.effective('attendance.workWeek'),
      repo.holidaysBetween(addDaysIso(t, -60), t),
    ]);
    let checkinsDue = 0;
    let overdue = 0;
    for (const p of rows) {
      const name = people.get(p.employeeId)?.name ?? 'Someone';
      const due = nextCheckin(p, checkins);
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
        continue;
      }
      if (due && due <= t) {
        const last = await repo.lastReminder('pip_checkin', p.id);
        if (last && localDateOf(last) >= due) continue;
        await repo.remind('pip_checkin', p.id, {
          to: [p.rmId],
          event: {
            type: 'pip.checkin_due',
            title: `A PIP check-in with ${name} is due`,
            link: LINK_TEAM,
          },
        });
        checkinsDue += 1;
      }
    }
    return { active: rows.length, checkinsDue, overdue };
  };

  return { list, get, create, decide, acknowledge, checkin, outcome, cancel, daily };
};

export type PipService = ReturnType<typeof createPipService>;
