import createError from 'http-errors';
import { env } from '../../config/env.js';
import { localDateOf } from '../../shared/helpers/helpers.js';
import type { CreateEmployeeInput, EmployeesService } from '../employees/index.js';
import type { SettingsReader } from '../settings/index.js';
import type { CandidatesService } from './candidates.service.js';
import type { HireRepository, HireRole } from './hire.repository.js';
import type {
  BgvInput,
  DecideHireInput,
  MakeOfferInput,
  MarkHiredInput,
} from './hire.schema.js';
import type { ActorContext, Bell, HiringRepository } from './hiring.repository.js';
import { POSITION_PROGRESS } from './hiring.service.js';

const LINK_TA = '/hr/hiring';
const LINK_APPROVALS = '/hiring/approvals';
const LINK_ADMIN_APPROVALS = '/admin/hiring-approvals';
const OFFER_MAX_BYTES = 10 * 1024 * 1024;
const OFFER_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
/** Company email only (house rule §5.4). */
const COMPANY_DOMAIN = env.auth.companyEmailDomain.toLowerCase();

/** Runs the hire inside ONE transaction: the employee record and the application together. */
export type HireTransaction = <T>(
  fn: (scope: {
    employees: Pick<EmployeesService, 'create'>;
    markHired: (
      id: string,
      employeeId: string,
      positionId: string,
      actor: ActorContext,
      bells: Bell[],
    ) => Promise<boolean>;
  }) => Promise<T>,
) => Promise<T>;

/**
 * The final decision, offer, BGV and hire (TA Step E). Urgent hiring is done
 * offline for now (learner, 2026-10-26): HR adds the person through the
 * normal add-employee flow.
 *
 * After every round is scored TA sends the candidate for the FINAL decision:
 * the line's department head, the line's TA RM, the HR head and the Admin account
 * — any order; a reject ends it, the fourth approve selects. The offer letter
 * is made outside and uploaded; an URGENT line's offer waits for the line's
 * approval. BGV runs alongside; a failed one leads TA to withdraw the offer.
 * When the candidate accepts, Mark hired creates the employee record through
 * the normal intake (company email, RM, new-hire defaults, onboarding) in the
 * same transaction. Backing out before joining deactivates that record and
 * reopens the position.
 */
