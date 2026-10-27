import createError from 'http-errors';
import { addDaysIso, localDateOf } from '../../shared/helpers/helpers.js';
import type {
  ApplicationRow,
  CandidateRow,
  CandidatesRepository,
  ScoreRow,
} from './candidates.repository.js';
import type {
  ApplicationDto,
  CandidateDto,
  CandidateMatchDto,
  CreateCandidateInput,
  MyInterviewDto,
  RoundScoreDto,
  SubmitScoreInput,
} from './candidates.schema.js';
import { HIRE_ROLES } from './candidates.schema.js';
import type { ActorContext, Bell, HiringRepository } from './hiring.repository.js';
import type { HireRole } from './hire.repository.js';
import type { InterviewRound } from './hiring.schema.js';
import { POSITION_PROGRESS } from './hiring.service.js';

/** Talent-pool retention (TA design): 6 months after the last consideration. */
const RETAIN_DAYS = 183;
const CV_MAX_BYTES = 10 * 1024 * 1024;
const CV_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const LINK_INTERVIEWS = '/hiring/interviews';
const LINK_TA = '/hr/hiring';
const LINK_PLAN = '/hiring/plan';

const retainUntil = () => addDaysIso(localDateOf(new Date()), RETAIN_DAYS);

const toScore = (s: ScoreRow): RoundScoreDto => ({
  round: s.round,
  interviewerName: s.interviewer_name,
  scores: s.scores,
  average:
    Math.round(
      (s.scores.reduce((a, x) => a + x.score, 0) / Math.max(s.scores.length, 1)) * 10,
    ) / 10,
  recommendation: s.recommendation,
  notes: s.notes,
  submittedAt: new Date(s.submitted_at).toISOString(),
});

/**
 * Candidates, the talent pool, applications and interview scores (TA Step D).
 *
 * A candidate is the person (kept 6 months after the last consideration); an
 * application is that person for one position. TA adds candidates one by one
 * — a duplicate email or phone is caught and the existing person reused. The
 * line's TA RM validates the shortlist. Each round's NAMED interviewer (or, for HR
 * rounds left blank, the position's recruiter) writes that round's scores —
 * final once written; an interviewer sees only their candidates and rounds.
 * Candidate data is TA's (the `ta.hiring` grant).
 */
