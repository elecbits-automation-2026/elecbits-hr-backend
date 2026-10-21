import createError from 'http-errors';
import { addDaysIso, hasOrgScope, localDateOf } from '../../shared/helpers/helpers.js';
import { reachesIn, type PeopleScope } from '../access/index.js';
import type { AuthzRepository } from '../access/authz.repository.js';
import type { OpsCustodyReader } from '../ops/index.js';
import type { SettingsReader } from '../settings/index.js';
import type { ExitsFnf } from './exits.fnf.js';
import { renderExitLetter } from './exits.letters.js';
import type {
  ActorContext,
  Bell,
  ClearanceRow,
  ExitPerson,
  ExitRow,
  ExitsRepository,
} from './exits.repository.js';
import {
  INTERVIEW_REASONS,
  type AcceptInput,
  type AcknowledgeInput,
  type CancelExitInput,
  type ClearInput,
  type ClearanceKind,
  type ExitDto,
  type InterviewInput,
  type MyExitPageDto,
  type ResignInput,
  type TerminateInput,
} from './exits.schema.js';

const LINK_HR = '/hr/exits';
const LINK_ME = '/resignation';
const LINK_TEAM = '/my-team';
const LIVE: ExitRow['status'][] = ['submitted', 'accepted', 'relieved'];
const today = () => localDateOf(new Date());
const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const KIND_LABEL: Record<ClearanceKind, string> = {
  hr: 'HR',
  manager: 'manager handover',
  ops: 'OPS (assets)',
  payroll: 'payroll',
};

/** What the caller may do, resolved once per request. */
interface Viewer {
  id: string;
  hrRead: PeopleScope | null;
  hrUpdate: PeopleScope | null;
  ops: boolean;
  payrollRead: boolean;
  payrollUpdate: boolean;
}

/**
 * Exit / offboarding (user decisions 2026-10-16).
 *
 *  - Resignation (by the employee, with a reason; the last day defaults to
 *    today + their notice days; withdrawable until HR accepts) or
 *    termination (HR; serve the notice, or leave earlier with the unserved
 *    notice paid in lieu). Nothing else.
 *  - The manager acknowledges with a handover plan; HR accepts and fixes the
 *    last working day; a short notice is waived (reason) or recovered on
 *    Basic. Accepted = the employee is `exiting`: sick leave only.
 *  - Four clearances, nobody clears their own: HR (from the resignation date),
 *    manager (during notice, after acknowledging), OPS (on the last day, only
 *    when the asset register shows nothing still held), payroll (set by
 *    finalizing the run that carries the F&F).
 *  - The leaver fills the exit interview on the last day. After it the
 *    scheduler relieves them: login off, open requests cancelled, the team
 *    left without an RM and HR told.
 *  - The F&F rides the next monthly payroll run; relieving and experience
 *    letters are issued once it is settled.
 */