export const createHireService = (deps: {
  repo: HireRepository;
  hiring: HiringRepository;
  settings: SettingsReader;
  applications: Pick<CandidatesService, 'one'>;
  transaction: HireTransaction;
}) => {
  const { repo, hiring, settings, applications, transaction } = deps;

  const holders = async () =>
    hiring.approverHolders(
      (await settings.effective('hiring.hrDepartment')).departmentId,
    );

  const find = async (id: string) => {
    const a = await repo.findApplication(id);
    if (!a)
      throw createError(404, 'Application not found', { code: 'APPLICATION_NOT_FOUND' });
    return a;
  };

  const wrongStage = (what: string) => createError(409, what, { code: 'WRONG_STAGE' });

  /** The four decision-makers of this line, and the bells that reach them. */
  const deciders = async (line: { department_id: string; ta_rm_id: string | null }) => {
    const h = await holders();
    const head = await hiring.departmentHead(line.department_id);
    return { head, ta: line.ta_rm_id, hr: h.hr_head, admin: h.admin };
  };

  const bellToDeciders = async (
    line: { department_id: string; ta_rm_id: string | null },
    type: string,
    title: string,
  ): Promise<Bell[]> => {
    const d = await deciders(line);
    const people = [d.head, d.ta, d.hr].filter((x): x is string => !!x);
    return [
      { to: people, event: { type, title, link: LINK_APPROVALS } },
      {
        to: d.admin ? [d.admin] : [],
        event: { type, title, link: LINK_ADMIN_APPROVALS },
      },
    ];
  };

  const rolesFor = async (
    employeeId: string,
    line: { department_id: string; ta_rm_id: string | null },
  ): Promise<HireRole[]> => {
    const d = await deciders(line);
    const roles: HireRole[] = [];
    if (d.head === employeeId) roles.push('dept_head');
    if (d.ta === employeeId) roles.push('ta_rm');
    if (d.hr === employeeId) roles.push('hr_head');
    if (d.admin === employeeId) roles.push('admin');
    return roles;
  };

  // ── Final decision ─────────────────────────────────────────────────────

  const sendForDecision = async (id: string, actor: ActorContext) => {
    const a = await find(id);
    const bells = await bellToDeciders(
      a,
      'hiring.decision',
      `Hire decision: ${a.candidate_name} for ${a.role_title} (${a.department_name})`,
    );
    if (!(await repo.sendForDecision(id, actor, bells))) {
      throw wrongStage('Only a candidate with every round scored goes for the decision');
    }
    return applications.one(id);
  };

  /** Decisions waiting for me — each with the candidate's scores (only while pending). */
  const pendingDecisions = async (employeeId: string) => {
    const h = await holders();
    const deptIds = (await hiring.headOf(employeeId)).map((d) => d.department_id);
    const orgRoles: HireRole[] = [];
    if (h.hr_head === employeeId) orgRoles.push('hr_head');
    if (h.admin === employeeId) orgRoles.push('admin');
    const ids = await repo.pendingDecisionIds(deptIds, employeeId, orgRoles);
    return Promise.all(ids.map((x) => applications.one(x)));
  };

  const decide = async (id: string, input: DecideHireInput, actor: ActorContext) => {
    const a = await find(id);
    const roles = await rolesFor(actor.actorEmployeeId, a);
    if (roles.length === 0) {
      throw createError(403, 'You are not one of the four who decide this hire', {
        code: 'NOT_A_DECIDER',
      });
    }
    const reason = input.reason || null;
    const ta = [a.recruiter_id, a.ta_rm_id].filter(
      (x): x is string => !!x,
    );
    const res = await repo.decideHire(
      id,
      roles,
      input.decision,
      reason,
      actor,
      (o): Bell[] =>
        o === 'pending'
          ? []
          : [
              {
                to: [...new Set(ta)],
                event: {
                  type: o === 'selected' ? 'hiring.selected' : 'hiring.not_selected',
                  title:
                    o === 'selected'
                      ? `Selected: ${a.candidate_name} for ${a.role_title} — upload the offer`
                      : `Not selected: ${a.candidate_name} for ${a.role_title} — ${reason}`,
                  link: LINK_TA,
                },
              },
            ],
    );
    if (res === 'stale') throw wrongStage('This decision is no longer open');
    if (res === 'decided') {
      throw createError(409, 'You have already decided on this hire', {
        code: 'ALREADY_DECIDED',
      });
    }
    return applications.one(id);
  };

  // ── Offer ──────────────────────────────────────────────────────────────

  const uploadOfferLetter = async (
    id: string,
    file: { fileName: string; contentType: string; data: Buffer },
    actor: ActorContext,
  ) => {
    const a = await find(id);
    if (a.stage !== 'selected' && a.stage !== 'offered') {
      throw wrongStage('The offer letter is uploaded once the candidate is selected');
    }
    if (file.data.length === 0 || file.data.length > OFFER_MAX_BYTES) {
      throw createError(422, 'The offer letter must be a file under 10 MB', {
        code: 'FILE_SIZE',
      });
    }
    const type = file.contentType.split(';')[0]!.trim().toLowerCase();
    if (!OFFER_TYPES.has(type)) {
      throw createError(422, 'Upload the offer letter as a PDF or Word file', {
        code: 'FILE_TYPE',
      });
    }
    await repo.saveOfferLetter(id, { ...file, contentType: type }, actor);
    return applications.one(id);
  };

  const offerLetter = async (id: string) => {
    const f = await repo.offerLetter(id);
    if (!f) throw createError(404, 'No offer letter uploaded', { code: 'NOT_FOUND' });
    return { fileName: f.file_name, contentType: f.content_type, data: f.data };
  };

  const makeOffer = async (id: string, input: MakeOfferInput, actor: ActorContext) => {
    const a = await find(id);
    if (a.stage !== 'selected')
      throw wrongStage('Only a selected candidate gets an offer');
    if (a.requisition_status !== 'approved') {
      // Safety net: positions only exist on approved lines.
      throw createError(409, 'The line is not approved yet — the offer waits for it', {
        code: 'LINE_NOT_APPROVED',
      });
    }
    if (!(await repo.hasOfferLetter(id))) {
      throw createError(422, 'Upload the offer letter first', {
        code: 'NO_OFFER_LETTER',
      });
    }
    if (input.joiningDate < localDateOf(new Date())) {
      throw createError(422, 'The joining date cannot be in the past', {
        code: 'PAST_DATE',
      });
    }
    const head = await hiring.departmentHead(a.department_id);
    const ok = await repo.makeOffer(
      id,
      {
        ctc: input.ctc,
        joiningDate: input.joiningDate,
        positionId: a.position_id,
        progress: POSITION_PROGRESS.offer,
        // Warn, don't block (learner, 2026-10-26): the screen shows it; the audit keeps it.
        overBudget: a.budget_max !== null && input.ctc > Number(a.budget_max),
      },
      actor,
      [
        {
          to: head ? [head] : [],
          event: {
            type: 'hiring.offered',
            title: `Offer sent: ${a.candidate_name} for ${a.role_title}, joining ${input.joiningDate}`,
            link: LINK_TA,
          },
        },
      ],
    );
    if (!ok) throw wrongStage('Only a selected candidate gets an offer');
    return applications.one(id);
  };

  // ── BGV ────────────────────────────────────────────────────────────────

  const setBgv = async (id: string, input: BgvInput, actor: ActorContext) => {
    const a = await find(id);
    const ta = a.ta_rm_id;
    const bells: Bell[] =
      input.status === 'failed'
        ? [
            {
              to: [...new Set([a.recruiter_id, ta].filter((x): x is string => !!x))],
              event: {
                type: 'hiring.bgv_failed',
                title: `BGV failed: ${a.candidate_name} for ${a.role_title} — decide on the offer`,
                link: LINK_TA,
              },
            },
          ]
        : [];
    if (!(await repo.setBgv(id, input.status, input.notes || null, actor, bells))) {
      throw wrongStage('BGV is recorded between the last round and the hire');
    }
    return applications.one(id);
  };

  // ── Offer ends / hire ──────────────────────────────────────────────────

  const endOffer = async (
    id: string,
    to: 'offer_declined' | 'offer_withdrawn',
    reason: string,
    actor: ActorContext,
  ) => {
    const a = await find(id);
    const bells =
      to === 'offer_withdrawn'
        ? await bellToDeciders(
            a,
            'hiring.offer_withdrawn',
            `Offer withdrawn: ${a.candidate_name} for ${a.role_title} — ${reason}`,
          )
        : [];
    if (
      !(await repo.endOffer(
        id,
        to,
        reason,
        a.position_id,
        POSITION_PROGRESS,
        actor,
        bells,
      ))
    ) {
      throw wrongStage('Only an open offer can be declined or withdrawn');
    }
    return applications.one(id);
  };

  /**
   * The candidate accepted: create their employee record through the normal
   * intake and mark the application hired — one transaction. Returns the
   * joiner's single-use sign-in link token.
   */
  const markHired = async (id: string, input: MarkHiredInput, actor: ActorContext) => {
    const a = await find(id);
    if (a.stage !== 'offered')
      throw wrongStage('Mark hired once the candidate accepts the offer');
    if (!input.email.endsWith(`@${COMPANY_DOMAIN}`)) {
      throw createError(422, `Use their company email (@${COMPANY_DOMAIN})`, {
        code: 'COMPANY_EMAIL_ONLY',
      });
    }
    const [firstName, ...rest] = a.candidate_name.trim().split(/\s+/);
    const digits = (a.candidate_phone ?? '').replace(/\D/g, '').slice(-10);
    const employee: CreateEmployeeInput = {
      firstName: firstName!,
      lastName: rest.length ? rest.join(' ') : undefined,
      phone: digits.length === 10 ? digits : undefined,
      employeeCode: input.employeeCode,
      email: input.email,
      departmentId: a.department_id,
      level: input.level,
      reportsTo: input.reportsToId,
      designation: input.designation || a.role_title,
      employmentType: input.employmentType,
      dateOfJoining: a.joining_date ?? undefined,
      offerDate: a.offered_at ? localDateOf(new Date(a.offered_at)) : undefined,
    };
    // The intake writes the audit row as a signed-in user — never the scheduler.
    const { actorUserId } = actor;
    if (!actorUserId) throw createError(401, 'Authentication required');
    const head = await hiring.departmentHead(a.department_id);
    const ta = a.ta_rm_id;
    const result = await transaction(async (scope) => {
      const created = await scope.employees.create(employee, {
        actorUserId,
        actorEmployeeId: actor.actorEmployeeId,
      });
      const ok = await scope.markHired(id, created.employee.id, a.position_id, actor, [
        {
          to: [...new Set([head, a.recruiter_id, ta].filter((x): x is string => !!x))],
          event: {
            type: 'hiring.hired',
            title: `Hired: ${a.candidate_name} as ${a.role_title}, joining ${a.joining_date ?? 'TBD'}`,
            link: LINK_TA,
          },
        },
      ]);
      if (!ok) throw wrongStage('Mark hired once the candidate accepts the offer');
      return created;
    });
    return {
      application: await applications.one(id),
      employeeId: result.employee.id,
      claim: result.claim,
    };
  };

  /** Backed out before joining: deactivate the record, reopen the position. */
  const noShow = async (id: string, reason: string, actor: ActorContext) => {
    const a = await find(id);
    if (a.stage !== 'hired' || !a.employee_id)
      throw wrongStage('Only a hired candidate can not join');
    if (!(await repo.employeeBeforeJoining(a.employee_id, localDateOf(new Date())))) {
      throw createError(409, 'They have already joined — use the exit process instead', {
        code: 'ALREADY_JOINED',
      });
    }
    const bells = await bellToDeciders(
      a,
      'hiring.no_show',
      `Did not join: ${a.candidate_name} for ${a.role_title} — the position is open again`,
    );
    if (
      !(await repo.noShow(
        id,
        a.employee_id,
        reason,
        a.position_id,
        POSITION_PROGRESS,
        actor,
        bells,
      ))
    ) {
      throw wrongStage('Only a hired candidate can not join');
    }
    return applications.one(id);
  };

  return {
    sendForDecision,
    pendingDecisions,
    decide,
    uploadOfferLetter,
    offerLetter,
    makeOffer,
    setBgv,
    endOffer,
    markHired,
    noShow,
  };
};

export type HireService = ReturnType<typeof createHireService>;
