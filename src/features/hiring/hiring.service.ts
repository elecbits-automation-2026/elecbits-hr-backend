import createError from 'http-errors';
import { addDaysIso, localDateOf } from '../../shared/helpers/helpers.js';
import { quarterOf } from '../performance/index.js';
import type { SettingsReader } from '../settings/index.js';
import type {
  ActorContext,
  ApprovalRow,
  Bell,
  DocumentKind,
  DocumentRow,
  HiringRepository,
  PositionRow,
  PositionStatus,
  RequisitionRow,
  RequisitionStatus,
  RoundRow,
  SourceRow,
} from './hiring.repository.js';
import {
  APPROVER_ROLES,
  DOC_ROLES,
  type ApproverRole,
  type AssignPositionInput,
  type AssignTaRmInput,
  type CreateRequisitionInput,
  type DecideRequisitionInput,
  type DocRole,
  type DocumentReviewDto,
  type HiringMeDto,
  type HiringPlanDto,
  type JdContent,
  type RequisitionDto,
  type ScorecardContent,
  type TaDocumentDto,
  type RecruiterOptionDto,
  type TaRmOptionDto,
  type UpdateRequisitionInput,
  type AddSourceInput,
} from './hiring.schema.js';

const LINK_PLAN = '/hiring/plan';
const LINK_APPROVALS = '/hiring/approvals';
// The Admin account lives in the Admin console only (PortalShell).
const LINK_ADMIN_APPROVALS = '/admin/hiring-approvals';
const LINK_TA = '/hr/hiring';
const LINK_PERFORMANCE = '/performance';

/** The plan window (setting `hiring.planWindow`). */
export interface PlanWindow {
  remindDaysBefore: number;
  deadlineDaysBefore: number;
}

/** First day of a 'YYYY-Qn' quarter. */
const quarterStart = (quarter: string) => {
  const [y, q] = quarter.split('-Q').map(Number) as [number, number];
  return `${y}-${String((q - 1) * 3 + 1).padStart(2, '0')}-01`;
};

/** The day a quarter's plan closes: its submitted lines go for approval the day after. */
export const planDeadline = (quarter: string, w: PlanWindow) =>
  addDaysIso(quarterStart(quarter), -w.deadlineDaysBefore);

/**
 * The quarter department heads plan for now: the first quarter after today
 * whose deadline hasn't passed. A line added after a deadline lands in the
 * following quarter's plan (TA design: late lines wait; urgent needs are
 * hired offline for now and added through HR → People).
 */
export const planningQuarter = (today: string, w: PlanWindow) => {
  let q = quarterOf(new Date(`${today}T00:00:00`));
  for (;;) {
    q = quarterOf(new Date(`${addDaysIso(q.endDate, 1)}T00:00:00`));
    const deadline = planDeadline(q.name, w);
    if (today <= deadline) return { quarter: q.name, deadline };
  }
};

/**
 * A hiring goal's progress follows its position (TA design) — never typed in.
 * awaiting docs 0 → open 25 → interviewing 50 → offer 75 → filled 100.
 */
export const POSITION_PROGRESS: Record<PositionStatus, number> = {
  awaiting_docs: 0,
  open: 25,
  interviewing: 50,
  offer: 75,
  filled: 100,
  cancelled: 0,
};

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

/**
 * Who reviews a position's JD / scorecard: the line's TA RM + the dept head —
 * the dept head alone when the TA RM is the recruiter (no self-approval).
 */
export const docReviewers = (
  recruiterId: string | null,
  taRmId: string | null,
): DocRole[] =>
  recruiterId && recruiterId === taRmId ? ['dept_head'] : [...DOC_ROLES];

const toDocument = (
  d: DocumentRow,
  approvals: ApprovalRow[],
  needed: DocRole[],
): TaDocumentDto => {
  const current = approvals.filter(
    (a) => a.subject_id === d.id && a.version === d.version,
  );
  return {
    id: d.id,
    kind: d.kind,
    version: d.version,
    status: d.status,
    content: d.content,
    writtenByName: d.written_by_name,
    returnReason: d.return_reason,
    approvals: current.map((a) => ({
      role: a.role as DocRole,
      decision: a.decision,
      decidedByName: a.decided_by_name,
      reason: a.reason,
      decidedAt: new Date(a.decided_at).toISOString(),
    })),
    waitingOn:
      d.status === 'in_review'
        ? needed.filter((role) => !current.some((a) => (a.role as string) === role))
        : [],
    submittedAt: iso(d.submitted_at),
    approvedAt: iso(d.approved_at),
  };
};