export const createExitsService = (deps: {
  repo: ExitsRepository;
  authz: AuthzRepository;
  custody: OpsCustodyReader;
  fnf: ExitsFnf;
  settings: SettingsReader;
}) => {
  const { repo, authz, custody, fnf, settings } = deps;

  // ── Access ───────────────────────────────────────────────────────────────

  const scopeOf = async (id: string, module: string, action: 'read' | 'update') => {
    const access = await authz.resolveAccess(id, module, action);
    if (!access.bypass && access.scopes.length === 0) return null;
    return authz.reachable(id, access);
  };

  const viewerOf = async (id: string): Promise<Viewer> => {
    const [hrRead, hrUpdate, ops, prRead, prUpdate] = await Promise.all([
      scopeOf(id, 'hrbp.exits', 'read'),
      scopeOf(id, 'hrbp.exits', 'update'),
      authz.resolveAccess(id, 'ops.assets', 'update'),
      authz.resolveAccess(id, 'pr.payroll', 'read'),
      authz.resolveAccess(id, 'pr.payroll', 'update'),
    ]);
    return {
      id,
      hrRead,
      hrUpdate,
      ops: hasOrgScope(ops),
      payrollRead: hasOrgScope(prRead),
      payrollUpdate: hasOrgScope(prUpdate),
    };
  };

  const hrReaches = (scope: PeopleScope | null, employeeId: string) =>
    !!scope && reachesIn(scope, employeeId);

  const hrAudience = async (employeeId: string, except: (string | null)[] = []) =>
    (await authz.listBroadHolders('hrbp.exits', 'update', employeeId)).filter(
      (id) => !except.includes(id) && id !== employeeId,
    );

  const personOr404 = async (id: string): Promise<ExitPerson> => {
    const p = await repo.person(id);
    if (!p) throw createError(404, 'Employee not found', { code: 'EMPLOYEE_NOT_FOUND' });
    return p;
  };

  // ── View ─────────────────────────────────────────────────────────────────

  const opensOn = (x: ExitRow, kind: ClearanceKind): string | null => {
    if (kind === 'hr') return x.noticeStartOn;
    if (kind === 'manager') return x.acceptedAt ? localDateOf(x.acceptedAt) : null;
    if (kind === 'ops') return x.lastWorkingDay;
    return null;
  };

  /** Which clearances this viewer may sign now. */
  const clearableBy = (
    x: ExitRow,
    person: ExitPerson,
    clearances: ClearanceRow[],
    v: Viewer,
  ): ClearanceKind[] => {
    if (v.id === x.employeeId) return [];
    const pending = (k: ClearanceKind) =>
      clearances.some((c) => c.kind === k && !c.clearedAt);
    const isRm = person.effective_rm === v.id;
    const hr = hrReaches(v.hrUpdate, x.employeeId);
    const out: ClearanceKind[] = [];
    if (pending('hr') && hr && (x.status === 'submitted' || x.status === 'accepted')) {
      out.push('hr');
    }
    if (
      pending('manager') &&
      (isRm || (!person.effective_rm && hr)) &&
      x.status === 'accepted' &&
      !!x.acknowledgedAt
    ) {
      out.push('manager');
    }
    if (
      pending('ops') &&
      v.ops &&
      (x.status === 'accepted' || x.status === 'relieved') &&
      today() >= x.lastWorkingDay
    ) {
      out.push('ops');
    }
    return out;
  };

  const toDto = async (x: ExitRow, v: Viewer): Promise<ExitDto> => {
    const [person, clearances] = await Promise.all([
      personOr404(x.employeeId),
      repo.clearances([x.id]),
    ]);
    const names = await repo.names([
      x.initiatedBy,
      x.acknowledgedBy ?? '',
      x.acceptedBy ?? '',
      x.closedBy ?? '',
      ...clearances.map((c) => c.clearedBy ?? ''),
    ]);
    const ref = (id: string | null) => (id ? { id, name: names.get(id) ?? '' } : null);
    const isLeaver = v.id === x.employeeId;
    const isRm = person.effective_rm === v.id;
    const hrRead = hrReaches(v.hrRead, x.employeeId);
    const hrUpdate = hrReaches(v.hrUpdate, x.employeeId);
    const showMoney =
      (v.payrollRead || hrRead) && x.status !== 'withdrawn' && x.status !== 'cancelled';

    let fnfDto: ExitDto['fnf'] = null;
    if (
      showMoney &&
      (x.status === 'accepted' || x.status === 'relieved' || x.status === 'settled')
    ) {
      const [ctc, recoveries] = await Promise.all([
        repo.ctcOf(x.employeeId),
        repo.recoveries(x.id),
      ]);
      const lines = ctc === null ? null : await fnf.fnfFor(x, ctc);
      fnfDto = {
        encashedElDays: lines?.encashedElDays ?? 0,
        leaveEncashment: lines?.leaveEncashment ?? 0,
        gratuityYears: lines?.gratuityYears ?? 0,
        gratuity: lines?.gratuity ?? 0,
        noticePay: lines?.noticePay ?? 0,
        noticeRecovery: lines?.noticeRecovery ?? 0,
        sickLopDays: lines?.sickLopDays ?? 0,
        sickLopDeduction: lines?.sickLopDeduction ?? 0,
        fnfRecovery: lines?.fnfRecovery ?? 0,
        loanBalance: lines?.loanBalance ?? 0,
        recoveries: recoveries.map((r) => ({
          id: r.id,
          label: r.label,
          amount: Number(r.amount),
          note: r.note,
        })),
        hasSalary: ctc !== null,
      };
    }

    const live = LIVE.includes(x.status);
    return {
      id: x.id,
      employee: {
        id: person.id,
        name: person.name,
        employeeCode: person.employee_code,
        designation: person.designation,
        department: person.department,
        dateOfJoining: person.date_of_joining,
      },
      rm: person.effective_rm
        ? { id: person.effective_rm, name: person.rm_name ?? '' }
        : null,
      kind: x.kind,
      status: x.status,
      reason: x.reason,
      initiatedBy: ref(x.initiatedBy)!,
      noticeStartOn: x.noticeStartOn,
      noticeDays: x.noticeDays,
      proposedLastDay: x.proposedLastDay,
      lastWorkingDay: x.lastWorkingDay,
      servedDays: Math.max(0, daysBetween(x.noticeStartOn, x.lastWorkingDay)),
      shortfallDays: x.shortfallDays,
      shortfallAction: x.shortfallAction,
      shortfallReason: x.shortfallReason,
      terminationMode: x.terminationMode,
      handoverPlan: x.handoverPlan,
      acknowledgedBy: ref(x.acknowledgedBy),
      acknowledgedAt: x.acknowledgedAt?.toISOString() ?? null,
      acceptedBy: ref(x.acceptedBy),
      acceptedAt: x.acceptedAt?.toISOString() ?? null,
      closedBy: ref(x.closedBy),
      closedAt: x.closedAt?.toISOString() ?? null,
      closeReason: x.closeReason,
      relievedAt: x.relievedAt?.toISOString() ?? null,
      settledAt: x.settledAt?.toISOString() ?? null,
      clearances: (['hr', 'manager', 'ops', 'payroll'] as const).map((kind) => {
        const c = clearances.find((r) => r.kind === kind);
        return {
          kind,
          clearedBy: ref(c?.clearedBy ?? null),
          clearedAt: c?.clearedAt?.toISOString() ?? null,
          note: c?.note ?? null,
          opensOn: opensOn(x, kind),
        };
      }),
      interview:
        isLeaver || hrRead ? ((x.interview as ExitDto['interview']) ?? null) : null,
      interviewAt: x.interviewAt?.toISOString() ?? null,
      holdings:
        (v.ops || hrRead) && live ? await custody.openCustody(x.employeeId) : null,
      fnf: fnfDto,
      can: {
        withdraw: isLeaver && x.status === 'submitted',
        acknowledge:
          !isLeaver &&
          !x.acknowledgedAt &&
          (x.status === 'submitted' || x.status === 'accepted') &&
          (isRm || (!person.effective_rm && hrUpdate)),
        accept: !isLeaver && hrUpdate && x.status === 'submitted',
        cancel:
          !isLeaver && hrUpdate && (x.status === 'submitted' || x.status === 'accepted'),
        clear: clearableBy(x, person, clearances, v),
        interview:
          isLeaver &&
          x.status === 'accepted' &&
          today() >= x.lastWorkingDay &&
          !x.interviewAt,
        recoveries:
          !isLeaver &&
          v.payrollUpdate &&
          (x.status === 'accepted' || x.status === 'relieved'),
        documents: x.status === 'settled' && (isLeaver || hrRead || v.payrollRead),
      },
      createdAt: x.createdAt.toISOString(),
    };
  };

  /** Load an exit the caller may see (leaver, their RM, HR in reach, OPS, payroll). */
  const visible = async (id: string, v: Viewer): Promise<ExitRow> => {
    const x = await repo.find(id);
    if (!x) throw createError(404, 'Exit not found', { code: 'EXIT_NOT_FOUND' });
    if (
      x.employeeId === v.id ||
      v.ops ||
      v.payrollRead ||
      hrReaches(v.hrRead, x.employeeId)
    ) {
      return x;
    }
    const person = await repo.person(x.employeeId);
    if (person?.effective_rm === v.id) return x;
    throw createError(404, 'Exit not found', { code: 'EXIT_NOT_FOUND' });
  };

  const get = async (id: string, callerId: string) => {
    const v = await viewerOf(callerId);
    return toDto(await visible(id, v), v);
  };

  /** HR (in reach), OPS and payroll see the exits list; nobody else. */
  const list = async (callerId: string) => {
    const v = await viewerOf(callerId);
    if (!v.hrRead && !v.ops && !v.payrollRead) {
      throw createError(403, 'Exits are for HR, OPS and payroll', { code: 'FORBIDDEN' });
    }
    const rows = (await repo.list()).filter(
      (x) => v.ops || v.payrollRead || hrReaches(v.hrRead, x.employeeId),
    );
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.all(rows.map((x) => toDto(x, v)));
  };

  /** The manager's queue: exits of people who report to them. */
  const team = async (callerId: string) => {
    const v = await viewerOf(callerId);
    return Promise.all((await repo.forManager(callerId)).map((x) => toDto(x, v)));
  };

  const mine = async (callerId: string): Promise<MyExitPageDto> => {
    const [v, person, x] = await Promise.all([
      viewerOf(callerId),
      personOr404(callerId),
      repo.currentOf(callerId),
    ]);
    const notice = person.notice_days ?? 0;
    return {
      exit: x ? await toDto(x, v) : null,
      noticeDays: notice,
      defaultLastDay: addDaysIso(today(), notice),
      interviewReasons: [...INTERVIEW_REASONS],
    };
  };

  // ── Starting ─────────────────────────────────────────────────────────────

  /** A last day is from today on, and its month's payroll must still be open. */
  const assertLastDay = async (lastDay: string) => {
    if (lastDay < today()) {
      throw createError(422, 'The last working day cannot be in the past', {
        code: 'PAST_LAST_DAY',
      });
    }
    if (await repo.runLocked(lastDay.slice(0, 7))) {
      throw createError(
        409,
        `Payroll for ${lastDay.slice(0, 7)} is already finalized — pick a later day`,
        {
          code: 'RUN_LOCKED',
        },
      );
    }
  };

  const assertNoLiveExit = async (employeeId: string) => {
    const current = await repo.currentOf(employeeId);
    if (current && LIVE.includes(current.status)) {
      throw createError(409, 'There is already an exit in progress', {
        code: 'EXIT_EXISTS',
      });
    }
  };

  const shortfallOf = (noticeDays: number, start: string, lastDay: string) =>
    Math.max(0, noticeDays - Math.max(0, daysBetween(start, lastDay)));

  const resign = async (
    input: ResignInput,
    actor: ActorContext & { actorEmployeeId: string },
  ) => {
    const me = await personOr404(actor.actorEmployeeId);
    if (me.status !== 'active') {
      throw createError(409, 'Only an active employee can resign', {
        code: 'NOT_ACTIVE',
      });
    }
    if (me.is_owner) {
      throw createError(403, 'The administration account cannot resign', {
        code: 'OWNER',
      });
    }
    await assertNoLiveExit(me.id);
    const notice = me.notice_days ?? 0;
    const start = today();
    const lastDay = input.lastWorkingDay ?? addDaysIso(start, notice);
    await assertLastDay(lastDay);
    const bells: Bell[] = [
      ...(me.effective_rm
        ? [
            {
              to: [me.effective_rm],
              event: {
                type: 'exit.resigned',
                title: `${me.name} has resigned — proposed last day ${lastDay}. Acknowledge and plan the handover.`,
                link: LINK_TEAM,
              },
            },
          ]
        : []),
      {
        to: await hrAudience(me.id, [me.effective_rm]),
        event: {
          type: 'exit.resigned',
          title: `${me.name} has resigned — proposed last day ${lastDay}`,
          link: LINK_HR,
        },
      },
    ];
    await repo.insert(
      {
        employeeId: me.id,
        kind: 'resignation',
        status: 'submitted',
        reason: input.reason,
        initiatedBy: me.id,
        noticeStartOn: start,
        noticeDays: notice,
        proposedLastDay: lastDay,
        lastWorkingDay: lastDay,
        shortfallDays: shortfallOf(notice, start, lastDay),
      },
      actor,
      'exit.resigned',
      bells,
    );
    return mine(me.id);
  };

  const withdraw = async (
    id: string,
    actor: ActorContext & { actorEmployeeId: string },
  ) => {
    const x = await repo.find(id);
    if (!x || x.employeeId !== actor.actorEmployeeId) {
      throw createError(404, 'Exit not found', { code: 'EXIT_NOT_FOUND' });
    }
    if (x.status !== 'submitted') {
      throw createError(409, 'HR has already accepted it — ask HR to cancel', {
        code: 'ALREADY_ACCEPTED',
      });
    }
    const me = await personOr404(x.employeeId);
    const ok = await repo.transition(
      id,
      ['submitted'],
      {
        status: 'withdrawn',
        closedBy: me.id,
        closedAt: new Date(),
        closeReason: 'Withdrawn',
      },
      actor,
      'exit.withdrawn',
      [
        {
          to: [
            ...(me.effective_rm ? [me.effective_rm] : []),
            ...(await hrAudience(me.id)),
          ],
          event: {
            type: 'exit.withdrawn',
            title: `${me.name} withdrew their resignation`,
            link: LINK_HR,
          },
        },
      ],
    );
    if (!ok)
      throw createError(409, 'The exit changed meanwhile', { code: 'EXIT_CHANGED' });
    return mine(me.id);
  };

  /** HR ends someone's employment: serve the notice, or pay it in lieu. */
  const terminate = async (
    input: TerminateInput,
    actor: ActorContext & { actorEmployeeId: string },
  ) => {
    const v = await viewerOf(actor.actorEmployeeId);
    if (!hrReaches(v.hrUpdate, input.employeeId)) {
      throw createError(403, 'Terminations are started by HR', { code: 'FORBIDDEN' });
    }
    if (input.employeeId === actor.actorEmployeeId) {
      throw createError(422, 'You cannot terminate yourself', { code: 'SELF' });
    }
    const p = await personOr404(input.employeeId);
    if (p.is_owner) {
      throw createError(403, 'The administration account cannot be terminated', {
        code: 'OWNER',
      });
    }
    if (p.status !== 'active') {
      throw createError(409, `${p.name} is not active`, { code: 'NOT_ACTIVE' });
    }
    await assertNoLiveExit(p.id);
    await assertLastDay(input.lastWorkingDay);
    const notice = p.notice_days ?? 0;
    const start = today();
    const shortfall = shortfallOf(notice, start, input.lastWorkingDay);
    if (input.mode === 'serve' && shortfall > 0) {
      throw createError(
        422,
        `Serving the notice means a last day on or after ${addDaysIso(start, notice)} — or choose pay in lieu`,
        { code: 'NOTICE_NOT_SERVED' },
      );
    }
    const id = await repo.insert(
      {
        employeeId: p.id,
        kind: 'termination',
        status: 'accepted',
        reason: input.reason,
        initiatedBy: actor.actorEmployeeId,
        noticeStartOn: start,
        noticeDays: notice,
        proposedLastDay: input.lastWorkingDay,
        lastWorkingDay: input.lastWorkingDay,
        shortfallDays: shortfall,
        terminationMode: input.mode,
        acceptedBy: actor.actorEmployeeId,
        acceptedAt: new Date(),
      },
      actor,
      'exit.terminated',
      [
        {
          to: [p.id],
          event: {
            type: 'exit.terminated',
            title: `Your employment ends on ${input.lastWorkingDay}. HR will be in touch about the handover and your full & final.`,
            link: LINK_ME,
          },
        },
        ...(p.effective_rm && p.effective_rm !== actor.actorEmployeeId
          ? [
              {
                to: [p.effective_rm],
                event: {
                  type: 'exit.terminated',
                  title: `${p.name}'s employment ends on ${input.lastWorkingDay} — please plan the handover`,
                  link: LINK_TEAM,
                },
              },
            ]
          : []),
      ],
      'exiting',
    );
    return get(id, actor.actorEmployeeId);
  };

  // ── Steps ────────────────────────────────────────────────────────────────

  const acknowledge = async (
    id: string,
    input: AcknowledgeInput,
    actor: ActorContext & { actorEmployeeId: string },
  ) => {
    const v = await viewerOf(actor.actorEmployeeId);
    const x = await visible(id, v);
    const dto = await toDto(x, v);
    if (!dto.can.acknowledge) {
      throw createError(403, 'Only their manager acknowledges (HR when they have none)', {
        code: 'NOT_THEIR_MANAGER',
      });
    }
    const ok = await repo.transition(
      id,
      ['submitted', 'accepted'],
      {
        handoverPlan: input.handoverPlan,
        acknowledgedBy: actor.actorEmployeeId,
        acknowledgedAt: new Date(),
      },
      actor,
      'exit.acknowledged',
      [
        {
          to: await hrAudience(x.employeeId, [actor.actorEmployeeId]),
          event: {
            type: 'exit.acknowledged',
            title: `${dto.employee.name}'s manager acknowledged the exit and wrote the handover plan`,
            link: LINK_HR,
          },
        },
      ],
    );
    if (!ok)
      throw createError(409, 'The exit changed meanwhile', { code: 'EXIT_CHANGED' });
    return get(id, actor.actorEmployeeId);
  };

  const accept = async (
    id: string,
    input: AcceptInput,
    actor: ActorContext & { actorEmployeeId: string },
  ) => {
    const v = await viewerOf(actor.actorEmployeeId);
    const x = await visible(id, v);
    if (x.employeeId === actor.actorEmployeeId || !hrReaches(v.hrUpdate, x.employeeId)) {
      throw createError(403, 'HR accepts a resignation', { code: 'FORBIDDEN' });
    }
    if (x.status !== 'submitted') {
      throw createError(409, `This exit is ${x.status}`, { code: 'NOT_SUBMITTED' });
    }
    await assertLastDay(input.lastWorkingDay);
    const shortfall = shortfallOf(x.noticeDays, x.noticeStartOn, input.lastWorkingDay);
    if (shortfall > 0 && !input.shortfallAction) {
      throw createError(
        422,
        `The notice is ${shortfall} day(s) short — waive or recover it`,
        {
          code: 'SHORTFALL_DECISION',
        },
      );
    }
    if (
      shortfall > 0 &&
      input.shortfallAction === 'waive' &&
      !input.shortfallReason?.trim()
    ) {
      throw createError(422, 'Say why the shortfall is waived', {
        code: 'REASON_REQUIRED',
      });
    }
    const p = await personOr404(x.employeeId);
    const ok = await repo.transition(
      id,
      ['submitted'],
      {
        status: 'accepted',
        lastWorkingDay: input.lastWorkingDay,
        shortfallDays: shortfall,
        shortfallAction: shortfall > 0 ? input.shortfallAction! : null,
        shortfallReason: shortfall > 0 ? input.shortfallReason?.trim() || null : null,
        acceptedBy: actor.actorEmployeeId,
        acceptedAt: new Date(),
      },
      actor,
      'exit.accepted',
      [
        {
          to: [p.id],
          event: {
            type: 'exit.accepted',
            title: `HR accepted your resignation — your last working day is ${input.lastWorkingDay}`,
            link: LINK_ME,
          },
        },
        ...(p.effective_rm && p.effective_rm !== actor.actorEmployeeId
          ? [
              {
                to: [p.effective_rm],
                event: {
                  type: 'exit.accepted',
                  title: `${p.name}'s last working day is ${input.lastWorkingDay}`,
                  link: LINK_TEAM,
                },
              },
            ]
          : []),
      ],
      { id: p.id, status: 'exiting' },
    );
    if (!ok)
      throw createError(409, 'The exit changed meanwhile', { code: 'EXIT_CHANGED' });
    return get(id, actor.actorEmployeeId);
  };

  /** HR calls the exit off before the last day; the employee is active again. */
  const cancel = async (
    id: string,
    input: CancelExitInput,
    actor: ActorContext & { actorEmployeeId: string },
  ) => {
    const v = await viewerOf(actor.actorEmployeeId);
    const x = await visible(id, v);
    if (x.employeeId === actor.actorEmployeeId || !hrReaches(v.hrUpdate, x.employeeId)) {
      throw createError(403, 'HR cancels an exit', { code: 'FORBIDDEN' });
    }
    if (x.status !== 'submitted' && x.status !== 'accepted') {
      throw createError(409, `This exit is ${x.status} and can no longer be cancelled`, {
        code: 'NOT_CANCELLABLE',
      });
    }
    const p = await personOr404(x.employeeId);
    const ok = await repo.transition(
      id,
      ['submitted', 'accepted'],
      {
        status: 'cancelled',
        closedBy: actor.actorEmployeeId,
        closedAt: new Date(),
        closeReason: input.reason,
      },
      actor,
      'exit.cancelled',
      [
        {
          to: [p.id, ...(p.effective_rm ? [p.effective_rm] : [])],
          event: {
            type: 'exit.cancelled',
            title: `${p.name}'s exit was cancelled by HR`,
            body: input.reason,
            link: LINK_ME,
          },
        },
      ],
      p.status === 'exiting' ? { id: p.id, status: 'active' } : undefined,
    );
    if (!ok)
      throw createError(409, 'The exit changed meanwhile', { code: 'EXIT_CHANGED' });
    return get(id, actor.actorEmployeeId);
  };

  const clear = async (
    id: string,
    input: ClearInput,
    actor: ActorContext & { actorEmployeeId: string },
  ) => {
    const v = await viewerOf(actor.actorEmployeeId);
    const x = await visible(id, v);
    if (x.employeeId === actor.actorEmployeeId) {
      throw createError(403, 'Nobody clears their own exit', {
        code: 'NO_SELF_CLEARANCE',
      });
    }
    const [person, clearances] = await Promise.all([
      personOr404(x.employeeId),
      repo.clearances([x.id]),
    ]);
    if (input.kind === 'ops') {
      const held = await custody.openCustody(x.employeeId);
      if (held.assets.length + held.passes.length > 0) {
        throw createError(
          409,
          `Still held: ${[...held.assets, ...held.passes].map((a) => a.assetCode).join(', ')} — take them back first`,
          { code: 'ASSETS_OUTSTANDING' },
        );
      }
    }
    if (!clearableBy(x, person, clearances, v).includes(input.kind)) {
      const why: Record<ClearInput['kind'], string> = {
        hr: 'HR clears this while the exit is open',
        manager: 'Their manager clears this during notice, after acknowledging the exit',
        ops: 'OPS clears this on or after the last working day',
      };
      throw createError(409, why[input.kind], { code: 'CANNOT_CLEAR' });
    }
    const ok = await repo.clear(id, input.kind, input.note?.trim() || null, actor, [
      {
        to: await hrAudience(x.employeeId, [actor.actorEmployeeId]),
        event: {
          type: 'exit.cleared',
          title: `${person.name}: ${KIND_LABEL[input.kind]} clearance done`,
          link: LINK_HR,
        },
      },
    ]);
    if (!ok) throw createError(409, 'Already cleared', { code: 'ALREADY_CLEARED' });
    return get(id, actor.actorEmployeeId);
  };

  const interview = async (
    id: string,
    input: InterviewInput,
    actor: ActorContext & { actorEmployeeId: string },
  ) => {
    const v = await viewerOf(actor.actorEmployeeId);
    const x = await visible(id, v);
    const dto = await toDto(x, v);
    if (!dto.can.interview) {
      throw createError(409, 'The exit interview opens on your last working day', {
        code: 'INTERVIEW_CLOSED',
      });
    }
    const ok = await repo.saveInterview(id, input, actor, [
      {
        to: await hrAudience(x.employeeId),
        event: {
          type: 'exit.interview',
          title: `${dto.employee.name} filled the exit interview`,
          link: LINK_HR,
        },
      },
    ]);
    if (!ok)
      throw createError(409, 'The exit changed meanwhile', { code: 'EXIT_CHANGED' });
    return mine(actor.actorEmployeeId);
  };

  /** Relieving / experience letter, once the F&F is settled. */
  const letter = async (
    id: string,
    which: 'relieving' | 'experience',
    callerId: string,
  ) => {
    const v = await viewerOf(callerId);
    const x = await visible(id, v);
    const dto = await toDto(x, v);
    if (!dto.can.documents) {
      throw createError(409, 'Letters are issued once the full & final is settled', {
        code: 'NOT_SETTLED',
      });
    }
    const header = await settings.effective('payroll.payslipHeader');
    const pdf = await renderExitLetter({
      which,
      company: { name: header.companyName, address: header.address },
      employee: dto.employee,
      kind: x.kind,
      noticeStartOn: x.noticeStartOn,
      lastWorkingDay: x.lastWorkingDay,
      issuedOn: x.settledAt ? localDateOf(x.settledAt) : today(),
    });
    return { pdf, fileName: `${which}-letter-${dto.employee.employeeCode}.pdf` };
  };

  // ── Scheduler ────────────────────────────────────────────────────────────

  /**
   * exit-day job: on the last working day the leaver is asked for the exit
   * interview and OPS is told to collect assets; once it has passed the
   * leaver is relieved (login off, open requests cancelled, team without an
   * RM — HR is told who needs a new one).
   */
  const daily = async (now: Date) => {
    const t = localDateOf(now);
    const system: ActorContext = { actorUserId: null, actorEmployeeId: null };
    let reminded = 0;
    for (const x of await repo.lastDayToday(t)) {
      const ops = await authz.listBroadHolders('ops.assets', 'update');
      const held = await custody.openCustody(x.employee_id);
      const count = held.assets.length + held.passes.length;
      await repo.transition(x.id, ['accepted'], {}, system, 'exit.last_day', [
        {
          to: [x.employee_id],
          event: {
            type: 'exit.last_day',
            title: 'Today is your last working day — please fill in the exit interview',
            link: LINK_ME,
          },
        },
        {
          to: ops.filter((o) => o !== x.employee_id),
          event: {
            type: 'exit.last_day',
            title: `${x.name}'s last working day is today — ${count ? `${count} item(s) to collect` : 'nothing held'}; clear OPS`,
            link: LINK_HR,
          },
        },
      ]);
      reminded += 1;
    }
    let relieved = 0;
    let orphaned = 0;
    for (const x of await repo.dueToRelieve(t)) {
      const res = await repo.relieve(x, system);
      if (!res.ok) continue;
      relieved += 1;
      if (res.orphans.length) {
        orphaned += res.orphans.length;
        const leaver = await repo.person(x.employee_id);
        const hrbp = await authz.listBroadHolders('hrbp.people', 'update');
        await repo.transition(x.id, ['relieved'], {}, system, 'exit.team_without_rm', [
          {
            to: hrbp,
            event: {
              type: 'exit.team_without_rm',
              title: `${leaver?.name ?? 'A leaver'} has left — set a new reporting manager for ${res.orphans.map((o) => o.name).join(', ')}`,
              link: '/hr/people',
            },
          },
        ]);
      }
    }
    return { lastDay: reminded, relieved, orphaned };
  };

  return {
    list,
    team,
    mine,
    get,
    resign,
    withdraw,
    terminate,
    acknowledge,
    accept,
    cancel,
    clear,
    interview,
    letter,
    daily,
  };
};

export type ExitsService = ReturnType<typeof createExitsService>;
