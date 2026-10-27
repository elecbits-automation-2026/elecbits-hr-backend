import createError from 'http-errors';
import { env } from '../../config/env.js';
import { localDateOf } from '../../shared/helpers/helpers.js';
import type { CreateEmployeeInput, EmployeesService } from '../employees/index.js';
import type { SettingsReader } from '../settings/index.js';
import type { CandidatesService } from './candidates.service.js';
import type { HireRepository } from './hire.repository.js';
import type {
  CandidateDocStatus,
  CandidateDocumentDto,
  MarkHiredInput,
  OfferDraftInput,
} from './hire.schema.js';
import type { ActorContext, Bell, HiringRepository } from './hiring.repository.js';
import { POSITION_PROGRESS } from './hiring.service.js';

const LINK_TA = '/hr/hiring';
const LINK_APPROVALS = '/hiring/approvals';
const LINK_ONBOARDING = '/hr/onboarding';
const LETTER_MAX_BYTES = 10 * 1024 * 1024;
const LETTER_TYPES = new Set([
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
 * From "all rounds passed" to joining (TA workflow deck, 2026-10-27):
 *
 * TA asks for the candidate's documents (a checklist + the candidate folder
 * link), negotiates and drafts the offer (CTC, joining date, terms, the draft
 * letter) and sends it to the HR HEAD — the head of the hiring HR department
 * — who approves it and uploads the SIGNED letter (or returns it with what to
 * change). TA then shares the signed offer. Changing approved terms sends
 * them back for approval. When the candidate accepts, Mark hired creates the
 * employee record through the normal intake (onboarding included) and HRBP
 * gets the handover; HRBP later confirms the actual joining. Backing out
 * before joining deactivates the record and reopens the position. BGV is a
 * form in onboarding, never a gate here.
 */
export const createHireService = (deps: {
  repo: HireRepository;
  hiring: HiringRepository;
  settings: SettingsReader;
  applications: Pick<CandidatesService, 'one'>;
  transaction: HireTransaction;
}) => {
  const { repo, hiring, settings, applications, transaction } = deps;

  const hrHead = async () =>
    (await hiring.approverHolders((await settings.effective('hiring.hrDepartment')).departmentId))
      .hr_head;

  const find = async (id: string) => {
    const a = await repo.findApplication(id);
    if (!a)
      throw createError(404, 'Application not found', { code: 'APPLICATION_NOT_FOUND' });
    return a;
  };

  const wrongStage = (what: string) => createError(409, what, { code: 'WRONG_STAGE' });

  /** The position's recruiter or the line's TA RM works the offer. */
  const assertTa = (
    a: { recruiter_id: string | null; ta_rm_id: string | null },
    actor: ActorContext,
  ) => {
    if (actor.actorEmployeeId !== a.recruiter_id && actor.actorEmployeeId !== a.ta_rm_id) {
      throw createError(403, "Only this position's recruiter or the line's TA RM can do this", {
        code: 'NOT_POSITION_OWNER',
      });
    }
  };

  const assertHrHead = async (actor: ActorContext) => {
    const head = await hrHead();
    if (!head || head !== actor.actorEmployeeId) {
      throw createError(403, 'Only the HR Head approves and signs offers', {
        code: 'NOT_HR_HEAD',
      });
    }
  };

  const ta = (a: { recruiter_id: string | null; ta_rm_id: string | null }) =>
    [...new Set([a.recruiter_id, a.ta_rm_id].filter((x): x is string => !!x))];

  const checkLetter = (file: { contentType: string; data: Buffer }) => {
    if (file.data.length === 0 || file.data.length > LETTER_MAX_BYTES) {
      throw createError(422, 'The offer letter must be a file under 10 MB', { code: 'FILE_SIZE' });
    }
    const type = file.contentType.split(';')[0]!.trim().toLowerCase();
    if (!LETTER_TYPES.has(type)) {
      throw createError(422, 'Upload the offer letter as a PDF or Word file', {
        code: 'FILE_TYPE',
      });
    }
    return type;
  };

  // ── Documents ──────────────────────────────────────────────────────────

  const documents = async (id: string): Promise<CandidateDocumentDto[]> => {
    await find(id);
    return (await repo.documentsOf(id)).map((d) => ({
      id: d.id,
      name: d.name,
      status: d.status,
      updatedAt: new Date(d.updated_at).toISOString(),
    }));
  };

  const addDocument = async (id: string, name: string, actor: ActorContext) => {
    assertTa(await find(id), actor);
    if (!(await repo.addDocument(id, name, actor))) {
      throw createError(409, 'That document is already on the list', { code: 'DUPLICATE' });
    }
    return documents(id);
  };

  const setDocument = async (
    id: string,
    docId: string,
    status: CandidateDocStatus,
    actor: ActorContext,
  ) => {
    assertTa(await find(id), actor);
    if (!(await repo.setDocument(id, docId, status, actor))) {
      throw createError(404, 'Document not found', { code: 'NOT_FOUND' });
    }
    return documents(id);
  };

  const setFolder = async (id: string, link: string | null, actor: ActorContext) => {
    assertTa(await find(id), actor);
    await repo.setFolder(id, link, actor);
    return applications.one(id);
  };

  // ── Offer ──────────────────────────────────────────────────────────────

  /** TA's draft letter (the HR Head signs and uploads the final one). */
  const uploadOfferLetter = async (
    id: string,
    file: { fileName: string; contentType: string; data: Buffer },
    actor: ActorContext,
  ) => {
    const a = await find(id);
    assertTa(a, actor);
    if (!['interviewed', 'decision', 'selected'].includes(a.stage)) {
      throw wrongStage('The offer letter is drafted once every round has passed');
    }
    const contentType = checkLetter(file);
    await repo.saveOfferLetter(id, { ...file, contentType }, actor);
    return applications.one(id);
  };

  const offerLetter = async (id: string) => {
    const f = await repo.offerLetter(id);
    if (!f) throw createError(404, 'No offer letter uploaded', { code: 'NOT_FOUND' });
    return { fileName: f.file_name, contentType: f.content_type, data: f.data };
  };

  const signedLetter = async (id: string) => {
    const f = await repo.signedLetter(id);
    if (!f) throw createError(404, 'No signed offer letter yet', { code: 'NOT_FOUND' });
    return { fileName: f.file_name, contentType: f.content_type, data: f.data };
  };

  /** Save the negotiated terms; changing APPROVED terms sends them back to the HR Head. */
  const saveOfferDraft = async (id: string, input: OfferDraftInput, actor: ActorContext) => {
    const a = await find(id);
    assertTa(a, actor);
    if (input.joiningDate < localDateOf(new Date())) {
      throw createError(422, 'The joining date cannot be in the past', { code: 'PAST_DATE' });
    }
    const head = await hrHead();
    const res = await repo.saveOfferDraft(
      id,
      { ctc: input.ctc, joiningDate: input.joiningDate, terms: input.terms || null },
      actor,
      [
        {
          to: head ? [head] : [],
          event: {
            type: 'hiring.offer_approval',
            title: `Offer terms changed — approve again: ${a.candidate_name} for ${a.role_title}`,
            link: LINK_APPROVALS,
          },
        },
      ],
    );
    if (!res) throw wrongStage('The offer is drafted once every round has passed');
    return applications.one(id);
  };

  /** Send the drafted offer (terms + draft letter) to the HR Head. */
  const submitOffer = async (id: string, actor: ActorContext) => {
    const a = await find(id);
    assertTa(a, actor);
    if (!(await repo.hasOfferLetter(id))) {
      throw createError(422, 'Upload the draft offer letter first', { code: 'NO_OFFER_LETTER' });
    }
    const head = await hrHead();
    if (!head) {
      throw createError(409, 'Set the hiring HR department and its head first', {
        code: 'NO_HR_HEAD',
      });
    }
    const ok = await repo.submitOffer(id, actor, [
      {
        to: [head],
        event: {
          type: 'hiring.offer_approval',
          title: `Offer to approve and sign: ${a.candidate_name} for ${a.role_title} (${a.department_name})`,
          link: LINK_APPROVALS,
        },
      },
    ]);
    if (!ok) throw wrongStage('Draft the CTC and joining date after every round has passed');
    return applications.one(id);
  };

  /** Offers waiting for me — the HR Head only. */
  const pendingOffers = async (employeeId: string) => {
    if ((await hrHead()) !== employeeId) return [];
    return Promise.all((await repo.pendingOfferIds()).map((x) => applications.one(x)));
  };

  /** The HR Head uploads the signed letter (while the offer waits for them). */
  const uploadSignedLetter = async (
    id: string,
    file: { fileName: string; contentType: string; data: Buffer },
    actor: ActorContext,
  ) => {
    await assertHrHead(actor);
    const a = await find(id);
    if (a.stage !== 'decision') throw wrongStage('Only an offer waiting for approval is signed');
    const contentType = checkLetter(file);
    await repo.saveSignedLetter(id, { ...file, contentType }, actor);
    return applications.one(id);
  };

  const approveOffer = async (id: string, actor: ActorContext) => {
    await assertHrHead(actor);
    const a = await find(id);
    if (!(await repo.hasSignedLetter(id))) {
      throw createError(422, 'Upload the signed offer letter first', { code: 'NOT_SIGNED' });
    }
    const ok = await repo.approveOffer(id, actor, [
      {
        to: ta(a),
        event: {
          type: 'hiring.offer_approved',
          title: `Offer approved and signed: ${a.candidate_name} for ${a.role_title} — share it`,
          link: LINK_TA,
        },
      },
    ]);
    if (!ok) throw wrongStage('Only an offer waiting for approval can be approved');
    return applications.one(id);
  };

  const returnOffer = async (id: string, reason: string, actor: ActorContext) => {
    await assertHrHead(actor);
    const a = await find(id);
    const ok = await repo.returnOffer(id, reason, actor, [
      {
        to: ta(a),
        event: {
          type: 'hiring.offer_returned',
          title: `Offer returned: ${a.candidate_name} for ${a.role_title} — ${reason}`,
          link: LINK_TA,
        },
      },
    ]);
    if (!ok) throw wrongStage('Only an offer waiting for approval can be returned');
    return applications.one(id);
  };

  /** Share the approved, signed offer with the candidate. */
  const shareOffer = async (id: string, actor: ActorContext) => {
    const a = await find(id);
    assertTa(a, actor);
    if (a.requisition_status !== 'approved') {
      // Safety net: positions only exist on approved lines.
      throw createError(409, 'The line is not approved', { code: 'LINE_NOT_APPROVED' });
    }
    const head = await hiring.departmentHead(a.department_id);
    const ok = await repo.shareOffer(id, a.position_id, POSITION_PROGRESS.offer, actor, [
      {
        to: head ? [head] : [],
        event: {
          type: 'hiring.offered',
          title: `Offer shared: ${a.candidate_name} for ${a.role_title}, joining ${a.joining_date}`,
          link: LINK_TA,
        },
      },
    ]);
    if (!ok) throw wrongStage('Only an offer the HR Head approved and signed can be shared');
    return applications.one(id);
  };

  const endOffer = async (
    id: string,
    to: 'offer_declined' | 'offer_withdrawn',
    reason: string,
    actor: ActorContext,
  ) => {
    const a = await find(id);
    assertTa(a, actor);
    const head = await hrHead();
    const bells: Bell[] =
      to === 'offer_withdrawn'
        ? [
            {
              to: [...new Set([...ta(a), ...(head ? [head] : [])])],
              event: {
                type: 'hiring.offer_withdrawn',
                title: `Offer withdrawn: ${a.candidate_name} for ${a.role_title} — ${reason}`,
                link: LINK_TA,
              },
            },
          ]
        : [];
    if (
      !(await repo.endOffer(id, to, reason, a.position_id, POSITION_PROGRESS, actor, bells))
    ) {
      throw wrongStage('Only an open offer can be declined or withdrawn');
    }
    return applications.one(id);
  };

  // ── Hire, handover, joining ────────────────────────────────────────────

  /**
   * The candidate accepted: create their employee record through the normal
   * intake and mark the application hired — one transaction. HRBP gets the
   * handover. Returns the joiner's single-use sign-in link token.
   */
  const markHired = async (id: string, input: MarkHiredInput, actor: ActorContext) => {
    const a = await find(id);
    assertTa(a, actor);
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
    const hrbp = await hiring.hrbpHolders();
    const docs = await repo.documentCounts(id);
    const result = await transaction(async (scope) => {
      const created = await scope.employees.create(employee, {
        actorUserId,
        actorEmployeeId: actor.actorEmployeeId,
      });
      const ok = await scope.markHired(id, created.employee.id, a.position_id, actor, [
        {
          to: [...new Set([head, ...ta(a)].filter((x): x is string => !!x))],
          event: {
            type: 'hiring.hired',
            title: `Hired: ${a.candidate_name} as ${a.role_title}, joining ${a.joining_date ?? 'TBD'}`,
            link: LINK_TA,
          },
        },
        {
          // The TA → HRBP handover (workflow deck step 16).
          to: hrbp.filter((x) => x !== actor.actorEmployeeId),
          event: {
            type: 'hiring.handover',
            title:
              `Handover: ${a.candidate_name} (${a.candidate_code ?? '—'}) joins ${a.department_name} as ` +
              `${a.role_title} on ${a.joining_date ?? 'TBD'} · documents ${docs.received} received, ` +
              `${docs.pending} pending${a.next_action ? ` · open: ${a.next_action}` : ''}`,
            link: LINK_ONBOARDING,
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

  /** HRBP confirms the person actually joined (on or after the joining date). */
  const confirmJoined = async (id: string, actor: ActorContext) => {
    if (!(await hiring.hrbpHolders()).includes(actor.actorEmployeeId)) {
      throw createError(403, 'HRBP confirms the joining', { code: 'NOT_HRBP' });
    }
    const a = await find(id);
    if (a.joining_date && a.joining_date > localDateOf(new Date())) {
      throw createError(409, `They join on ${a.joining_date} — confirm on or after that day`, {
        code: 'NOT_YET',
      });
    }
    const ok = await repo.confirmJoined(id, actor, [
      {
        to: ta(a),
        event: {
          type: 'hiring.joined',
          title: `Joined: ${a.candidate_name} as ${a.role_title}`,
          link: LINK_TA,
        },
      },
    ]);
    if (!ok) throw wrongStage('Only a hired candidate can be confirmed as joined');
    return applications.one(id);
  };

  /** Backed out before joining: deactivate the record, reopen the position. */
  const noShow = async (id: string, reason: string, actor: ActorContext) => {
    const a = await find(id);
    assertTa(a, actor);
    if (a.stage !== 'hired' || !a.employee_id)
      throw wrongStage('Only a hired candidate can not join');
    if (!(await repo.employeeBeforeJoining(a.employee_id, localDateOf(new Date())))) {
      throw createError(409, 'They have already joined — use the exit process instead', {
        code: 'ALREADY_JOINED',
      });
    }
    const head = await hiring.departmentHead(a.department_id);
    const hrbp = await hiring.hrbpHolders();
    const bells: Bell[] = [
      {
        to: [...new Set([...ta(a), ...(head ? [head] : []), ...hrbp])],
        event: {
          type: 'hiring.no_show',
          title: `Did not join: ${a.candidate_name} for ${a.role_title} — the position is open again`,
          link: LINK_TA,
        },
      },
    ];
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
    documents,
    addDocument,
    setDocument,
    setFolder,
    uploadOfferLetter,
    offerLetter,
    signedLetter,
    saveOfferDraft,
    submitOffer,
    pendingOffers,
    uploadSignedLetter,
    approveOffer,
    returnOffer,
    shareOffer,
    endOffer,
    markHired,
    confirmJoined,
    noShow,
  };
};

export type HireService = ReturnType<typeof createHireService>;
