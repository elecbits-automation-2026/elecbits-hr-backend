import createError from 'http-errors';
import { APPROVAL_REMINDERS } from '../../shared/constants/constants.js';
import {
  addDaysIso,
  localDateOf,
  workingDaysBetween,
} from '../../shared/helpers/helpers.js';
import { reachesIn, type PeopleScope } from '../access/index.js';
import type { AuthzRepository } from '../access/authz.repository.js';
import type { ExitsService } from '../exits/index.js';
import type { SettingsReader } from '../settings/index.js';
import { renderConfirmationLetter } from './probation.letter.js';
import type {
  ActorContext,
  ProbationRepository,
  ReviewRow,
  ReviewViewRow,
} from './probation.repository.js';
import type {
  DecideInput,
  ProbationReviewDto,
  RecommendInput,
} from './probation.schema.js';

const LINK_HR = '/hr/people';
const LINK_TEAM = '/my-team';
const OPEN: ReviewRow['status'][] = ['pending', 'recommended'];
const AUTO_AFTER_DAYS = 7;
const OPEN_BEFORE_DAYS = 7;

/**
 * The end-of-probation decision (close-out, user decisions 2026-10-16):
 *  - probation is a fixed 2 months, never extended;
 *  - a week before the date the RM is asked to recommend confirm or end;
 *  - HR (hrbp.people update in reach) decides — confirm (letter PDF) or end,
 *    which starts a termination exit (serve the notice or pay it in lieu);
 *  - from the date until decided HR is reminded every 2 working days, and 7
 *    days after it an undecided probation confirms by itself;
 *  - while open the person is still on probation (sick leave only).
 */