const toDto = (
  r: RequisitionRow,
  rounds: RoundRow[],
  approvals: ApprovalRow[],
  positions: PositionRow[],
  docs: DocumentRow[],
  docApprovals: ApprovalRow[],
  sources: SourceRow[],
): RequisitionDto => {
  // Only today's approver roles count (the retired TA head's rows stay as history).
  const current = approvals.filter(
    (a) =>
      a.subject_id === r.id &&
      a.version === r.version &&
      (APPROVER_ROLES as readonly string[]).includes(a.role),
  );
  const doc = (p: PositionRow, kind: DocumentKind) => {
    const d = docs.find((x) => x.position_id === p.id && x.kind === kind);
    return d ? toDocument(d, docApprovals, docReviewers(p.recruiter_id, r.ta_rm_id)) : null;
  };
  return {
    id: r.id,
    departmentId: r.department_id,
    departmentName: r.department_name,
    quarter: r.quarter,
    roleTitle: r.role_title,
    quantity: r.quantity,
    notes: r.notes,
    requestCode: r.request_code,
    reason: r.reason,
    targetJoiningOn: r.target_joining_on,
    location: r.location,
    reportingManager: r.reporting_manager_id
      ? { id: r.reporting_manager_id, name: r.reporting_manager_name ?? '' }
      : null,
    priority: r.priority,
    employmentType: r.employment_type,
    version: r.version,
    status: r.status,
    urgent: r.urgent,
    rounds: rounds
      .filter((x) => x.requisition_id === r.id)
      .map((x) => ({
        round: x.round,
        interviewerId: x.interviewer_id,
        interviewerName: x.interviewer_name,
      })),
    approvals: current.map((a) => ({
      role: a.role,
      decision: a.decision,
      decidedByName: a.decided_by_name,
      reason: a.reason,
      decidedAt: new Date(a.decided_at).toISOString(),
    })),
    waitingOn:
      r.status === 'submitted'
        ? APPROVER_ROLES.filter((role) => !current.some((a) => a.role === role))
        : [],
    returnReason: r.return_reason,
    createdByName: r.created_by_name,
    submittedAt: iso(r.submitted_at),
    approvedAt: iso(r.approved_at),
    taRm: r.ta_rm_id ? { id: r.ta_rm_id, name: r.ta_rm_name ?? '' } : null,
    taRmAssignedAt: iso(r.ta_rm_assigned_at),
    createdAt: new Date(r.created_at).toISOString(),
    positions: positions
      .filter((p) => p.requisition_id === r.id)
      .map((p) => ({
        id: p.id,
        number: p.number,
        status: p.status,
        priority: p.priority,
        expectedCloseOn: p.expected_close_on,
        sources: sources
          .filter((s) => s.position_id === p.id)
          .map((s) => ({
            id: s.id,
            channel: s.channel,
            activatedOn: s.activated_on,
            spocName: s.spoc_name,
            notes: s.notes,
          })),
        recruiterId: p.recruiter_id,
        recruiterName: p.recruiter_name,
        goal: p.goal_id
          ? {
              id: p.goal_id,
              weight: Number(p.goal_weight),
              progress: p.goal_progress ?? 0,
            }
          : null,
        openedAt: iso(p.opened_at),
        documents: { jd: doc(p, 'jd'), scorecard: doc(p, 'scorecard') },
      })),
  };
};

/**
 * Hiring (TA design).
 *
 * Step B: a department's head fills a quarterly plan, line by line; each line
 * is approved on its own by the head of the HR department (setting
 * `hiring.hrDepartment`) and the Admin account — any order. The HR
 * department's own lines can't be approved by its head (no self-approval), so
 * they wait — a known gap, accepted in the TA design. A reject returns the
 * line; editing it starts a new version and every earlier approval stops
 * counting.
 *
 * Step C: an approved line for N creates N positions. Admin gives the line to
 * a TA RM (a TA-batch holder with reports), who gives each position to one of
 * their own reports (or keeps it themselves) through a hiring goal whose
 * progress follows the position. Each position's RECRUITER writes its own JD
 * and scorecard; the line's TA RM + department head review each separately
 * (the dept head alone when the TA RM is the recruiter). When both are
 * approved that position opens.
 *
 * Rights come from SEATS (relationships), not grants — except TA's own work
 * (the `ta.hiring` grant: the HR-wide list, writing JDs and scorecards).
 */
