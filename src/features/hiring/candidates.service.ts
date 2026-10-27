import createError from 'http-errors';
import { addDaysIso, localDateOf } from '../../shared/helpers/helpers.js';
import type {
  ApplicationRow,
  CandidateRow,
  CandidatesRepository,
  ScoreRow,
  SlotRow,
} from './candidates.repository.js';
import { ROUND_ORDER } from './candidates.repository.js';
import type {
  ActivityDto,
  ApplicationDto,
  CandidateDto,
  CandidateMatchDto,
  CreateCandidateInput,
  EndInterviewSlotInput,
  InterviewSlotDto,
  LogActivityInput,
  MyInterviewDto,
  NextActionInput,
  RoundScoreDto,
  ScheduleInterviewInput,
  SubmitScoreInput,
  UpdateCandidateInput,
} from './candidates.schema.js';
import type { ActorContext, Bell, HiringRepository } from './hiring.repository.js';
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

const one1 = (n: number) => Math.round(n * 10) / 10;

const toSlot = (s: SlotRow): InterviewSlotDto => ({
  id: s.id,
  startsAt: new Date(s.starts_at).toISOString(),
  durationMin: s.duration_min,
  mode: s.mode,
  location: s.location,
  status: s.status,
  endReason: s.end_reason,
});

/** "28 Oct 2026, 3:00 pm" in India time, for bells. */
const whenText = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

const MODE_TEXT = { in_person: 'in person', video: 'video call', phone: 'phone call' } as const;

const ROUND_TEXT: Record<InterviewRound, string> = {
  hr: 'HR',
  technical: 'Technical',
  practical: 'Practical',
  managerial: 'Managerial',
  hr_final: 'HR final',
};

/**
 * A round out of 100, as the Excel works it out: every attribute has the same
 * share (100 ÷ attributes) and earns score/4 of it.
 */
export const roundScoreOf = (scores: Array<{ score: number }>): number =>
  scores.length === 0
    ? 0
    : one1(scores.reduce((a, x) => a + (x.score / 4) * (100 / scores.length), 0));

