import { randomBytes } from 'node:crypto';
import createError from 'http-errors';
import {
  addDaysIso,
  addWorkingDays,
  hashClaimToken,
  localDateOf,
} from '../../shared/helpers/helpers.js';
import type { AuthzRepository } from '../access/authz.repository.js';
import { createSelfGovernance } from '../access/selfGovernance.js';
import type { SettingsReader } from '../settings/index.js';
import type {
  ActorContext,
  Bell,
  ConcernNoteRow,
  ConcernRow,
  ConcernsRepository,
  NoteInsert,
} from './concerns.repository.js';
import {
  COMPLAINT_CATEGORIES,
  DISPUTE_AREAS,
  POSH_CATEGORY,
  WHISTLEBLOWER_CATEGORIES,
  type ConcernDto,
  type CreateConcernInput,
  type DecideInput,
  type DeclineInput,
  type EscalateInput,
  type ExtendInput,
  type FollowUpInput,
  type FollowUpNoteInput,
  type NoteInput,
  type QueueName,
  type QueueSummaryDto,
  type ResolveInput,
} from './concerns.schema.js';

const PREFIX = { dispute: 'DSP', complaint: 'CMP', whistleblower: 'WBR' } as const;
const CATEGORIES: Record<ConcernRow['track'], readonly string[]> = {
  dispute: DISPUTE_AREAS,
  complaint: COMPLAINT_CATEGORIES,
  whistleblower: WHISTLEBLOWER_CATEGORIES,
};
const QUEUE_LABEL: Record<QueueName, string> = {
  manager: 'Disputes waiting on you (level 1)',
  hr: 'HR — disputes (level 2) and complaints',
  mrc: 'Management Review Committee (level 3)',
  vigil: 'Whistleblower reports',
};
const LINK = '/concerns';

const notFound = () =>
  createError(404, 'Concern not found', { code: 'CONCERN_NOT_FOUND' });

/**
 * Concerns (Batch 4) — three policy tracks behind one "Raise a concern" form.
 *
 *  dispute       Dispute Resolution Framework: level 1 the effective RM, level
 *                2 HR (hrbp.grievances update reaching the raiser), level 3
 *                the Management Review Committee (concerns.mrcMembers),
 *                final. Each level ends in a written decision; the raiser
 *                accepts or escalates within concerns.timelines.escalateWithin
 *                working days. "About my manager" starts at level 2. Never
 *                anonymous. Filing pauses nothing (policy §3.5 — no stay).
 *  complaint     Equal Opportunity §J / anti-bullying: HR reaching the raiser
 *                (org HR when anonymous); acknowledge within complaintAck
 *                working days, outcome within the calendar-day target.
 *  whistleblower vigil team only (hrbp.vigil, org): plain HR never sees it.
 *
 * Everywhere: the SUBJECT of a case never sees or handles it; nobody handles
 * their own case; an earlier-level decider cannot decide level 3. Sexual
 * harassment is never stored (POSH → Internal Committee). Anonymous raisers
 * follow up with the case code + a key shown once (hash kept).
 */