export const createHiringService = (deps: {
  repo: HiringRepository;
  settings: SettingsReader;
}) => {
  const { repo, settings } = deps;

  const holdersNow = async () =>
    repo.approverHolders((await settings.effective('hiring.hrDepartment')).departmentId);

  const planWindow = () => settings.effective('hiring.planWindow');
  const planningNow = async () => planningQuarter(localDateOf(new Date()), await planWindow());

  const hydrate = async (rows: RequisitionRow[]): Promise<RequisitionDto[]> => {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [rounds, approvals, positions, docs] = await Promise.all([
      repo.roundsOf(ids),
      repo.approvalsOf(ids),
      repo.positionsOf(ids),
      repo.documentsOf(ids),
    ]);
    const docApprovals = docs.length
      ? await repo.documentApprovalsOf(docs.map((d) => d.id))
      : [];
    const sources = positions.length ? await repo.sourcesOf(positions.map((p) => p.id)) : [];
    return rows.map((r) =>
      toDto(r, rounds, approvals, positions, docs, docApprovals, sources),
    );
  };

  /** Any HRBP-batch holder approves hiring requests (TA workflow deck, 2026-10-27). */
  const rolesOf = async (employeeId: string): Promise<ApproverRole[]> =>
    (await repo.hrbpHolders()).includes(employeeId) ? ['hrbp'] : [];

  /** The reporting manager must be an active employee (not the Admin account). */
  const assertManager = async (id: string | undefined) => {
    if (!id) return;
    if (!(await repo.eligiblePeople([id])).has(id)) {
      throw createError(422, 'The reporting manager must be an active employee', {
        code: 'MANAGER_NOT_ELIGIBLE',
      });
    }
  };

  const notHead = () =>
    createError(403, 'Only the head of this department can change its hiring plan', {
      code: 'NOT_DEPARTMENT_HEAD',
    });

  const findOr404 = async (id: string): Promise<RequisitionRow> => {
    const r = await repo.findRequisition(id);
    if (!r)
      throw createError(404, 'Requisition not found', { code: 'REQUISITION_NOT_FOUND' });
    return r;
  };

  /** The line, if the caller is its department's current head (or acting head). */
  const asHead = async (employeeId: string, id: string): Promise<RequisitionRow> => {
    const r = await findOr404(id);
    if ((await repo.departmentHead(r.department_id)) !== employeeId) throw notHead();
    return r;
  };

  const assertHeadOf = async (employeeId: string, departmentId: string) => {
    if ((await repo.departmentHead(departmentId)) !== employeeId) throw notHead();
  };

  const assertInterviewers = async (rounds: CreateRequisitionInput['rounds']) => {
    const ids = [
      ...new Set(rounds.map((r) => r.interviewerId).filter((x): x is string => !!x)),
    ];
    if (ids.length === 0) return;
    const ok = await repo.eligiblePeople(ids);
    if (ids.some((id) => !ok.has(id))) {
      throw createError(422, 'Interviewers must be active employees', {
        code: 'INTERVIEWER_NOT_ELIGIBLE',
      });
    }
  };

  const me = async (employeeId: string): Promise<HiringMeDto> => ({
    headOf: (await repo.headOf(employeeId)).map((d) => ({
      departmentId: d.department_id,
      departmentName: d.department_name,
      acting: d.acting,
    })),
    approverRoles: await rolesOf(employeeId),
    ...(await planningNow().then((p) => ({ planQuarter: p.quarter, planDeadline: p.deadline }))),
  });

  const plan = async (
    employeeId: string,
    departmentId: string,
    quarter: string,
  ): Promise<HiringPlanDto> => {
    await assertHeadOf(employeeId, departmentId);
    return {
      departmentId,
      quarter,
      deadline: planDeadline(quarter, await planWindow()),
      open: quarter === (await planningNow()).quarter,
      requisitions: await hydrate(await repo.planRequisitions(departmentId, quarter)),
    };
  };

  const one = async (id: string) =>
    (await hydrate([(await repo.findRequisition(id))!]))[0]!;

  const create = async (input: CreateRequisitionInput, actor: ActorContext) => {
    await assertHeadOf(actor.actorEmployeeId, input.departmentId);
    const now = await planningNow();
    if (input.quarter !== now.quarter) {
      throw createError(
        422,
        `New lines go into the ${now.quarter} plan (it closes on ${now.deadline})`,
        { code: 'PLAN_QUARTER' },
      );
    }
    await assertInterviewers(input.rounds);
    await assertManager(input.reportingManagerId);
    const id = await repo.create(
      {
        departmentId: input.departmentId,
        quarter: input.quarter,
        roleTitle: input.roleTitle,
        quantity: input.quantity,
        notes: input.notes || null,
        reason: input.reason,
        targetJoiningOn: input.targetJoiningOn,
        location: input.location,
        reportingManagerId: input.reportingManagerId,
        priority: input.priority,
        employmentType: input.employmentType,
        rounds: input.rounds,
      },
      actor,
    );
    return one(id);
  };

  const update = async (
    id: string,
    input: UpdateRequisitionInput,
    actor: ActorContext,
  ) => {
    await asHead(actor.actorEmployeeId, id);
    if (input.rounds) await assertInterviewers(input.rounds);
    await assertManager(input.reportingManagerId);
    const notes = input.notes === undefined ? undefined : input.notes || null;
    if (!(await repo.update(id, { ...input, notes }, input.rounds, actor))) {
      throw createError(409, 'Only a draft or returned line can be edited', {
        code: 'NOT_EDITABLE',
      });
    }
    return one(id);
  };

  /**
   * Submit a line. A draft is QUEUED for its quarter: it goes to the HR head
   * and Admin with the rest of the quarter's lines after the deadline (the
   * daily plan-window job). A returned line goes straight back to them.
   */
  const submit = async (id: string, actor: ActorContext) => {
    const r = await asHead(actor.actorEmployeeId, id);
    // A draft that was already sent once (returned, then edited) goes straight back.
    if (r.status === 'draft' && !r.submitted_at) {
      const now = await planningNow();
      if (!(await repo.queue(id, r.department_id, now.quarter, actor))) {
        throw createError(409, 'Only a draft or returned line can be submitted', {
          code: 'NOT_SUBMITTABLE',
        });
      }
      return one(id);
    }
    const title = `Hiring request to approve: ${r.request_code ?? ''} ${r.quantity} × ${r.role_title} (${r.department_name})`;
    const people = (await repo.hrbpHolders()).filter((x) => x !== actor.actorEmployeeId);
    const bells: Bell[] = [
      { to: people, event: { type: 'hiring.submitted', title, link: LINK_APPROVALS } },
    ];
    if ((await repo.submit(id, actor, bells)) === null) {
      throw createError(409, 'Only a draft or returned line can be submitted', {
        code: 'NOT_SUBMITTABLE',
      });
    }
    return one(id);
  };

  /** Take a queued line back to draft, to edit it before the deadline. */
  const unqueue = async (id: string, actor: ActorContext) => {
    await asHead(actor.actorEmployeeId, id);
    if (!(await repo.unqueue(id, actor))) {
      throw createError(409, 'Only a line waiting for the deadline can be taken back', {
        code: 'NOT_QUEUED',
      });
    }
    return one(id);
  };

  const cancel = async (id: string, actor: ActorContext) => {
    await asHead(actor.actorEmployeeId, id);
    if (!(await repo.cancel(id, actor))) {
      throw createError(409, 'An approved or cancelled line cannot be cancelled', {
        code: 'NOT_CANCELLABLE',
      });
    }
    return one(id);
  };

  const approvals = async (employeeId: string): Promise<RequisitionDto[]> => {
    const roles = await rolesOf(employeeId);
    if (roles.length === 0) return [];
    // Never my own lines.
    return hydrate(
      (await repo.waitingOn(roles)).filter(
        (r) => r.created_by !== employeeId && r.submitted_by !== employeeId,
      ),
    );
  };

  const decisionError = (res: string) => {
    if (res === 'stale') {
      return createError(409, 'This changed since you opened it — reload it', {
        code: 'REQUISITION_CHANGED',
      });
    }
    return createError(409, 'You have already decided on this version', {
      code: 'ALREADY_DECIDED',
    });
  };

  const decide = async (
    id: string,
    input: DecideRequisitionInput,
    actor: ActorContext,
  ) => {
    const r = await findOr404(id);
    const roles = await rolesOf(actor.actorEmployeeId);
    if (roles.length === 0) {
      throw createError(403, 'You are not an approver for hiring requests', {
        code: 'NOT_AN_APPROVER',
      });
    }
    // House rule: nobody approves their own request.
    if (
      r.created_by === actor.actorEmployeeId ||
      r.submitted_by === actor.actorEmployeeId
    ) {
      throw createError(403, 'You cannot decide on a request you raised', {
        code: 'SELF_APPROVAL',
      });
    }
    const reason = input.reason || null;
    const head = await repo.departmentHead(r.department_id);
    const toHead = [head, r.submitted_by].filter((x): x is string => !!x);
    const admin = (await holdersNow()).admin;
    const line = `${r.request_code ?? ''} ${r.quantity} × ${r.role_title}`.trim();
    // The other HRBPs hear what was decided.
    const by = await repo.nameOf(actor.actorEmployeeId);
    const otherHr = (await repo.hrbpHolders()).filter(
      (x) => x !== actor.actorEmployeeId && x !== r.created_by && x !== r.submitted_by,
    );
    const otherAdmin = admin && admin !== actor.actorEmployeeId ? [admin] : [];
    const res = await repo.decide(
      id,
      input.version,
      roles,
      [...APPROVER_ROLES],
      input.decision,
      reason,
      actor,
      (o): Bell[] =>
        o === 'declined'
          ? [
              {
                to: toHead,
                event: {
                  type: 'hiring.declined',
                  title: `Hiring request rejected: ${line} — ${reason}`,
                  link: LINK_PLAN,
                },
              },
              {
                to: otherHr,
                event: {
                  type: 'hiring.declined',
                  title: `Rejected by ${by}: ${line} (${r.department_name}) — ${reason}`,
                  link: LINK_TA,
                },
              },
            ]
          : o === 'returned'
          ? [
              {
                to: toHead,
                event: {
                  type: 'hiring.returned',
                  title: `Hiring request returned: ${line} — ${reason}`,
                  link: LINK_PLAN,
                },
              },
              {
                to: otherHr,
                event: {
                  type: 'hiring.returned',
                  title: `Returned by ${by}: ${line} (${r.department_name}) — ${reason}`,
                  link: LINK_TA,
                },
              },
            ]
          : o === 'approved'
            ? [
                {
                  to: toHead,
                  event: {
                    type: 'hiring.approved',
                    title: `Hiring request approved: ${line}`,
                    link: LINK_PLAN,
                  },
                },
                {
                  to: otherHr,
                  event: {
                    type: 'hiring.approved',
                    title: `Approved by ${by}: ${line} (${r.department_name})`,
                    link: LINK_TA,
                  },
                },
                {
                  to: otherAdmin,
                  event: {
                    type: 'hiring.approved',
                    title: `Approved by ${by} (HRBP): ${line} (${r.department_name}) — give it to a TA RM`,
                    link: LINK_ADMIN_APPROVALS,
                  },
                },
              ]
            : [],
    );
    if (res === 'stale' || res === 'decided') throw decisionError(res);
    return one(id);
  };

  const list = async (status?: RequisitionStatus) =>
    hydrate(await repo.listRequisitions(status));

  // ── Step C: JD + scorecard ─────────────────────────────────────────────

  /** The position and its line, if the caller is the position's recruiter. */
  const asRecruiter = async (positionId: string, actor: ActorContext) => {
    const p = await repo.findPosition(positionId);
    if (!p) throw createError(404, 'Position not found', { code: 'POSITION_NOT_FOUND' });
    if (!p.recruiter_id || p.recruiter_id !== actor.actorEmployeeId) {
      throw createError(403, "Only this position's recruiter writes its JD and scorecard", {
        code: 'NOT_POSITION_RECRUITER',
      });
    }
    return { p, r: await findOr404(p.requisition_id) };
  };

  /** Save a position's JD or scorecard (its recruiter). */
  const saveDocument = async (
    positionId: string,
    kind: DocumentKind,
    content: JdContent | ScorecardContent,
    actor: ActorContext,
  ) => {
    const { p, r } = await asRecruiter(positionId, actor);
    // An urgent line's interviews start at once, so TA writes its scorecard straight away.
    if (r.status !== 'approved' && !(r.urgent && r.status === 'submitted')) {
      throw createError(
        409,
        'The JD and scorecard are written once the line is approved',
        {
          code: 'LINE_NOT_APPROVED',
        },
      );
    }
    if (kind === 'scorecard') {
      // Only rounds this line actually uses can be scored.
      const used = new Set((await repo.roundsOf([r.id])).map((x) => x.round));
      const given = (content as ScorecardContent).rounds.map((x) => x.round);
      const stray = given.find((x) => !used.has(x));
      if (stray) {
        throw createError(422, `This line has no ${stray} round`, {
          code: 'ROUND_NOT_IN_LINE',
        });
      }
      const missing = [...used].filter((x) => !given.includes(x));
      if (missing.length) {
        throw createError(422, `Add a sheet for every round of the line: ${missing.join(', ')}`, {
          code: 'ROUND_MISSING',
        });
      }
    }
    if (!(await repo.saveDocument(p, kind, content, actor))) {
      throw createError(409, 'It is in review or approved — it can no longer be edited', {
        code: 'NOT_EDITABLE',
      });
    }
    return one(r.id);
  };

  const submitDocument = async (
    positionId: string,
    kind: DocumentKind,
    actor: ActorContext,
  ) => {
    const { p, r } = await asRecruiter(positionId, actor);
    const d = await repo.findDocument(p.id, kind);
    if (!d) throw createError(404, 'Write it first', { code: 'DOCUMENT_NOT_FOUND' });
    const label = kind === 'jd' ? 'JD' : 'Scorecard';
    const title = `${label} to review: ${r.role_title} #${p.number} (${r.department_name})`;
    const head = await repo.departmentHead(r.department_id);
    const bells: Bell[] = [
      {
        to: head ? [head] : [],
        event: { type: 'hiring.doc_review', title, link: LINK_PLAN },
      },
    ];
    if (docReviewers(p.recruiter_id, r.ta_rm_id).includes('ta_rm') && r.ta_rm_id) {
      bells.push({
        to: [r.ta_rm_id],
        event: { type: 'hiring.doc_review', title, link: LINK_APPROVALS },
      });
    }
    if (!(await repo.submitDocument(d.id, actor, bells))) {
      throw createError(409, 'Only a draft or returned document can be submitted', {
        code: 'NOT_SUBMITTABLE',
      });
    }
    return one(r.id);
  };

  /** Which review roles the caller holds on this position's documents. */
  const docRolesOf = async (
    employeeId: string,
    r: RequisitionRow,
    recruiterId: string | null,
  ): Promise<DocRole[]> => {
    const needed = docReviewers(recruiterId, r.ta_rm_id);
    const roles: DocRole[] = [];
    if ((await repo.departmentHead(r.department_id)) === employeeId)
      roles.push('dept_head');
    if (needed.includes('ta_rm') && r.ta_rm_id === employeeId) roles.push('ta_rm');
    return roles;
  };

  const reviews = async (employeeId: string): Promise<DocumentReviewDto[]> => {
    const docs = await repo.reviewsWaiting(employeeId);
    if (docs.length === 0) return [];
    const lines = await Promise.all(
      [...new Set(docs.map((d) => d.requisition_id))].map((id) =>
        repo.findRequisition(id),
      ),
    );
    const positions = await repo.positionsOf(lines.map((l) => l!.id));
    const approvalsRows = await repo.documentApprovalsOf(docs.map((d) => d.id));
    return docs.map((d) => {
      const r = lines.find((l) => l?.id === d.requisition_id)!;
      const p = positions.find((x) => x.id === d.position_id)!;
      return {
        requisitionId: r.id,
        departmentName: r.department_name,
        roleTitle: r.role_title,
        quantity: r.quantity,
        positionId: p.id,
        positionNumber: p.number,
        recruiterName: p.recruiter_name,
        document: toDocument(d, approvalsRows, docReviewers(p.recruiter_id, r.ta_rm_id)),
      };
    });
  };

  const decideDocument = async (
    documentId: string,
    input: DecideRequisitionInput,
    actor: ActorContext,
  ) => {
    const d = await repo.findDocumentById(documentId);
    if (!d) throw createError(404, 'Document not found', { code: 'DOCUMENT_NOT_FOUND' });
    const r = (await repo.findRequisition(d.requisition_id))!;
    const p = (await repo.findPosition(d.position_id))!;
    const roles = await docRolesOf(actor.actorEmployeeId, r, p.recruiter_id);
    if (roles.length === 0) {
      throw createError(403, "Only the line's TA RM or department head reviews this", {
        code: 'NOT_A_REVIEWER',
      });
    }
    if (d.written_by === actor.actorEmployeeId) {
      throw createError(403, 'You cannot review a document you wrote', {
        code: 'SELF_APPROVAL',
      });
    }
    if (input.decision === 'decline') {
      throw createError(422, 'A JD or scorecard is approved or returned, not declined', {
        code: 'INVALID_DECISION',
      });
    }
    const decision = input.decision;
    const reason = input.reason || null;
    const label = d.kind === 'jd' ? 'JD' : 'Scorecard';
    const line = `${r.role_title} #${p.number} (${r.department_name})`;
    const res = await repo.decideDocument(
      d.id,
      input.version,
      roles,
      docReviewers(p.recruiter_id, r.ta_rm_id),
      decision,
      reason,
      actor,
      POSITION_PROGRESS.open,
      (o): Bell[] =>
        o === 'returned'
          ? [
              {
                to: [d.written_by],
                event: {
                  type: 'hiring.doc_returned',
                  title: `${label} returned: ${line} — ${reason}`,
                  link: LINK_TA,
                },
              },
            ]
          : o === 'opened'
            ? [
                {
                  to: [
                    ...new Set([
                      d.written_by,
                      ...(p.recruiter_id ? [p.recruiter_id] : []),
                      ...(r.ta_rm_id ? [r.ta_rm_id] : []),
                    ]),
                  ],
                  event: {
                    type: 'hiring.positions_open',
                    title: `JD and scorecard approved — ${line} is open for sourcing`,
                    link: LINK_TA,
                  },
                },
              ]
            : [],
    );
    if (res === 'stale' || res === 'decided') throw decisionError(res);
    return one(r.id);
  };

  /** Log a sourcing channel the position's recruiter (or the line's TA RM) activated. */
  const addSource = async (positionId: string, input: AddSourceInput, actor: ActorContext) => {
    const p = await repo.findPosition(positionId);
    if (!p) throw createError(404, 'Position not found', { code: 'POSITION_NOT_FOUND' });
    const r = await findOr404(p.requisition_id);
    if (actor.actorEmployeeId !== p.recruiter_id && actor.actorEmployeeId !== r.ta_rm_id) {
      throw createError(403, "Only this position's recruiter or the line's TA RM can do this", {
        code: 'NOT_POSITION_OWNER',
      });
    }
    await repo.addSource(
      {
        positionId,
        channel: input.channel,
        activatedOn: input.activatedOn,
        notes: input.notes || null,
      },
      actor,
    );
    return one(r.id);
  };

  // ── TA RM: Admin gives each approved line to one ───────────────────────

  const assertAdmin = async (actor: ActorContext) => {
    if ((await holdersNow()).admin !== actor.actorEmployeeId) {
      throw createError(403, 'Only the Admin account gives a line to a TA RM', {
        code: 'NOT_ADMIN',
      });
    }
  };

  /** TA-batch holders with reports — whom Admin can give a line to. */
  const taRms = async (actor: ActorContext): Promise<TaRmOptionDto[]> => {
    await assertAdmin(actor);
    return (await repo.taRmOptions()).map((o) => ({
      id: o.id,
      name: o.name,
      employeeCode: o.employee_code,
      reports: o.reports,
    }));
  };

  /** The caller's reports in the TA batch — who they can give a position to (empty for most). */
  const recruiters = async (actor: ActorContext): Promise<RecruiterOptionDto[]> =>
    (await repo.recruiterOptions(actor.actorEmployeeId)).map((o) => ({
      id: o.id,
      name: o.name,
      employeeCode: o.employee_code,
    }));

  const assignTaRm = async (id: string, input: AssignTaRmInput, actor: ActorContext) => {
    await assertAdmin(actor);
    const r = await findOr404(id);
    if ((await repo.taRmOptions(input.taRmId)).length === 0) {
      throw createError(
        422,
        'A TA RM holds the TA batch and has at least one person reporting to them',
        { code: 'NOT_A_TA_RM' },
      );
    }
    const line = `${r.quantity} × ${r.role_title} (${r.department_name})`;
    const res = await repo.assignTaRm(id, input.taRmId, actor, [
      {
        to: [input.taRmId],
        event: {
          type: 'hiring.ta_rm',
          title: `Line is yours: ${line} — assign the positions and write the JD + scorecard`,
          link: LINK_TA,
        },
      },
    ]);
    if (res === 'not_ready') {
      throw createError(409, 'Only an approved line can be given to a TA RM', {
        code: 'NOT_APPROVED',
      });
    }
    if (res === 'same') {
      throw createError(409, 'This TA RM already has the line', { code: 'ALREADY_ASSIGNED' });
    }
    if (res === 'positions_assigned') {
      throw createError(
        409,
        "The TA RM's team already holds positions on this line — it can't move now",
        { code: 'POSITIONS_ASSIGNED' },
      );
    }
    return one(id);
  };

  // ── Step C: positions → recruiters (through goals) ─────────────────────

  /**
   * The line's TA RM gives a position to one of their own reports. The
   * recruiter's hiring goal for this quarter is created (or moved, on
   * reassign); its progress follows the position.
   */
  const assignPosition = async (
    positionId: string,
    input: AssignPositionInput,
    actor: ActorContext,
  ) => {
    const p = await repo.findPosition(positionId);
    if (!p) throw createError(404, 'Position not found', { code: 'POSITION_NOT_FOUND' });
    const line = (await repo.findRequisition(p.requisition_id))!;
    if (line.ta_rm_id !== actor.actorEmployeeId) {
      throw createError(403, "Only this line's TA RM assigns its positions", {
        code: 'NOT_LINE_TA_RM',
      });
    }
    const recruiter = await repo.recruiterOf(input.recruiterId);
    if (!recruiter || recruiter.status !== 'active') {
      throw createError(422, 'The recruiter must be an active employee', {
        code: 'RECRUITER_NOT_ACTIVE',
      });
    }
    // The TA RM may keep a position herself (learner, 2026-10-27).
    const self = input.recruiterId === actor.actorEmployeeId;
    if (!self && recruiter.effective_rm !== actor.actorEmployeeId) {
      throw createError(
        422,
        'Positions go to your own team — this person does not report to you',
        {
          code: 'NOT_YOUR_REPORT',
        },
      );
    }
    // The JD, scorecard and candidates live behind the ta.hiring grant, so a
    // recruiter outside the TA batch would get a goal with no screen to work it.
    if (!self && !recruiter.in_ta) {
      throw createError(
        422,
        'Recruiters must be in the TA batch — Admin adds them in Access batches',
        { code: 'NOT_IN_TA_BATCH' },
      );
    }
    if (p.recruiter_id === input.recruiterId) {
      throw createError(409, 'This recruiter already has the position', {
        code: 'ALREADY_ASSIGNED',
      });
    }
    const q = quarterOf();
    const cycle = await repo.ensureCycle(q.name, q.startDate, q.endDate);
    if (cycle.closed_at) {
      throw createError(409, 'This quarter is closed — goals are frozen', {
        code: 'CYCLE_CLOSED',
      });
    }
    const r = line;
    const title = `Fill: ${r.role_title} #${p.number} (${r.department_name})`;
    const ok = await repo.assignPosition(
      {
        positionId: p.id,
        recruiterId: input.recruiterId,
        weight: input.weight,
        cycleId: cycle.id,
        dueOn: cycle.end_date,
        title,
        progress: POSITION_PROGRESS[p.status],
        expectedCloseOn: input.expectedCloseOn ?? null,
        priority: input.priority ?? null,
      },
      actor,
      [
        {
          to: [input.recruiterId],
          event: {
            type: 'hiring.assigned',
            title: `You have a hiring goal: ${title}`,
            link: LINK_PERFORMANCE,
          },
        },
      ],
    );
    if (!ok) {
      throw createError(409, 'A filled or cancelled position cannot be reassigned', {
        code: 'POSITION_CLOSED',
      });
    }
    return one(r.id);
  };

  return {
    me,
    plan,
    create,
    update,
    submit,
    unqueue,
    cancel,
    approvals,
    decide,
    list,
    saveDocument,
    submitDocument,
    reviews,
    decideDocument,
    taRms,
    recruiters,
    addSource,
    assignTaRm,
    assignPosition,
  };
};

export type HiringService = ReturnType<typeof createHiringService>;