const toScore = (s: ScoreRow): RoundScoreDto => ({
  round: s.round,
  interviewerName: s.interviewer_name,
  scores: s.scores.map((x) => ({
    attribute: x.attribute,
    score: x.score,
    evidence: x.evidence ?? null,
  })),
  roundScore: roundScoreOf(s.scores),
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
    const [rounds, scores, slots] = await Promise.all([
      repo.roundsOfApplications(ids),
      repo.scoresOf(ids),
      repo.slotsOf(ids),
    ]);
    return rows.map((a) => {
      const mine = rounds
        .filter((r) => r.application_id === a.id)
        .map((r) => {
          const s = scores.find((x) => x.application_id === a.id && x.round === r.round);
          const slot = slots.find((x) => x.application_id === a.id && x.round === r.round);
          return {
            round: r.round,
            weight: r.weight,
            interviewerId: r.interviewer_id,
            interviewerName: r.interviewer_name,
            score: s ? toScore(s) : null,
            slot: slot ? toSlot(slot) : null,
          };
        });
      const scored = mine.filter((r) => r.score && r.weight !== null);
      return {
      id: a.id,
      candidateId: a.candidate_id,
      candidateName: a.candidate_name,
      candidateCode: a.candidate_code,
      candidateSource: a.candidate_source,
      candidateNoticeDays: a.candidate_notice_days,
      nextAction: a.next_action
        ? {
            text: a.next_action,
            ownerId: a.next_action_owner_id,
            ownerName: a.next_action_owner_name,
            due: a.next_action_due,
          }
        : null,
      contactCount: a.contact_count,
      lastContactAt: a.last_contact_at ? new Date(a.last_contact_at).toISOString() : null,
      positionId: a.position_id,
      positionNumber: a.position_number,
      requisitionId: a.requisition_id,
      taRmId: a.ta_rm_id,
      recruiterId: a.recruiter_id,
      roleTitle: a.role_title,
      departmentName: a.department_name,
      stage: a.stage,
      currentRound: a.current_round,
      rejectedRound: a.rejected_round,
      rejectedByName: a.rejected_by_name,
      informedAt: a.informed_at ? new Date(a.informed_at).toISOString() : null,
      shortlistedByName: a.shortlisted_by_name,
      outcomeReason: a.outcome_reason,
      rounds: mine,
      scoreTotal: scored.length
        ? one1(scored.reduce((t, r) => t + (r.score!.roundScore * r.weight!) / 100, 0))
        : null,
      candidateEducation: a.education,
      candidateExperienceYears: a.experience_years === null ? null : Number(a.experience_years),
      createdAt: new Date(a.created_at).toISOString(),
      updatedAt: new Date(a.updated_at).toISOString(),
      lineApproved: a.requisition_status === 'approved',
      offer: a.offer_status
        ? {
            status: a.offer_status,
            ctc: a.offered_ctc === null ? null : Number(a.offered_ctc),
            joiningDate: a.joining_date,
            terms: a.offer_terms,
            returnReason: a.offer_return_reason,
            approvedByName: a.offer_approved_by_name,
            approvedAt: a.offer_approved_at ? new Date(a.offer_approved_at).toISOString() : null,
          }
        : null,
      offeredCtc: a.offered_ctc === null ? null : Number(a.offered_ctc),
      joiningDate: a.joining_date,
      hasOfferLetter: a.has_offer_letter,
      hasSignedLetter: a.has_signed_letter,
      documents: { received: a.docs_received, pending: a.docs_pending, total: a.docs_total },
      folderLink: a.folder_link,
      employeeId: a.employee_id,
      joinedAt: a.joined_at ? new Date(a.joined_at).toISOString() : null,
      };
    });
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
    candidateCode: c.candidate_code,
    education: c.education,
    experienceYears: c.experience_years === null ? null : Number(c.experience_years),
    currentCompany: c.current_company,
    designation: c.designation,
    location: c.location,
    noticeDays: c.notice_days,
    currentCtc: c.current_ctc === null ? null : Number(c.current_ctc),
    expectedCtc: c.expected_ctc === null ? null : Number(c.expected_ctc),
    availableFrom: c.available_from,
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
          education: input.education,
          experienceYears: input.experienceYears,
          currentCompany: input.currentCompany || null,
          designation: input.designation || null,
          location: input.location,
          noticeDays: input.noticeDays,
          currentCtc: input.currentCtc ?? null,
          expectedCtc: input.expectedCtc ?? null,
          availableFrom: input.availableFrom ?? null,
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

  /** Every application on these positions — the Hiring board's pipeline. */
  const pipelines = async (positionIds: string[]) =>
    positionIds.length
      ? hydrateApplications(await repo.applicationsBy('position', positionIds))
      : [];

  /** The position's recruiter or the line's TA RM works its candidates. */
  const assertWorks = (
    p: { recruiter_id: string | null; ta_rm_id: string | null },
    actor: ActorContext,
  ) => {
    if (
      actor.actorEmployeeId !== p.recruiter_id &&
      actor.actorEmployeeId !== p.ta_rm_id
    ) {
      throw createError(403, "Only this position's recruiter or the line's TA RM can do this", {
        code: 'NOT_POSITION_OWNER',
      });
    }
  };

  /** Consider a (new or pool) candidate for an open position. */
  const apply = async (positionId: string, candidateId: string, actor: ActorContext) => {
    const p = await repo.positionForApplying(positionId);
    if (!p) throw createError(404, 'Position not found', { code: 'POSITION_NOT_FOUND' });
    assertWorks(p, actor);
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

  /**
   * Sourced → interviewing, round 1 open: the recruiter's screening call is the
   * gate (workflow deck, 2026-10-27 — no separate shortlist check). Rounds then
   * run one after another; each opens only after the one before passes.
   */
  const startInterviews = async (id: string, actor: ActorContext) => {
    const a = await findApplication(id);
    assertWorks(a, actor);
    const rounds = (await repo.roundsOfApplications([id])).filter((r) => r.round);
    const missing = rounds.filter((r) => !r.interviewer_id);
    if (missing.length) {
      throw createError(
        422,
        `Name an interviewer first for: ${missing.map((r) => r.round).join(', ')}`,
        { code: 'INTERVIEWER_MISSING' },
      );
    }
    const first = [...rounds].sort(
      (x, y) => ROUND_ORDER.indexOf(x.round) - ROUND_ORDER.indexOf(y.round),
    )[0]!;
    const ok = await repo.startInterviews(id, first.round, POSITION_PROGRESS.interviewing, actor, [
      {
        to: first.interviewer_id && first.interviewer_id !== actor.actorEmployeeId ? [first.interviewer_id] : [],
        event: {
          type: 'hiring.interview',
          title: `${ROUND_TEXT[first.round]} round to conduct: ${a.candidate_name} for ${a.role_title} (${a.department_name})`,
          link: LINK_INTERVIEWS,
        },
      },
    ]);
    if (!ok) {
      throw createError(409, 'Interviews start once, from a newly added candidate', {
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
    assertWorks(await findApplication(id), actor);
    if (
      !(await repo.moveStage(
        id,
        ['sourced', 'shortlisted', 'interviewing', 'interviewed', 'decision', 'selected'],
        to,
        { outcomeReason: reason, rejectedBy: actor.actorEmployeeId },
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
    if (r.ta_rm_id !== actor.actorEmployeeId) {
      throw createError(403, "Only the line's TA RM swaps an interviewer", {
        code: 'NOT_LINE_TA_RM',
      });
    }
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
   * The round's interviewer writes its scores: one 1–4 score (with evidence)
   * for EVERY attribute on that round's sheet (no more, no less). Final once written.
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
    const attributes = await repo.attributesFor(id, round);
    const given = input.scores.map((s) => s.attribute);
    if (
      attributes.length !== given.length ||
      attributes.some((c) => !given.includes(c)) ||
      new Set(given).size !== given.length
    ) {
      throw createError(422, 'Score every attribute on this round\'s sheet, once', {
        code: 'ATTRIBUTES_MISMATCH',
      });
    }
    const a = await findApplication(id);
    const ta = a.ta_rm_id;
    const owners = [...new Set([a.recruiter_id, ta].filter((x): x is string => !!x))];
    const res = await repo.insertScore(
      {
        applicationId: id,
        round,
        interviewerId: actor.actorEmployeeId,
        scores: input.scores.map((s) => ({
          attribute: s.attribute,
          score: s.score,
          evidence: s.evidence || null,
        })),
        recommendation: input.recommendation,
        notes: input.notes || null,
      },
      actor,
      (outcome, next): Bell[] =>
        outcome === 'rejected'
          ? [
              {
                to: owners,
                event: {
                  type: 'hiring.rejected',
                  title: `${a.candidate_name} not selected in the ${ROUND_TEXT[round]} round (${a.role_title}) — ${input.notes}`,
                  link: LINK_TA,
                },
              },
            ]
          : outcome === 'next_round' && next
            ? [
                {
                  to: owners,
                  event: {
                    type: 'hiring.round_passed',
                    title: `${a.candidate_name} passed ${ROUND_TEXT[round]} — schedule the ${ROUND_TEXT[next.round]} round`,
                    link: LINK_TA,
                  },
                },
                {
                  to: next.interviewerId && !owners.includes(next.interviewerId) ? [next.interviewerId] : [],
                  event: {
                    type: 'hiring.interview',
                    title: `${ROUND_TEXT[next.round]} round to conduct: ${a.candidate_name} for ${a.role_title}`,
                    link: LINK_INTERVIEWS,
                  },
                },
              ]
            : [
                {
                  to: owners,
                  event: {
                    type: 'hiring.interviewed',
                    title: `All rounds passed: ${a.candidate_name} for ${a.role_title}`,
                    link: LINK_TA,
                  },
                },
              ],
    );
    if (res === 'not_open') {
      throw createError(409, 'This round is not open yet — the round before it must pass first', {
        code: 'ROUND_NOT_OPEN',
      });
    }
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

  /** The recruiter records that the candidate was told the outcome. */
  const markInformed = async (id: string, actor: ActorContext) => {
    assertWorks(await findApplication(id), actor);
    if (!(await repo.markInformed(id, actor))) {
      throw createError(409, 'Only a rejected or withdrawn candidate, once', {
        code: 'WRONG_STAGE',
      });
    }
    return one(id);
  };

  /** Fill or correct a candidate's profile (TA). */
  const updateCandidate = async (id: string, input: UpdateCandidateInput, actor: ActorContext) => {
    await findCandidate(id);
    if (!(await repo.updateCandidate(id, input, actor))) {
      throw createError(409, 'This candidate was anonymised', { code: 'ANONYMISED' });
    }
    return candidate(id);
  };

  /** What happens next on an application — the recruiter or the line's TA RM sets it. */
  const setNextAction = async (id: string, input: NextActionInput, actor: ActorContext) => {
    assertWorks(await findApplication(id), actor);
    if (input.ownerId && !(await hiring.eligiblePeople([input.ownerId])).has(input.ownerId)) {
      throw createError(422, 'The owner must be an active employee', {
        code: 'OWNER_NOT_ELIGIBLE',
      });
    }
    await repo.setNextAction(
      id,
      input.nextAction
        ? { nextAction: input.nextAction, ownerId: input.ownerId, due: input.due }
        : { nextAction: null, ownerId: null, due: null },
      actor,
    );
    return one(id);
  };

  /** Log a call / email / message / meeting with the candidate (recruiter or TA RM). */
  const logActivity = async (id: string, input: LogActivityInput, actor: ActorContext) => {
    assertWorks(await findApplication(id), actor);
    if (input.happenedAt && new Date(input.happenedAt).getTime() > Date.now() + 60_000) {
      throw createError(422, 'A contact is logged after it happens', { code: 'IN_THE_FUTURE' });
    }
    await repo.logActivity(
      {
        applicationId: id,
        kind: input.kind,
        outcome: input.outcome,
        notes: input.notes || null,
        happenedAt: input.happenedAt ?? null,
      },
      actor,
    );
    return one(id);
  };

  const activities = async (id: string): Promise<ActivityDto[]> => {
    await findApplication(id);
    return (await repo.activitiesOf(id)).map((x) => ({
      id: x.id,
      kind: x.kind,
      outcome: x.outcome,
      notes: x.notes,
      happenedAt: new Date(x.happened_at).toISOString(),
      byName: x.by_name,
    }));
  };

  /**
   * The position's recruiter (or the line's TA RM) schedules a round with the
   * line's interviewer for it, or moves it; the interviewer is told.
   */
  const schedule = async (
    id: string,
    round: InterviewRound,
    input: ScheduleInterviewInput,
    actor: ActorContext,
  ) => {
    const a = await findApplication(id);
    assertWorks(a, actor);
    const who = await repo.interviewerOf(id, round);
    if (!who)
      throw createError(404, 'This application has no such round', { code: 'NO_ROUND' });
    if (a.stage === 'interviewing' && a.current_round !== round) {
      throw createError(409, 'Only the round open now can be scheduled', {
        code: 'ROUND_NOT_OPEN',
      });
    }
    if (!who.interviewer_id) {
      throw createError(422, 'Name an interviewer for this round first', {
        code: 'INTERVIEWER_MISSING',
      });
    }
    if (new Date(input.startsAt).getTime() < Date.now()) {
      throw createError(422, 'Pick a time in the future', { code: 'IN_THE_PAST' });
    }
    const label = ROUND_TEXT[round];
    const where = input.location ? ` — ${input.location}` : '';
    const res = await repo.scheduleSlot(
      {
        applicationId: id,
        round,
        interviewerId: who.interviewer_id,
        startsAt: input.startsAt,
        durationMin: input.durationMin,
        mode: input.mode,
        location: input.location || null,
      },
      actor,
      [
        {
          to: [who.interviewer_id],
          event: {
            type: 'hiring.interview_scheduled',
            title: `${label} interview: ${a.candidate_name} (${a.role_title}) on ${whenText(input.startsAt)}, ${MODE_TEXT[input.mode]}${where}`,
            link: LINK_INTERVIEWS,
          },
        },
      ],
    );
    if (res === 'not_interviewing') {
      throw createError(409, 'Rounds are scheduled once interviews have started', {
        code: 'WRONG_STAGE',
      });
    }
    if (res === 'scored') {
      throw createError(409, 'This round is already scored', { code: 'ALREADY_SCORED' });
    }
    return one(id);
  };

  /** Call off a scheduled round: cancelled, or the candidate did not show. */
  const endSlot = async (
    id: string,
    round: InterviewRound,
    input: EndInterviewSlotInput,
    actor: ActorContext,
  ) => {
    const a = await findApplication(id);
    assertWorks(a, actor);
    const who = await repo.interviewerOf(id, round);
    const what = input.noShow ? 'did not show up for' : 'is called off:';
    const ok = await repo.endSlot(
      id,
      round,
      input.noShow ? 'no_show' : 'cancelled',
      input.reason,
      actor,
      who?.interviewer_id
        ? [
            {
              to: [who.interviewer_id],
              event: {
                type: 'hiring.interview_cancelled',
                title: input.noShow
                  ? `${a.candidate_name} ${what} the ${ROUND_TEXT[round]} interview`
                  : `${ROUND_TEXT[round]} interview with ${a.candidate_name} ${what} ${input.reason}`,
                link: LINK_INTERVIEWS,
              },
            },
          ]
        : [],
    );
    if (!ok) {
      throw createError(409, 'This round has no scheduled interview', {
        code: 'NOT_SCHEDULED',
      });
    }
    return one(id);
  };

  const myInterviews = async (employeeId: string): Promise<MyInterviewDto[]> => {
    const rows = await repo.myInterviews(employeeId);
    if (rows.length === 0) return [];
    const appIds = [...new Set(rows.map((r) => r.application_id))];
    const mine = (await repo.scoresOf(appIds)).filter((s) => s.interviewer_id === employeeId);
    const slots = await repo.slotsOf(appIds);
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
        roundWeight: r.round_weight,
        attributes: (r.attributes ?? []).map((x) => ({
          name: x.name,
          questions: x.questions ?? [],
        })),
        candidateEducation: r.education,
        candidateExperienceYears:
          r.experience_years === null ? null : Number(r.experience_years),
        jdSummary: r.jd_summary,
        slot: (() => {
          const x = slots.find(
            (y) => y.application_id === r.application_id && y.round === r.round,
          );
          return x ? toSlot(x) : null;
        })(),
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
    pipelines,
    apply,
    startInterviews,
    end,
    swapInterviewer,
    score,
    myInterviews,
    schedule,
    endSlot,
    updateCandidate,
    markInformed,
    setNextAction,
    logActivity,
    activities,
    one,
  };
};

export type CandidatesService = ReturnType<typeof createCandidatesService>;