export const createConcernsService = (deps: {
  repo: ConcernsRepository;
  authz: AuthzRepository;
  settings: SettingsReader;
}) => {
  const { repo, authz, settings } = deps;
  const selfGoverned = createSelfGovernance(authz);

  const today = () => localDateOf(new Date());
  const calendar = async () => {
    const [workWeek, holidays] = await Promise.all([
      settings.effective('attendance.workWeek'),
      repo.holidaysFrom(addDaysIso(today(), -1)),
    ]);
    return { workWeek, holidays };
  };
  const plusWorking = async (n: number) => {
    const { workWeek, holidays } = await calendar();
    return addWorkingDays(today(), n, workWeek, holidays);
  };

  /** Who may act on this case right now (never the raiser or the subject). */
  const handlersOf = async (c: ConcernRow): Promise<string[]> => {
    let ids: string[] = [];
    if (c.track === 'whistleblower') {
      ids = await authz.listBroadHolders('hrbp.vigil', 'update');
    } else if (c.track === 'dispute' && c.level === 1) {
      const raiser = c.raisedBy ? await repo.findEmployee(c.raisedBy) : undefined;
      const rm = raiser ? (raiser.leaveApprover ?? raiser.reportsTo) : null;
      ids = rm ? [rm] : [];
    } else if (c.track === 'dispute' && c.level === 3) {
      const [mrc, l2] = await Promise.all([
        settings.effective('concerns.mrcMembers'),
        repo.deciderAtLevel(c.id, 2),
      ]);
      ids = mrc.employeeIds.filter((id) => id !== l2);
    } else {
      // Dispute level 2 and complaints: HR whose grant reaches the raiser;
      // org-wide HR when the raiser is anonymous.
      ids = await authz.listBroadHolders(
        'hrbp.grievances',
        'update',
        c.raisedBy ?? undefined,
      );
    }
    return [...new Set(ids)].filter(
      (id) => id !== c.raisedBy && id !== c.subjectEmployeeId,
    );
  };

  const queueOf = (c: ConcernRow): QueueName =>
    c.track === 'whistleblower'
      ? 'vigil'
      : c.track === 'dispute' && c.level === 1
        ? 'manager'
        : c.track === 'dispute' && c.level === 3
          ? 'mrc'
          : 'hr';

  /** The deadline that matters now: an extension, else ack until acknowledged, else resolve. */
  const dueOf = (c: ConcernRow): string | null =>
    c.extendedTo ?? (c.ackAt === null && c.dueAckOn ? c.dueAckOn : c.dueResolveOn);

  const toNote = (
    n: ConcernNoteRow,
    c: ConcernRow,
    names: Map<string, string>,
  ): ConcernDto['notes'][number] => ({
    id: n.id,
    kind: n.kind,
    level: n.level,
    body: n.body,
    authorName: n.authorId ? (names.get(n.authorId) ?? null) : null,
    fromRaiser: n.authorId === null ? c.anonymous : n.authorId === c.raisedBy,
    visibleToRaiser: n.visibleToRaiser,
    createdAt: n.createdAt.toISOString(),
  });

  /** The DTO for one viewer: a handler sees everything, the raiser the visible thread. */
  const toDto = async (
    c: ConcernRow,
    view: 'handler' | 'raiser',
    viewerId: string | null,
  ): Promise<ConcernDto> => {
    const notes = (await repo.listNotes(c.id)).filter(
      (n) => view === 'handler' || n.visibleToRaiser,
    );
    const related = c.relatedConcernId
      ? await repo.findById(c.relatedConcernId)
      : undefined;
    const names = await repo.namesByIds(
      [...notes.map((n) => n.authorId), c.raisedBy, c.subjectEmployeeId].filter(
        (x): x is string => !!x,
      ),
    );
    const isHandler = view === 'handler';
    const live = !['closed', 'resolved', 'declined'].includes(c.status);
    const isRaiser = view === 'raiser';
    return {
      id: c.id,
      code: c.code,
      track: c.track,
      category: c.category,
      title: c.title,
      detail: c.detail,
      status: c.status,
      level: c.level,
      anonymous: c.anonymous,
      raisedBy: c.raisedBy ? { id: c.raisedBy, name: names.get(c.raisedBy) ?? '' } : null,
      subject:
        c.subjectEmployeeId && isHandler
          ? { id: c.subjectEmployeeId, name: names.get(c.subjectEmployeeId) ?? '' }
          : c.subjectEmployeeId && viewerId === c.raisedBy
            ? { id: c.subjectEmployeeId, name: names.get(c.subjectEmployeeId) ?? '' }
            : null,
      relatedCode: related?.code ?? null,
      dueAckOn: c.dueAckOn,
      dueResolveOn: c.dueResolveOn,
      extendedTo: c.extendedTo,
      escalateBy: c.escalateBy,
      ackAt: c.ackAt?.toISOString() ?? null,
      outcome: (c.outcome as ConcernDto['outcome']) ?? null,
      resolution: c.resolution,
      closedAt: c.closedAt?.toISOString() ?? null,
      createdAt: c.createdAt.toISOString(),
      can: {
        acknowledge:
          isHandler && live && c.ackAt === null && c.track !== 'dispute'
            ? true
            : isHandler &&
              live &&
              c.track === 'dispute' &&
              c.level === 2 &&
              c.ackAt === null,
        decide:
          isHandler &&
          c.track === 'dispute' &&
          ['open', 'acknowledged'].includes(c.status),
        resolve: isHandler && c.track !== 'dispute' && live,
        extend: isHandler && live && c.status !== 'decided',
        decline:
          isHandler &&
          c.track === 'dispute' &&
          c.level === 2 &&
          live &&
          c.status !== 'decided',
        accept: isRaiser && c.status === 'decided',
        escalate:
          isRaiser &&
          c.status === 'decided' &&
          (c.level ?? 3) < 3 &&
          c.escalateBy !== null &&
          today() <= c.escalateBy,
        note: live || c.status === 'decided',
      },
      notes: notes.map((n) => toNote(n, c, names)),
    };
  };

  /** Load + check the caller handles this case; 404 otherwise (never confirm it exists). */
  const asHandler = async (id: string, actorId: string) => {
    const c = await repo.findById(id);
    if (!c) throw notFound();
    const handlers = await handlersOf(c);
    if (!handlers.includes(actorId)) throw notFound();
    return { c, handlers };
  };

  /** Load + check the caller raised this (named) case. */
  const asRaiser = async (id: string, actorId: string) => {
    const c = await repo.findById(id);
    if (!c || c.anonymous || c.raisedBy !== actorId) throw notFound();
    return c;
  };

  const raiserBell = (c: ConcernRow, title: string): Bell[] =>
    c.raisedBy
      ? [{ to: [c.raisedBy], event: { type: 'concern.update', title, link: LINK } }]
      : [];

  const conflict = () =>
    createError(409, 'This case has moved on — reload it', { code: 'CONCERN_CONFLICT' });

  // ── Raise ────────────────────────────────────────────────────────────────

  const create = async (input: CreateConcernInput, actor: ActorContext) => {
    if (input.category === POSH_CATEGORY) {
      throw createError(
        422,
        'Sexual harassment is handled by the Internal Committee under the POSH policy — nothing is stored here',
        { code: 'POSH_ROUTE' },
      );
    }
    if (!CATEGORIES[input.track].includes(input.category)) {
      throw createError(422, 'Pick a category from the list', { code: 'BAD_CATEGORY' });
    }
    const anonymous = input.anonymous === true;
    if (anonymous && input.track === 'dispute') {
      throw createError(422, 'A dispute needs your name — you have a right to be heard', {
        code: 'DISPUTE_NOT_ANONYMOUS',
      });
    }
    if (input.subjectEmployeeId === actor.actorEmployeeId) {
      throw createError(422, 'You cannot raise a concern about yourself', {
        code: 'SELF_SUBJECT',
      });
    }
    if (input.subjectEmployeeId && !(await repo.findEmployee(input.subjectEmployeeId))) {
      throw createError(404, 'That person was not found', { code: 'EMPLOYEE_NOT_FOUND' });
    }
    const related = input.relatedCode
      ? await repo.findByCode(input.relatedCode)
      : undefined;
    if (input.relatedCode && !related) {
      throw createError(404, 'No case with that code', { code: 'CONCERN_NOT_FOUND' });
    }

    const rules = await settings.effective('concerns.timelines');
    let level: number | null = null;
    let dueAckOn: string | null = null;
    let dueResolveOn: string | null = null;
    if (input.track === 'dispute') {
      const me = await repo.findEmployee(actor.actorEmployeeId);
      const rm = me ? (me.leaveApprover ?? me.reportsTo) : null;
      // Level 1 is the manager — skipped when the decision was theirs, there
      // is no manager, or the raiser is self-governed (their "manager" is the
      // administration account).
      const skipL1 = input.aboutMyManager === true || !rm || (await selfGoverned(me));
      level = skipL1 ? 2 : 1;
      if (level === 1) dueResolveOn = await plusWorking(rules.l1Decide);
      else {
        dueAckOn = await plusWorking(rules.l2Ack);
        dueResolveOn = await plusWorking(rules.l2Decide);
      }
    } else {
      dueAckOn = await plusWorking(
        input.track === 'complaint' ? rules.complaintAck : rules.vigilAck,
      );
    }

    const key = anonymous ? randomBytes(24).toString('base64url') : null;
    const values = {
      track: input.track,
      category: input.category,
      subjectEmployeeId: input.subjectEmployeeId ?? null,
      relatedConcernId: related?.id ?? null,
      raisedBy: anonymous ? null : actor.actorEmployeeId,
      anonymous,
      followUpKeyHash: key ? hashClaimToken(key) : null,
      title: input.title,
      detail: input.detail,
      level,
      dueAckOn,
      dueResolveOn,
    };
    const draft = {
      ...values,
      id: '',
      code: '',
      status: 'open',
    } as unknown as ConcernRow;
    const handlers = await handlersOf(draft);
    const year = new Date().getFullYear();
    // Sequential codes; a collision (two at once) just takes the next number.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const code = await repo.nextCode(PREFIX[input.track], year);
      try {
        const row = await repo.insert(
          { ...values, code },
          {
            authorId: null,
            kind: 'system',
            level,
            body: anonymous
              ? 'Raised anonymously.'
              : level === 2 && input.track === 'dispute'
                ? 'Raised — goes straight to HR (level 2).'
                : 'Raised.',
            visibleToRaiser: true,
          },
          actor,
          [
            {
              to: handlers,
              event: {
                type: 'concern.raised',
                title: `New ${input.track === 'whistleblower' ? 'whistleblower report' : input.track} ${code}`,
                link: LINK,
              },
            },
          ],
        );
        return {
          concern: await toDto(
            row,
            anonymous ? 'raiser' : 'raiser',
            actor.actorEmployeeId,
          ),
          followUpKey: key,
        };
      } catch (err) {
        const pg = err as { code?: string; cause?: { code?: string } };
        if (pg.code !== '23505' && pg.cause?.code !== '23505') throw err;
      }
    }
    throw createError(409, 'Please try again', { code: 'CODE_CONFLICT' });
  };

  // ── Read ─────────────────────────────────────────────────────────────────

  const mine = async (actorId: string) =>
    Promise.all(
      (await repo.listByRaiser(actorId)).map((c) => toDto(c, 'raiser', actorId)),
    );

  /** Colleagues a concern can be about (never the caller). */
  const people = async (actorId: string) =>
    (await repo.people()).filter((p) => p.id !== actorId);

  /** Which queues the caller has, with open and overdue counts. */
  const queues = async (actorId: string): Promise<QueueSummaryDto[]> => {
    const t = today();
    const counts = new Map<QueueName, { open: number; overdue: number }>();
    for (const c of await repo.listActive()) {
      if (!(await handlersOf(c)).includes(actorId)) continue;
      const q = queueOf(c);
      const e = counts.get(q) ?? { open: 0, overdue: 0 };
      e.open += 1;
      const due = dueOf(c);
      if (due && due < t && c.status !== 'decided') e.overdue += 1;
      counts.set(q, e);
    }
    return [...counts.entries()].map(([queue, n]) => ({
      queue,
      label: QUEUE_LABEL[queue],
      ...n,
    }));
  };

  const queue = async (name: QueueName, actorId: string) => {
    const out: ConcernDto[] = [];
    for (const c of await repo.listActive()) {
      if (queueOf(c) !== name) continue;
      if (!(await handlersOf(c)).includes(actorId)) continue;
      out.push(await toDto(c, 'handler', actorId));
    }
    return out;
  };

  const get = async (id: string, actorId: string) => {
    const c = await repo.findById(id);
    if (!c) throw notFound();
    if (!c.anonymous && c.raisedBy === actorId) return toDto(c, 'raiser', actorId);
    if ((await handlersOf(c)).includes(actorId)) return toDto(c, 'handler', actorId);
    throw notFound();
  };

  // ── Thread ───────────────────────────────────────────────────────────────

  const addNote = async (id: string, input: NoteInput, actor: ActorContext) => {
    const c = await repo.findById(id);
    if (!c) throw notFound();
    const fromRaiser = !c.anonymous && c.raisedBy === actor.actorEmployeeId;
    const handlers = fromRaiser ? await handlersOf(c) : [];
    if (!fromRaiser) {
      const h = await handlersOf(c);
      if (!h.includes(actor.actorEmployeeId)) throw notFound();
    }
    if (['closed', 'resolved', 'declined'].includes(c.status)) {
      throw createError(409, 'This case is closed', { code: 'CONCERN_CLOSED' });
    }
    const visible = fromRaiser ? true : input.visibleToRaiser === true;
    const note: NoteInsert = {
      authorId: actor.actorEmployeeId,
      kind: fromRaiser ? 'note' : visible ? 'reply' : 'note',
      level: c.level,
      body: input.body,
      visibleToRaiser: visible,
    };
    const bells: Bell[] = fromRaiser
      ? [
          {
            to: handlers,
            event: {
              type: 'concern.update',
              title: `New information on ${c.code}`,
              link: LINK,
            },
          },
        ]
      : visible
        ? raiserBell(c, `A reply on your concern ${c.code}`)
        : [];
    await repo.addNote(c, note, actor, bells);
    return get(id, actor.actorEmployeeId);
  };

  // ── Handler actions ──────────────────────────────────────────────────────

  const acknowledge = async (id: string, actor: ActorContext) => {
    const { c } = await asHandler(id, actor.actorEmployeeId);
    if (c.ackAt)
      throw createError(409, 'Already acknowledged', { code: 'ALREADY_ACKNOWLEDGED' });
    if (c.track === 'dispute' && c.level !== 2) {
      throw createError(409, 'Only HR acknowledges a dispute (level 2)', {
        code: 'NOT_ACKNOWLEDGEABLE',
      });
    }
    const rules = await settings.effective('concerns.timelines');
    const dueResolveOn =
      c.track === 'complaint'
        ? addDaysIso(today(), rules.complaintResolveCalendarDays)
        : c.track === 'whistleblower'
          ? addDaysIso(today(), rules.vigilResolveCalendarDays)
          : c.dueResolveOn;
    const row = await repo.transition(
      id,
      c.status,
      {
        status: 'acknowledged',
        ackAt: new Date(),
        ackBy: actor.actorEmployeeId,
        dueResolveOn,
      },
      [
        {
          authorId: actor.actorEmployeeId,
          kind: 'system',
          level: c.level,
          body: `Acknowledged${dueResolveOn ? ` — outcome due by ${dueResolveOn}` : ''}.`,
          visibleToRaiser: true,
        },
      ],
      actor,
      'acknowledged',
      raiserBell(c, `Your concern ${c.code} was acknowledged`),
    );
    if (!row) throw conflict();
    return get(id, actor.actorEmployeeId);
  };

  /** A dispute level's written decision; the raiser then accepts or escalates. */
  const decide = async (id: string, input: DecideInput, actor: ActorContext) => {
    const { c } = await asHandler(id, actor.actorEmployeeId);
    if (c.track !== 'dispute')
      throw createError(409, 'Only disputes are decided by level', {
        code: 'NOT_A_DISPUTE',
      });
    if (!['open', 'acknowledged'].includes(c.status)) throw conflict();
    const rules = await settings.effective('concerns.timelines');
    const final = c.level === 3;
    const escalateBy = final ? null : await plusWorking(rules.escalateWithin);
    const row = await repo.transition(
      id,
      c.status,
      final
        ? {
            status: 'closed',
            levelDecidedAt: new Date(),
            levelDecidedBy: actor.actorEmployeeId,
            resolution: input.decision,
            closedAt: new Date(),
            escalateBy: null,
          }
        : {
            status: 'decided',
            levelDecidedAt: new Date(),
            levelDecidedBy: actor.actorEmployeeId,
            escalateBy,
          },
      [
        {
          authorId: actor.actorEmployeeId,
          kind: 'decision',
          level: c.level,
          body: input.decision,
          visibleToRaiser: true,
        },
      ],
      actor,
      final ? 'decided_final' : 'decided',
      raiserBell(
        c,
        final
          ? `Final decision on your dispute ${c.code} (Management Review Committee)`
          : `A decision on your dispute ${c.code} — accept it or escalate by ${escalateBy}`,
      ),
    );
    if (!row) throw conflict();
    return get(id, actor.actorEmployeeId);
  };

  const resolve = async (id: string, input: ResolveInput, actor: ActorContext) => {
    const { c } = await asHandler(id, actor.actorEmployeeId);
    if (c.track === 'dispute')
      throw createError(409, 'Disputes end with a decision', { code: 'IS_A_DISPUTE' });
    const row = await repo.transition(
      id,
      c.status,
      {
        status: 'resolved',
        outcome: input.outcome,
        resolution: input.resolution,
        closedAt: new Date(),
        ackAt: c.ackAt ?? new Date(),
        ackBy: c.ackBy ?? actor.actorEmployeeId,
      },
      [
        {
          authorId: actor.actorEmployeeId,
          kind: 'decision',
          level: null,
          body: input.resolution,
          visibleToRaiser: true,
        },
      ],
      actor,
      'resolved',
      raiserBell(c, `Your concern ${c.code} has an outcome`),
    );
    if (!row) throw conflict();
    return get(id, actor.actorEmployeeId);
  };

  /** Push a deadline out — the reason reaches the raiser as a written notice. */
  const extend = async (id: string, input: ExtendInput, actor: ActorContext) => {
    const { c } = await asHandler(id, actor.actorEmployeeId);
    if (input.to <= today()) {
      throw createError(422, 'The new date must be in the future', { code: 'BAD_DATE' });
    }
    const row = await repo.transition(
      id,
      c.status,
      { extendedTo: input.to, extensionReason: input.reason },
      [
        {
          authorId: actor.actorEmployeeId,
          kind: 'reply',
          level: c.level,
          body: `Timeline extended to ${input.to}: ${input.reason}`,
          visibleToRaiser: true,
        },
      ],
      actor,
      'extended',
      raiserBell(c, `The timeline on ${c.code} was extended to ${input.to}`),
    );
    if (!row) throw conflict();
    return get(id, actor.actorEmployeeId);
  };

  /** HR declines a repeat dispute on a closed matter (policy §9). */
  const decline = async (id: string, input: DeclineInput, actor: ActorContext) => {
    const { c } = await asHandler(id, actor.actorEmployeeId);
    if (c.track !== 'dispute' || c.level !== 2) {
      throw createError(409, 'Only HR declines a repeat dispute at level 2', {
        code: 'NOT_DECLINABLE',
      });
    }
    const related = input.relatedCode
      ? await repo.findByCode(input.relatedCode)
      : undefined;
    if (input.relatedCode && !related) {
      throw createError(404, 'No case with that code', { code: 'CONCERN_NOT_FOUND' });
    }
    const row = await repo.transition(
      id,
      c.status,
      {
        status: 'declined',
        relatedConcernId: related?.id ?? c.relatedConcernId,
        resolution: input.reason,
        closedAt: new Date(),
      },
      [
        {
          authorId: actor.actorEmployeeId,
          kind: 'decision',
          level: 2,
          body: input.reason,
          visibleToRaiser: true,
        },
      ],
      actor,
      'declined',
      raiserBell(c, `Your dispute ${c.code} was declined`),
    );
    if (!row) throw conflict();
    return get(id, actor.actorEmployeeId);
  };

  // ── Raiser actions (disputes) ────────────────────────────────────────────

  const accept = async (id: string, actor: ActorContext) => {
    const c = await asRaiser(id, actor.actorEmployeeId);
    if (c.status !== 'decided') throw conflict();
    const row = await repo.transition(
      id,
      'decided',
      { status: 'closed', closedAt: new Date() },
      [
        {
          authorId: actor.actorEmployeeId,
          kind: 'system',
          level: c.level,
          body: 'Decision accepted — closed.',
          visibleToRaiser: true,
        },
      ],
      actor,
      'accepted',
      [],
    );
    if (!row) throw conflict();
    return get(id, actor.actorEmployeeId);
  };

  const escalate = async (id: string, input: EscalateInput, actor: ActorContext) => {
    const c = await asRaiser(id, actor.actorEmployeeId);
    if (c.status !== 'decided' || (c.level ?? 3) >= 3) throw conflict();
    if (c.escalateBy && today() > c.escalateBy) {
      throw createError(409, `The window to escalate closed on ${c.escalateBy}`, {
        code: 'ESCALATION_WINDOW_CLOSED',
      });
    }
    const rules = await settings.effective('concerns.timelines');
    const next = (c.level ?? 1) + 1;
    const patch =
      next === 2
        ? {
            level: 2,
            status: 'open' as const,
            ackAt: null,
            ackBy: null,
            dueAckOn: await plusWorking(rules.l2Ack),
            dueResolveOn: await plusWorking(rules.l2Decide),
            escalateBy: null,
            extendedTo: null,
          }
        : {
            level: 3,
            status: 'open' as const,
            dueAckOn: null,
            dueResolveOn: await plusWorking(rules.l3Decide),
            escalateBy: null,
            extendedTo: null,
          };
    const nextHandlers = await handlersOf({ ...c, ...patch } as ConcernRow);
    const row = await repo.transition(
      id,
      'decided',
      patch,
      [
        {
          authorId: actor.actorEmployeeId,
          kind: 'note',
          level: next,
          body: `Escalated to level ${next}: ${input.reason}`,
          visibleToRaiser: true,
        },
      ],
      actor,
      'escalated',
      [
        {
          to: nextHandlers,
          event: {
            type: 'concern.raised',
            title: `Dispute ${c.code} escalated to ${next === 3 ? 'the Management Review Committee' : 'HR'}`,
            link: LINK,
          },
        },
      ],
    );
    if (!row) throw conflict();
    return get(id, actor.actorEmployeeId);
  };

  // ── Anonymous follow-up ──────────────────────────────────────────────────

  const byKey = async (input: FollowUpInput) => {
    const c = await repo.findByCode(input.code.toUpperCase());
    if (!c || !c.anonymous || c.followUpKeyHash !== hashClaimToken(input.key)) {
      throw createError(404, 'No case matches that code and key', {
        code: 'CONCERN_NOT_FOUND',
      });
    }
    return c;
  };

  const followUp = async (input: FollowUpInput) =>
    toDto(await byKey(input), 'raiser', null);

  const followUpNote = async (input: FollowUpNoteInput) => {
    const c = await byKey(input);
    if (['closed', 'resolved', 'declined'].includes(c.status)) {
      throw createError(409, 'This case is closed', { code: 'CONCERN_CLOSED' });
    }
    await repo.addNote(
      c,
      {
        authorId: null,
        kind: 'note',
        level: c.level,
        body: input.body,
        visibleToRaiser: true,
      },
      null,
      [
        {
          to: await handlersOf(c),
          event: {
            type: 'concern.update',
            title: `New information on ${c.code}`,
            link: LINK,
          },
        },
      ],
    );
    return toDto(c, 'raiser', null);
  };

  /** Overdue active cases with their handlers — the concern-deadlines job. */
  const overdue = async () => {
    const t = today();
    const out: Array<{ concern: ConcernRow; handlers: string[]; due: string }> = [];
    for (const c of await repo.overdueActive(t)) {
      const due = dueOf(c);
      if (!due) continue;
      out.push({ concern: c, handlers: await handlersOf(c), due });
    }
    return out;
  };

  return {
    create,
    mine,
    people,
    queues,
    queue,
    get,
    addNote,
    acknowledge,
    decide,
    resolve,
    extend,
    decline,
    accept,
    escalate,
    followUp,
    followUpNote,
    overdue,
  };
};

export type ConcernsService = ReturnType<typeof createConcernsService>;