export const createCandidatesService = (deps: {
  repo: CandidatesRepository;
  hiring: HiringRepository;
}) => {
  const { repo, hiring } = deps;

  const hydrateApplications = async (
    rows: ApplicationRow[],
  ): Promise<ApplicationDto[]> => {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [rounds, scores, decisions] = await Promise.all([
      repo.roundsOfApplications(ids),
      repo.scoresOf(ids),
      repo.hireDecisionsOf(ids),
    ]);
    return rows.map((a) => ({
      id: a.id,
      candidateId: a.candidate_id,
      candidateName: a.candidate_name,
      positionId: a.position_id,
      positionNumber: a.position_number,
      requisitionId: a.requisition_id,
      taRmId: a.ta_rm_id,
      roleTitle: a.role_title,
      departmentName: a.department_name,
      stage: a.stage,
      shortlistedByName: a.shortlisted_by_name,
      outcomeReason: a.outcome_reason,
      rounds: rounds
        .filter((r) => r.application_id === a.id)
        .map((r) => {
          const s = scores.find((x) => x.application_id === a.id && x.round === r.round);
          return {
            round: r.round,
            interviewerId: r.interviewer_id,
            interviewerName: r.interviewer_name,
            score: s ? toScore(s) : null,
          };
        }),
      createdAt: new Date(a.created_at).toISOString(),
      decision: {
        approvals: decisions
          // The retired TA head's decisions stay as history, not on screen.
          .filter((d): d is typeof d & { role: HireRole } =>
            d.subject_id === a.id && (HIRE_ROLES as readonly string[]).includes(d.role),
          )
          .map((d) => ({
            role: d.role,
            decision: d.decision,
            decidedByName: d.decided_by_name,
            reason: d.reason,
          })),
        waitingOn:
          a.stage === 'decision'
            ? HIRE_ROLES.filter(
                (role) =>
                  !decisions.some((d) => d.subject_id === a.id && d.role === role),
              )
            : [],
      },
      lineApproved: a.requisition_status === 'approved',
      offeredCtc: a.offered_ctc === null ? null : Number(a.offered_ctc),
      budgetMin: a.budget_min === null ? null : Number(a.budget_min),
      budgetMax: a.budget_max === null ? null : Number(a.budget_max),
      joiningDate: a.joining_date,
      hasOfferLetter: a.has_offer_letter,
      bgvStatus: a.bgv_status,
      bgvNotes: a.bgv_notes,
      employeeId: a.employee_id,
    }));
  };

  const toCandidate = (
    c: CandidateRow,
    applications: ApplicationDto[],
  ): CandidateDto => ({
    id: c.id,
    name: c.name,
    email: c.email,
    phone: c.phone,
    source: c.source,
    referredByName: c.referred_by_name,
    notes: c.notes,
    hasCv: c.has_cv,
    retainUntil: c.retain_until,
    anonymised: c.anonymised_at !== null,
    createdAt: new Date(c.created_at).toISOString(),
    applications: applications.filter((a) => a.candidateId === c.id),
  });

  const findCandidate = async (id: string): Promise<CandidateRow> => {
    const c = await repo.findCandidate(id);
    if (!c)
      throw createError(404, 'Candidate not found', { code: 'CANDIDATE_NOT_FOUND' });
    return c;
  };

  const candidate = async (id: string): Promise<CandidateDto> => {
    const c = await findCandidate(id);
    return toCandidate(
      c,
      await hydrateApplications(await repo.applicationsBy('candidate', [id])),
    );
  };

  const list = async (q: string | null): Promise<CandidateDto[]> => {
    const rows = await repo.list(q);
    if (rows.length === 0) return [];
    const apps = await hydrateApplications(
      await repo.applicationsBy(
        'candidate',
        rows.map((r) => r.id),
      ),
    );
    return rows.map((c) => toCandidate(c, apps));
  };

  const matches = async (
    email: string | null,
    phone: string | null,
  ): Promise<CandidateMatchDto[]> =>
    email || phone
      ? repo.matches(email?.trim().toLowerCase() || null, phone?.trim() || null)
      : [];

  const create = async (raw: CreateCandidateInput, actor: ActorContext) => {
    // Emails are stored lower-cased — the duplicate check and the unique index rely on it.
    const input = { ...raw, email: raw.email?.trim().toLowerCase() || undefined };
    const dupes = await matches(input.email ?? null, input.phone ?? null);
    if (dupes.length) {
      throw createError(
        409,
        `Already in the talent pool: ${dupes[0]!.name} — reuse them`,
        {
          code: 'DUPLICATE_CANDIDATE',
        },
      );
    }
    if (input.referredById) {
      const ok = await hiring.eligiblePeople([input.referredById]);
      if (!ok.has(input.referredById)) {
        throw createError(422, 'The referrer must be an active employee', {
          code: 'REFERRER_NOT_ELIGIBLE',
        });
      }
    }
    try {
      const id = await repo.insertCandidate(
        {
          name: input.name,
          email: input.email ?? null,
          phone: input.phone ?? null,
          source: input.source,
          referredBy: input.source === 'referral' ? (input.referredById ?? null) : null,
          notes: input.notes || null,
          retainUntil: retainUntil(),
        },
        actor,
      );
      return candidate(id);
    } catch (err) {
      const code = err as { code?: string; cause?: { code?: string } };
      if (code.code === '23505' || code.cause?.code === '23505') {
        throw createError(409, 'Someone with this email is already in the talent pool', {
          code: 'DUPLICATE_CANDIDATE',
        });
      }
      throw err;
    }
  };

  const uploadCv = async (
    id: string,
    file: { fileName: string; contentType: string; data: Buffer },
    actor: ActorContext,
  ) => {
    const c = await findCandidate(id);
    if (c.anonymised_at) {
      throw createError(409, 'This candidate was anonymised', { code: 'ANONYMISED' });
    }
    if (file.data.length === 0 || file.data.length > CV_MAX_BYTES) {
      throw createError(422, 'The CV must be a file under 10 MB', { code: 'CV_SIZE' });
    }
    const type = file.contentType.split(';')[0]!.trim().toLowerCase();
    if (!CV_TYPES.has(type)) {
      throw createError(422, 'Upload the CV as a PDF or Word file', { code: 'CV_TYPE' });
    }
    await repo.saveCv(id, { ...file, contentType: type }, actor);
    return candidate(id);
  };

  /**
   * The CV — for TA (the caller passes `isTa` from the grant check) or an
   * interviewer on one of the candidate's live applications. Nobody else.
   */
  const cv = async (id: string, employeeId: string, isTa: boolean) => {
    if (!isTa && !(await repo.interviewsCandidate(employeeId, id))) {
      throw createError(
        403,
        "Only TA and this candidate's interviewers can open the CV",
        {
          code: 'CV_FORBIDDEN',
        },
      );
    }
    const file = await repo.cv(id);
    if (!file) throw createError(404, 'No CV uploaded', { code: 'CV_NOT_FOUND' });
    return { fileName: file.file_name, contentType: file.content_type, data: file.data };
  };

  const one = async (applicationId: string) =>
    (await hydrateApplications(await repo.applicationsBy('id', [applicationId])))[0]!;

  const findApplication = async (id: string): Promise<ApplicationRow> => {
    const a = (await repo.applicationsBy('id', [id]))[0];
    if (!a)
      throw createError(404, 'Application not found', { code: 'APPLICATION_NOT_FOUND' });
    return a;
  };

  const pipeline = async (positionId: string) =>
    hydrateApplications(await repo.applicationsBy('position', [positionId]));

  /** Consider a (new or pool) candidate for an open position. */
  const apply = async (positionId: string, candidateId: string, actor: ActorContext) => {
    const p = await repo.positionForApplying(positionId);
    if (!p) throw createError(404, 'Position not found', { code: 'POSITION_NOT_FOUND' });
    if (p.status !== 'open' && p.status !== 'interviewing') {
      throw createError(409, 'Candidates are added once the position is open', {
        code: 'POSITION_NOT_OPEN',
      });
    }
    const c = await findCandidate(candidateId);
    if (c.anonymised_at) {
      throw createError(409, 'This candidate was anonymised', { code: 'ANONYMISED' });
    }
    const already = () =>
      createError(409, 'This candidate is already on this position', {
        code: 'ALREADY_APPLIED',
      });
    if (
      (await repo.applicationsBy('candidate', [candidateId])).some(
        (a) => a.position_id === positionId,
      )
    ) {
      throw already();
    }
    try {
      return one(
        await repo.addApplication(candidateId, positionId, retainUntil(), actor),
      );
    } catch (err) {
      const code = err as { code?: string; cause?: { code?: string } };
      if (code.code === '23505' || code.cause?.code === '23505') {
        throw already();
      }
      throw err;
    }
  };

  /** The line's TA RM validates the shortlist (TA design). */
  const shortlist = async (id: string, actor: ActorContext) => {
    if ((await findApplication(id)).ta_rm_id !== actor.actorEmployeeId) {
      throw createError(403, "Only this line's TA RM validates the shortlist", {
        code: 'NOT_LINE_TA_RM',
      });
    }
    if (
      !(await repo.moveStage(
        id,
        ['sourced'],
        'shortlisted',
        {
          shortlistedBy: actor.actorEmployeeId,
        },
        actor,
      ))
    ) {
      throw createError(409, 'Only a sourced candidate can be shortlisted', {
        code: 'WRONG_STAGE',
      });
    }
    return one(id);
  };

  /** Shortlisted → interviewing: every interviewer on the line is told. */
  const startInterviews = async (id: string, actor: ActorContext) => {
    const a = await findApplication(id);
    const rounds = (await repo.roundsOfApplications([id])).filter((r) => r.round);
    const missing = rounds.filter((r) => !r.interviewer_id);
    if (missing.length) {
      throw createError(
        422,
        `Name an interviewer first for: ${missing.map((r) => r.round).join(', ')}`,
        { code: 'INTERVIEWER_MISSING' },
      );
    }
    const to = [...new Set(rounds.map((r) => r.interviewer_id!))];
    const ok = await repo.startInterviews(id, POSITION_PROGRESS.interviewing, actor, [
      {
        to,
        event: {
          type: 'hiring.interview',
          title: `Interview to score: ${a.candidate_name} for ${a.role_title} (${a.department_name})`,
          link: LINK_INTERVIEWS,
        },
      },
    ]);
    if (!ok) {
      throw createError(409, 'Only a shortlisted candidate can start interviews', {
        code: 'WRONG_STAGE',
      });
    }
    return one(id);
  };

  const end = async (
    id: string,
    to: 'rejected' | 'withdrawn',
    reason: string,
    actor: ActorContext,
  ) => {
    if (
      !(await repo.moveStage(
        id,
        ['sourced', 'shortlisted', 'interviewing', 'interviewed', 'decision', 'selected'],
        to,
        { outcomeReason: reason },
        actor,
      ))
    ) {
      throw createError(409, 'This application has already ended', {
        code: 'WRONG_STAGE',
      });
    }
    return one(id);
  };

  /** TA swaps a round's interviewer on the line; the department head is told. */
  const swapInterviewer = async (
    requisitionId: string,
    round: InterviewRound,
    interviewerId: string,
    actor: ActorContext,
  ) => {
    const r = await hiring.findRequisition(requisitionId);
    if (!r)
      throw createError(404, 'Requisition not found', { code: 'REQUISITION_NOT_FOUND' });
    const ok = await hiring.eligiblePeople([interviewerId]);
    if (!ok.has(interviewerId)) {
      throw createError(422, 'Interviewers must be active employees', {
        code: 'INTERVIEWER_NOT_ELIGIBLE',
      });
    }
    const head = await hiring.departmentHead(r.department_id);
    const bells: Bell[] = head
      ? [
          {
            to: [head],
            event: {
              type: 'hiring.interviewer_swapped',
              title: `TA changed the ${round} interviewer for ${r.role_title}`,
              link: LINK_PLAN,
            },
          },
        ]
      : [];
    if (
      !(await repo.swapInterviewer(requisitionId, round, interviewerId, actor, bells))
    ) {
      throw createError(404, 'This line has no such round', {
        code: 'ROUND_NOT_IN_LINE',
      });
    }
  };

  /**
   * The round's interviewer writes its scores: one 1–5 score for EVERY
   * scorecard criterion of that round (no more, no less). Final once written.
   */
  const score = async (
    id: string,
    round: InterviewRound,
    input: SubmitScoreInput,
    actor: ActorContext,
  ) => {
    const who = await repo.interviewerOf(id, round);
    if (!who)
      throw createError(404, 'This application has no such round', { code: 'NO_ROUND' });
    if (who.interviewer_id !== actor.actorEmployeeId) {
      throw createError(403, 'Only the interviewer of this round scores it', {
        code: 'NOT_THE_INTERVIEWER',
      });
    }
    const criteria = await repo.criteriaFor(id, round);
    const given = input.scores.map((s) => s.criterion);
    if (
      criteria.length !== given.length ||
      criteria.some((c) => !given.includes(c)) ||
      new Set(given).size !== given.length
    ) {
      throw createError(
        422,
        'Score every criterion of this round on the scorecard, once',
        {
          code: 'CRITERIA_MISMATCH',
        },
      );
    }
    const a = await findApplication(id);
    const ta = a.ta_rm_id;
    const res = await repo.insertScore(
      {
        applicationId: id,
        round,
        interviewerId: actor.actorEmployeeId,
        scores: input.scores,
        recommendation: input.recommendation,
        notes: input.notes || null,
      },
      actor,
      [
        {
          to: [...new Set([a.recruiter_id, ta].filter((x): x is string => !!x))],
          event: {
            type: 'hiring.interviewed',
            title: `All rounds scored: ${a.candidate_name} for ${a.role_title}`,
            link: LINK_TA,
          },
        },
      ],
    );
    if (res === 'not_interviewing') {
      throw createError(409, 'This candidate is not in interviews', {
        code: 'WRONG_STAGE',
      });
    }
    if (res === 'already_scored') {
      throw createError(409, 'This round is already scored — scores are final', {
        code: 'ALREADY_SCORED',
      });
    }
    return one(id);
  };

  const myInterviews = async (employeeId: string): Promise<MyInterviewDto[]> => {
    const rows = await repo.myInterviews(employeeId);
    if (rows.length === 0) return [];
    const mine = (
      await repo.scoresOf([...new Set(rows.map((r) => r.application_id))])
    ).filter((s) => s.interviewer_id === employeeId);
    return rows.map((r) => {
      const s = mine.find(
        (x) => x.application_id === r.application_id && x.round === r.round,
      );
      return {
        applicationId: r.application_id,
        candidateId: r.candidate_id,
        candidateName: r.candidate_name,
        hasCv: r.has_cv,
        roleTitle: r.role_title,
        departmentName: r.department_name,
        round: r.round,
        criteria: (r.criteria ?? []).map((c) => ({
          criterion: c.criterion,
          guidance: c.guidance ?? null,
        })),
        jdSummary: r.jd_summary,
        myScore: s ? toScore(s) : null,
      };
    });
  };

  return {
    list,
    candidate,
    matches,
    create,
    uploadCv,
    cv,
    pipeline,
    apply,
    shortlist,
    startInterviews,
    end,
    swapInterviewer,
    score,
    myInterviews,
    one,
  };
};

export type CandidatesService = ReturnType<typeof createCandidatesService>;