export const createProbationService = (deps: {
  repo: ProbationRepository;
  authz: AuthzRepository;
  exits: ExitsService;
  settings: SettingsReader;
}) => {
  const { repo, authz, exits, settings } = deps;

  const hrScope = async (
    id: string,
    action: 'read' | 'update',
  ): Promise<PeopleScope | null> => {
    const access = await authz.resolveAccess(id, 'hrbp.people', action);
    if (!access.bypass && access.scopes.length === 0) return null;
    return authz.reachable(id, access);
  };

  const toDto = (
    r: ReviewRow,
    p: ReviewViewRow | undefined,
    names: Map<string, string>,
    viewer: { id: string; hrUpdate: PeopleScope | null; hrRead: PeopleScope | null },
  ): ProbationReviewDto => {
    const ref = (id: string | null) => (id ? { id, name: names.get(id) ?? '' } : null);
    const open = OPEN.includes(r.status);
    const isRm = p?.rm_id === viewer.id;
    const hr = !!viewer.hrUpdate && reachesIn(viewer.hrUpdate, r.employeeId);
    const hrRead = !!viewer.hrRead && reachesIn(viewer.hrRead, r.employeeId);
    return {
      id: r.id,
      employee: {
        id: r.employeeId,
        name: p?.name ?? '',
        employeeCode: p?.employee_code ?? '',
        designation: p?.designation ?? null,
        department: p?.department ?? null,
        dateOfJoining: p?.date_of_joining ?? null,
      },
      rm: p?.rm_id ? { id: p.rm_id, name: p.rm_name ?? '' } : null,
      dueOn: r.dueOn,
      autoConfirmOn: addDaysIso(r.dueOn, AUTO_AFTER_DAYS),
      status: r.status,
      recommendation: r.recommendation,
      recommendationNote: r.recommendationNote,
      recommendedBy: ref(r.recommendedBy),
      recommendedAt: r.recommendedAt?.toISOString() ?? null,
      decidedBy: ref(r.decidedBy),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionNote: r.decisionNote,
      autoConfirmed: r.autoConfirmed,
      exitId: r.exitId,
      can: {
        recommend: open && viewer.id !== r.employeeId && (isRm || (!p?.rm_id && hr)),
        decide: open && viewer.id !== r.employeeId && hr,
        letter:
          r.status === 'confirmed' && (viewer.id === r.employeeId || isRm || hrRead),
      },
      createdAt: r.createdAt.toISOString(),
    };
  };

  const decorate = async (rows: ReviewRow[], viewerId: string) => {
    const [people, names, hrUpdate, hrRead] = await Promise.all([
      repo.people(rows.map((r) => r.employeeId)),
      repo.names(rows.flatMap((r) => [r.recommendedBy ?? '', r.decidedBy ?? ''])),
      hrScope(viewerId, 'update'),
      hrScope(viewerId, 'read'),
    ]);
    return rows.map((r) =>
      toDto(r, people.get(r.employeeId), names, { id: viewerId, hrUpdate, hrRead }),
    );
  };

  /** HR in reach and the RM of each person see their reviews. */
  const list = async (viewerId: string) => {
    const rows = await repo.list();
    const [hrRead, people] = await Promise.all([
      hrScope(viewerId, 'read'),
      repo.people(rows.map((r) => r.employeeId)),
    ]);
    const visible = rows.filter(
      (r) =>
        (hrRead && reachesIn(hrRead, r.employeeId)) ||
        people.get(r.employeeId)?.rm_id === viewerId,
    );
    visible.sort(
      (a, b) =>
        Number(OPEN.includes(b.status)) - Number(OPEN.includes(a.status)) ||
        a.dueOn.localeCompare(b.dueOn),
    );
    return decorate(visible, viewerId);
  };

  const mine = async (viewerId: string) => {
    const r = await repo.ofEmployee(viewerId);
    return r ? (await decorate([r], viewerId))[0]! : null;
  };

  const load = async (id: string, viewerId: string) => {
    const r = await repo.find(id);
    if (!r) throw createError(404, 'Probation review not found', { code: 'NOT_FOUND' });
    const [dto] = await decorate([r], viewerId);
    return { r, dto: dto! };
  };

  const recommend = async (
    id: string,
    input: RecommendInput,
    actor: ActorContext & { actorEmployeeId: string },
  ) => {
    const { r, dto } = await load(id, actor.actorEmployeeId);
    if (!dto.can.recommend) {
      throw createError(
        403,
        'Their reporting manager recommends (HR when they have none)',
        {
          code: 'NOT_THEIR_MANAGER',
        },
      );
    }
    const hr = await authz.listBroadHolders('hrbp.people', 'update', r.employeeId);
    const ok = await repo.transition(
      id,
      OPEN,
      {
        status: 'recommended',
        recommendation: input.recommendation,
        recommendationNote: input.note,
        recommendedBy: actor.actorEmployeeId,
        recommendedAt: new Date(),
      },
      actor,
      'probation.recommended',
      [
        {
          to: hr.filter((x) => x !== actor.actorEmployeeId && x !== r.employeeId),
          event: {
            type: 'probation.recommended',
            title: `${dto.employee.name}'s manager recommends: ${input.recommendation === 'confirm' ? 'confirm' : 'end'} the probation — decide by ${dto.dueOn}`,
            link: LINK_HR,
          },
        },
      ],
    );
    if (!ok) throw createError(409, 'The review changed meanwhile', { code: 'CHANGED' });
    return (await load(id, actor.actorEmployeeId)).dto;
  };

  const decide = async (
    id: string,
    input: DecideInput,
    actor: ActorContext & { actorEmployeeId: string },
  ) => {
    const { r, dto } = await load(id, actor.actorEmployeeId);
    if (!dto.can.decide) {
      throw createError(403, 'HR decides the probation', { code: 'FORBIDDEN' });
    }
    if (input.decision === 'confirm') {
      const ok = await repo.transition(
        id,
        OPEN,
        {
          status: 'confirmed',
          decidedBy: actor.actorEmployeeId,
          decidedAt: new Date(),
          decisionNote: input.note,
        },
        actor,
        'probation.confirmed',
        [
          {
            to: [r.employeeId],
            event: {
              type: 'probation.confirmed',
              title: 'Your probation is confirmed — your confirmation letter is ready',
              link: '/my-profile',
            },
          },
          ...(dto.rm && dto.rm.id !== actor.actorEmployeeId
            ? [
                {
                  to: [dto.rm.id],
                  event: {
                    type: 'probation.confirmed',
                    title: `${dto.employee.name}'s probation is confirmed`,
                    link: LINK_TEAM,
                  },
                },
              ]
            : []),
        ],
      );
      if (!ok)
        throw createError(409, 'The review changed meanwhile', { code: 'CHANGED' });
      return (await load(id, actor.actorEmployeeId)).dto;
    }
    // End: a termination exit carries it from here (notice or pay in lieu).
    if (!input.mode || !input.lastWorkingDay) {
      throw createError(
        422,
        'Ending a probation needs the notice choice and a last working day',
        {
          code: 'END_DETAILS_REQUIRED',
        },
      );
    }
    const exit = await exits.terminate(
      {
        employeeId: r.employeeId,
        reason: `Probation not confirmed: ${input.note}`,
        mode: input.mode,
        lastWorkingDay: input.lastWorkingDay,
      },
      actor,
    );
    await repo.transition(
      id,
      OPEN,
      {
        status: 'ended',
        decidedBy: actor.actorEmployeeId,
        decidedAt: new Date(),
        decisionNote: input.note,
        exitId: exit.id,
      },
      actor,
      'probation.ended',
      [],
    );
    return (await load(id, actor.actorEmployeeId)).dto;
  };

  const letter = async (id: string, viewerId: string) => {
    const { r, dto } = await load(id, viewerId);
    if (!dto.can.letter) {
      throw createError(404, 'Confirmation letter not found', { code: 'NOT_FOUND' });
    }
    const header = await settings.effective('payroll.payslipHeader');
    const pdf = await renderConfirmationLetter({
      company: { name: header.companyName, address: header.address },
      employee: dto.employee,
      confirmedOn: r.decidedAt ? localDateOf(r.decidedAt) : r.dueOn,
    });
    return { pdf, fileName: `confirmation-letter-${dto.employee.employeeCode}.pdf` };
  };

  /** Is this person still on probation because the decision is open? */
  const pendingFor = async (employeeId: string) => {
    const r = await repo.ofEmployee(employeeId);
    return !!r && OPEN.includes(r.status);
  };

  /**
   * probation job (working days): open reviews a week ahead and ask the RM;
   * past the date remind HR every 2 working days; 7 days after the date an
   * undecided probation confirms by itself and HR is told.
   */
  const daily = async (now: Date) => {
    const t = localDateOf(now);
    const system: ActorContext = { actorUserId: null, actorEmployeeId: null };
    let opened = 0;
    for (const p of await repo.dueToOpen(
      addDaysIso(t, -AUTO_AFTER_DAYS),
      addDaysIso(t, OPEN_BEFORE_DAYS),
    )) {
      const hr = await authz.listBroadHolders('hrbp.people', 'update', p.id);
      const id = await repo.insert({ employeeId: p.id, dueOn: p.due_on }, system, [
        {
          to: p.rm_id ? [p.rm_id] : hr,
          event: {
            type: 'probation.review',
            title: `${p.name}'s probation ends on ${p.due_on} — recommend confirm or end`,
            link: p.rm_id ? LINK_TEAM : LINK_HR,
          },
        },
      ]);
      if (id) opened += 1;
    }

    const rules = APPROVAL_REMINDERS;
    const [workWeek, holidays] = await Promise.all([
      settings.effective('attendance.workWeek'),
      repo.holidaysBetween(addDaysIso(t, -60), t),
    ]);
    let reminded = 0;
    let autoConfirmed = 0;
    for (const r of await repo.openPastDue(t)) {
      if (addDaysIso(r.due_on, AUTO_AFTER_DAYS) <= t) {
        const hr = await authz.listBroadHolders('hrbp.people', 'update', r.employee_id);
        const ok = await repo.transition(
          r.id,
          OPEN,
          { status: 'confirmed', autoConfirmed: true, decidedAt: new Date() },
          system,
          'probation.auto_confirmed',
          [
            {
              to: hr,
              event: {
                type: 'probation.confirmed',
                title: `${r.name}'s probation was confirmed automatically — no decision 7 days after ${r.due_on}`,
                link: LINK_HR,
              },
            },
            {
              to: [r.employee_id, ...(r.rm_id ? [r.rm_id] : [])],
              event: {
                type: 'probation.confirmed',
                title: `${r.name}'s probation is confirmed`,
                link: '/my-profile',
              },
            },
          ],
        );
        if (ok) autoConfirmed += 1;
        continue;
      }
      const last = await repo.lastReminder('probation_due', r.id);
      const since = last ? localDateOf(last) : r.due_on;
      if (
        last &&
        workingDaysBetween(since, t, workWeek, holidays) < rules.repeatEveryWorkingDays
      ) {
        continue;
      }
      const hr = await authz.listBroadHolders('hrbp.people', 'update', r.employee_id);
      await repo.remind('probation_due', r.id, {
        to: hr.filter((x) => x !== r.employee_id),
        event: {
          type: 'probation.overdue',
          title: `${r.name}'s probation ended on ${r.due_on} — decide (it confirms by itself on ${addDaysIso(r.due_on, AUTO_AFTER_DAYS)})`,
          link: LINK_HR,
        },
      });
      reminded += 1;
    }
    return { opened, reminded, autoConfirmed };
  };

  return { list, mine, recommend, decide, letter, pendingFor, daily };
};

export type ProbationService = ReturnType<typeof createProbationService>;
