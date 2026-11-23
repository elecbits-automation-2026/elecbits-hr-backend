import type { DbClient } from '../../db/client.js';
import { auditLog } from '../../db/schema/index.js';
import { insertNotifications } from '../notifications/index.js';
import { fileColumns } from '../storage/index.js';
import type { ActorContext, Bell, PositionStatus } from './hiring.repository.js';
import type { ApplicationStage, CandidateSource } from './candidates.schema.js';
import type { InterviewRound } from './hiring.schema.js';

export interface CandidateRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  source: CandidateSource;
  referred_by_name: string | null;
  notes: string | null;
  candidate_code: string | null;
  education: string | null;
  experience_years: string | null;
  current_company: string | null;
  designation: string | null;
  location: string | null;
  notice_days: number | null;
  current_ctc: string | null;
  expected_ctc: string | null;
  available_from: string | null;
  has_cv: boolean;
  retain_until: string;
  anonymised_at: Date | null;
  created_at: Date;
}

export interface ApplicationRow {
  id: string;
  candidate_id: string;
  candidate_name: string;
  candidate_code: string | null;
  candidate_notice_days: number | null;
  candidate_source: CandidateSource;
  next_action: string | null;
  next_action_owner_id: string | null;
  next_action_owner_name: string | null;
  next_action_due: string | null;
  contact_count: number;
  last_contact_at: Date | null;
  education: string | null;
  experience_years: string | null;
  position_id: string;
  position_number: number;
  position_status: string;
  /** Set while the seat is on hold — forward moves are blocked. */
  position_on_hold_at: Date | null;
  recruiter_id: string | null;
  requisition_id: string;
  /** The line's TA RM (Admin gave them the line). */
  ta_rm_id: string | null;
  role_title: string;
  department_id: string;
  department_name: string;
  stage: ApplicationStage;
  current_round: InterviewRound | null;
  rejected_round: InterviewRound | null;
  rejected_by_name: string | null;
  informed_at: Date | null;
  /** The stage a rejected / withdrawn application ended from (restore target). */
  pre_end_stage: ApplicationStage | null;
  shortlisted_by_name: string | null;
  outcome_reason: string | null;
  created_at: Date;
  updated_at: Date;
  // Step E
  requisition_status: string;
  urgent: boolean;
  offered_ctc: string | null;
  joining_date: string | null;
  has_offer_letter: boolean;
  has_signed_letter: boolean;
  offer_terms: string | null;
  offer_status: 'draft' | 'pending' | 'approved' | 'returned' | null;
  offer_return_reason: string | null;
  offer_approved_by_name: string | null;
  offer_approved_at: Date | null;
  docs_received: number;
  docs_pending: number;
  docs_total: number;
  folder_link: string | null;
  employee_id: string | null;
  joined_at: Date | null;
}

export interface SlotRow {
  id: string;
  application_id: string;
  round: InterviewRound;
  interviewer_id: string;
  starts_at: Date;
  duration_min: number;
  mode: 'in_person' | 'video' | 'phone';
  location: string | null;
  status: 'scheduled' | 'done' | 'cancelled' | 'no_show';
  end_reason: string | null;
}

export interface ScoreRow {
  application_id: string;
  round: InterviewRound;
  interviewer_id: string;
  interviewer_name: string;
  scores: Array<{ attribute: string; score: number; evidence: string | null }>;
  recommendation: 'hire' | 'no_hire';
  notes: string | null;
  submitted_at: Date;
}

const SELECT_CANDIDATE = `
  SELECT c.id, c.name, c.email, c.phone, c.source, r.name AS referred_by_name, c.notes,
         c.education, c.experience_years, c.candidate_code, c.current_company, c.designation,
         c.location, c.notice_days, c.current_ctc::text, c.expected_ctc::text,
         c.available_from::text,
         EXISTS (SELECT 1 FROM ta.candidate_cvs v WHERE v.candidate_id = c.id) AS has_cv,
         c.retain_until::text, c.anonymised_at, c.created_at
    FROM ta.candidates c LEFT JOIN org.employees r ON r.id = c.referred_by`;

const SELECT_APPLICATION = `
  SELECT a.id, a.candidate_id, c.name AS candidate_name, c.source AS candidate_source,
         c.candidate_code, c.notice_days AS candidate_notice_days,
         a.next_action, a.next_action_owner_id, na.name AS next_action_owner_name,
         a.next_action_due::text,
         (SELECT count(*)::int FROM ta.activities x WHERE x.application_id = a.id) AS contact_count,
         (SELECT max(x.happened_at) FROM ta.activities x WHERE x.application_id = a.id) AS last_contact_at,
         c.education, c.experience_years::text,
         a.position_id,
         p.number AS position_number, p.status::text AS position_status, p.recruiter_id,
         p.on_hold_at AS position_on_hold_at,
         p.requisition_id, q.ta_rm_id, q.role_title, q.department_id, d.name AS department_name,
         a.stage, a.current_round, a.rejected_round, rj.name AS rejected_by_name, a.informed_at,
         a.pre_end_stage,
         s.name AS shortlisted_by_name, a.outcome_reason, a.created_at, a.updated_at,
         q.status::text AS requisition_status, q.urgent, a.offered_ctc::text,
         a.joining_date::text,
         EXISTS (SELECT 1 FROM ta.offer_letters o WHERE o.application_id = a.id) AS has_offer_letter,
         EXISTS (SELECT 1 FROM ta.signed_offer_letters o WHERE o.application_id = a.id) AS has_signed_letter,
         a.offer_terms, a.offer_status, a.offer_return_reason, oa.name AS offer_approved_by_name,
         a.offer_approved_at, a.folder_link, a.employee_id, a.joined_at,
         (SELECT count(*) FILTER (WHERE x.status = 'received')::int FROM ta.application_documents x
           WHERE x.application_id = a.id) AS docs_received,
         (SELECT count(*) FILTER (WHERE x.status = 'requested')::int FROM ta.application_documents x
           WHERE x.application_id = a.id) AS docs_pending,
         (SELECT count(*)::int FROM ta.application_documents x WHERE x.application_id = a.id) AS docs_total
    FROM ta.applications a
    JOIN ta.candidates c ON c.id = a.candidate_id
    JOIN ta.positions p ON p.id = a.position_id
    JOIN ta.requisitions q ON q.id = p.requisition_id
    JOIN org.departments d ON d.id = q.department_id
    LEFT JOIN org.employees s ON s.id = a.shortlisted_by
    LEFT JOIN org.employees na ON na.id = a.next_action_owner_id
    LEFT JOIN org.employees rj ON rj.id = a.rejected_by
    LEFT JOIN org.employees oa ON oa.id = a.offer_approved_by`;

/**
 * Who conducts a round of an application: round 1 (screening) is always the
 * position's recruiter — the TA SPOC (2026-10-27); other rounds the
 * interviewer the head named, or for an HR final left blank, the recruiter.
 */
const INTERVIEWER_OF = `CASE WHEN rr.round = 'hr' THEN p.recruiter_id
  ELSE coalesce(rr.interviewer_id, CASE WHEN rr.round = 'hr_final' THEN p.recruiter_id END) END`;

/** The order rounds run in. */
/** Asked of every candidate once all rounds pass (workflow deck step 13); TA can add more. */
export const DEFAULT_CANDIDATE_DOCUMENTS = [
  'Last 3 months payslips',
  'Relieving / experience letters',
  'Educational certificates',
  'ID proof (Aadhaar / PAN)',
  'Address proof',
  'Passport-size photo',
] as const;

export const ROUND_ORDER: InterviewRound[] = [
  'hr',
  'technical',
  'practical',
  'managerial',
  'hr_final',
];

/** An interviewer sees a round while it is open, and afterwards once they scored it. */
const ROUND_VISIBLE = `((a.stage = 'interviewing' AND rr.round = a.current_round)
  OR EXISTS (SELECT 1 FROM ta.interview_scores s0
              WHERE s0.application_id = a.id AND s0.round = rr.round))`;

const audit = (
  tx: DbClient,
  actor: ActorContext,
  action: string,
  subject: string,
  detail?: Record<string, unknown>,
) =>
  tx.orm.insert(auditLog).values({
    actorUserId: actor.actorUserId,
    action,
    subject,
    detail: detail ? JSON.stringify(detail) : null,
  });

const ring = async (tx: DbClient, bells: Bell[] = []) => {
  for (const b of bells)
    await insertNotifications(tx, b.to, b.event, {
      email: b.email,
      dedupeKey: b.dedupeKey,
    });
};

/** The interview rounds in running order, for SQL ordering. */
const ROUND_ARRAY = `ARRAY['hr','technical','practical','managerial','hr_final']::interview_round[]`;

/**
 * Re-derive a position's stage from its candidates after a step back or a
 * restore: anyone offered → `offer`, anyone else in play → `interviewing`,
 * else `open`. A filled or not-yet-open seat is left alone. The hiring goal
 * follows (set, not raised).
 */
const settlePosition = async (
  tx: DbClient,
  positionId: string,
  progress: Record<PositionStatus, number>,
) => {
  const row = (
    await tx.query<{ status: PositionStatus }>(
      `UPDATE ta.positions p SET
          status = CASE
            WHEN EXISTS (SELECT 1 FROM ta.applications a
                          WHERE a.position_id = p.id AND a.stage = 'offered')
              THEN 'offer'::position_status
            WHEN EXISTS (SELECT 1 FROM ta.applications a
                          WHERE a.position_id = p.id
                            AND a.stage IN ('interviewing', 'interviewed', 'decision', 'selected'))
              THEN 'interviewing'::position_status
            ELSE 'open'::position_status END,
          updated_at = now()
        WHERE p.id = $1 AND p.status IN ('open', 'interviewing', 'offer') RETURNING status`,
      [positionId],
    )
  )[0];
  if (!row) return;
  await tx.query(
    `UPDATE org.goals g SET progress = $2, updated_at = now()
       FROM org.review_cycles c
      WHERE c.id = g.cycle_id AND c.closed_at IS NULL AND g.position_id = $1`,
    [positionId, progress[row.status]],
  );
};

/**
 * Back to interviewed with the offer returned to TA (like the HR Head's
 * Return): approval cleared, the signed letter discarded; the draft terms
 * and the draft letter stay for the next submit.
 */
const returnOfferIn = async (tx: DbClient, id: string, reason: string) => {
  await tx.query(
    `UPDATE ta.applications SET stage = 'interviewed',
            offer_status = CASE WHEN offer_status IS NULL THEN NULL
                                ELSE 'returned'::offer_status END,
            offer_return_reason = CASE WHEN offer_status IS NULL THEN offer_return_reason
                                       ELSE $2 END,
            offer_approved_by = NULL, offer_approved_at = NULL, offered_at = NULL,
            updated_at = now()
      WHERE id = $1`,
    [id, reason],
  );
  await tx.query(`DELETE FROM ta.signed_offer_letters WHERE application_id = $1`, [id]);
};

/** DB access for candidates, applications and interview scores (TA Step D). */
export const createCandidatesRepository = (db: DbClient) => ({
  // ── Candidates ──────────────────────────────────────────────────────────

  /**
   * Live candidates with this email or phone — the duplicate check. Phones
   * compare on their last 10 digits, so "+91 98765 43210" = "9876543210".
   */
  matches: (email: string | null, phone: string | null) =>
    db.query<{ id: string; name: string; email: string | null; phone: string | null }>(
      `SELECT id, name, email, phone FROM ta.candidates
        WHERE anonymised_at IS NULL
          AND (($1::text IS NOT NULL AND email = $1)
               OR ($2::text IS NOT NULL AND right(regexp_replace(phone, '[^0-9]', '', 'g'), 10)
                                         = right(regexp_replace($2, '[^0-9]', '', 'g'), 10)))
        LIMIT 5`,
      [email, phone],
    ),

  list: (q: string | null) =>
    db.query<CandidateRow>(
      `${SELECT_CANDIDATE}
        WHERE $1::text IS NULL OR c.name ILIKE '%' || $1 || '%' OR c.email ILIKE '%' || $1 || '%'
              OR c.phone ILIKE '%' || $1 || '%'
        ORDER BY c.anonymised_at IS NOT NULL, c.updated_at DESC
        LIMIT 200`,
      [q],
    ),

  findCandidate: async (id: string): Promise<CandidateRow | undefined> =>
    (await db.query<CandidateRow>(`${SELECT_CANDIDATE} WHERE c.id = $1`, [id]))[0],

  insertCandidate: (
    input: {
      name: string;
      email: string | null;
      phone: string | null;
      source: CandidateSource;
      referredBy: string | null;
      notes: string | null;
      education: string;
      experienceYears: number;
      currentCompany: string | null;
      designation: string | null;
      location: string;
      noticeDays: number;
      currentCtc: number | null;
      expectedCtc: number | null;
      availableFrom: string | null;
      retainUntil: string;
    },
    actor: ActorContext,
  ): Promise<string> =>
    db.transaction(async (tx) => {
      const row = (
        await tx.query<{ id: string }>(
          `INSERT INTO ta.candidates (name, email, phone, source, referred_by, notes,
                                      education, experience_years, current_company, designation,
                                      location, notice_days, current_ctc, expected_ctc,
                                      available_from, candidate_code,
                                      consent_at, retain_until, created_by)
           VALUES ($1, $2, $3, $4::candidate_source, $5, $6, $9, $10, $11, $12, $13, $14, $15, $16,
                   $17::date, 'C-' || lpad(nextval('ta.candidate_code_seq')::text, 6, '0'),
                   now(), $7::date, $8)
           RETURNING id`,
          [
            input.name,
            input.email,
            input.phone,
            input.source,
            input.referredBy,
            input.notes,
            input.retainUntil,
            actor.actorEmployeeId,
            input.education,
            input.experienceYears,
            input.currentCompany,
            input.designation,
            input.location,
            input.noticeDays,
            input.currentCtc,
            input.expectedCtc,
            input.availableFrom,
          ],
        )
      )[0]!;
      // No personal data in the audit trail — it outlives the 6-month retention.
      await audit(tx, actor, 'candidate.created', `candidates:${row.id}`, {
        source: input.source,
      });
      return row.id;
    }),

  saveCv: (
    candidateId: string,
    file: {
      fileName: string;
      contentType: string;
      data: Buffer;
      driveFileId?: string | null;
    },
    actor: ActorContext,
  ): Promise<void> =>
    db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO ta.candidate_cvs (candidate_id, file_name, content_type, size_bytes, data, uploaded_by, drive_file_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (candidate_id) DO UPDATE SET
           file_name = EXCLUDED.file_name, content_type = EXCLUDED.content_type,
           size_bytes = EXCLUDED.size_bytes, data = EXCLUDED.data,
           drive_file_id = EXCLUDED.drive_file_id,
           uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
        [
          candidateId,
          file.fileName,
          file.contentType,
          file.data.length,
          fileColumns(file).data,
          actor.actorEmployeeId,
          fileColumns(file).driveFileId,
        ],
      );
      await audit(tx, actor, 'candidate.cv_uploaded', `candidates:${candidateId}`, {
        bytes: file.data.length,
      });
    }),

  cv: async (candidateId: string) =>
    (
      await db.query<{
        file_name: string;
        content_type: string;
        data: Buffer | null;
        drive_file_id: string | null;
      }>(
        `SELECT file_name, content_type, data, drive_file_id FROM ta.candidate_cvs WHERE candidate_id = $1`,
        [candidateId],
      )
    )[0],

  /** Is this person an interviewer on any live application of the candidate? */
  interviewsCandidate: async (
    employeeId: string,
    candidateId: string,
  ): Promise<boolean> =>
    (
      await db.query(
        `SELECT 1 FROM ta.applications a
           JOIN ta.positions p ON p.id = a.position_id
           JOIN ta.requisition_rounds rr ON rr.requisition_id = p.requisition_id
          WHERE a.candidate_id = $1 AND ${ROUND_VISIBLE}
            AND ${INTERVIEWER_OF} = $2
          LIMIT 1`,
        [candidateId, employeeId],
      )
    ).length > 0,

  // ── Applications ────────────────────────────────────────────────────────

  applicationsBy: (by: 'candidate' | 'position' | 'id', ids: string[]) =>
    db.query<ApplicationRow>(
      `${SELECT_APPLICATION}
        WHERE ${by === 'candidate' ? 'a.candidate_id' : by === 'position' ? 'a.position_id' : 'a.id'}
              = ANY($1::uuid[])
        ORDER BY a.created_at`,
      [ids],
    ),

  /** Each application's rounds and who conducts them. */
  roundsOfApplications: (applicationIds: string[]) =>
    db.query<{
      application_id: string;
      round: InterviewRound;
      interviewer_id: string | null;
      interviewer_name: string | null;
      weight: number | null;
    }>(
      `SELECT a.id AS application_id, rr.round, ${INTERVIEWER_OF} AS interviewer_id,
              e.name AS interviewer_name,
              (SELECT (x->>'weight')::int
                 FROM ta.documents d, jsonb_array_elements(d.content->'rounds') x
                WHERE d.position_id = p.id AND d.kind = 'scorecard'
                  AND x->>'round' = rr.round::text) AS weight
         FROM ta.applications a
         JOIN ta.positions p ON p.id = a.position_id
         JOIN ta.requisition_rounds rr ON rr.requisition_id = p.requisition_id
         LEFT JOIN org.employees e ON e.id = ${INTERVIEWER_OF}
        WHERE a.id = ANY($1::uuid[])
        ORDER BY array_position(ARRAY['hr','technical','practical','managerial','hr_final']::interview_round[], rr.round)`,
      [applicationIds],
    ),

  scoresOf: (applicationIds: string[]) =>
    db.query<ScoreRow>(
      `SELECT s.application_id, s.round, s.interviewer_id, e.name AS interviewer_name,
              s.scores, s.recommendation, s.notes, s.submitted_at
         FROM ta.interview_scores s JOIN org.employees e ON e.id = s.interviewer_id
        WHERE s.application_id = ANY($1::uuid[])`,
      [applicationIds],
    ),

  positionForApplying: async (positionId: string) =>
    (
      await db.query<{
        id: string;
        status: string;
        recruiter_id: string | null;
        ta_rm_id: string | null;
        on_hold_at: Date | null;
      }>(
        `SELECT p.id, p.status::text, p.recruiter_id, q.ta_rm_id, p.on_hold_at
           FROM ta.positions p JOIN ta.requisitions q ON q.id = p.requisition_id
          WHERE p.id = $1`,
        [positionId],
      )
    )[0],

  /** Consider a candidate for a position; their 6-month clock restarts. */
  addApplication: (
    candidateId: string,
    positionId: string,
    retainUntil: string,
    actor: ActorContext,
  ): Promise<string> =>
    db.transaction(async (tx) => {
      const row = (
        await tx.query<{ id: string }>(
          `INSERT INTO ta.applications (candidate_id, position_id, created_by)
           VALUES ($1, $2, $3) RETURNING id`,
          [candidateId, positionId, actor.actorEmployeeId],
        )
      )[0]!;
      await tx.query(
        `UPDATE ta.candidates SET retain_until = greatest(retain_until, $2::date), updated_at = now()
          WHERE id = $1`,
        [candidateId, retainUntil],
      );
      await audit(tx, actor, 'application.created', `applications:${row.id}`, {
        positionId,
      });
      return row.id;
    }),

  /** Move an application on from the stage(s) it is still in. False = it moved meanwhile. */
  moveStage: (
    id: string,
    from: ApplicationStage[],
    to: ApplicationStage,
    patch: { outcomeReason?: string; rejectedBy?: string },
    actor: ActorContext,
    bells: Bell[] = [],
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      // A rejection keeps the round it happened in and who made it; the round
      // closes. Ending (reject / withdraw) remembers the stage it ended from,
      // so a restore can put the candidate back where they were.
      const moved = await tx.query(
        `UPDATE ta.applications SET stage = $3::application_stage,
            outcome_reason = coalesce($4, outcome_reason),
            rejected_round = CASE WHEN $3 = 'rejected' THEN current_round ELSE rejected_round END,
            rejected_by = CASE WHEN $3 = 'rejected' THEN $5::uuid ELSE rejected_by END,
            pre_end_stage = CASE WHEN $3 IN ('rejected', 'withdrawn') THEN stage ELSE pre_end_stage END,
            current_round = NULL,
            updated_at = now()
          WHERE id = $1 AND stage = ANY($2::application_stage[]) RETURNING id`,
        [id, from, to, patch.outcomeReason ?? null, patch.rejectedBy ?? null],
      );
      // Only once the move really happened: a lost race must not cancel slots.
      if (!moved[0]) return false;
      await tx.query(
        `UPDATE ta.interview_slots SET status = 'cancelled', end_reason = 'Candidacy ended',
                updated_at = now()
          WHERE application_id = $1 AND status = 'scheduled'`,
        [id],
      );
      await audit(tx, actor, `application.${to}`, `applications:${id}`, {
        reason: patch.outcomeReason ?? null,
      });
      await ring(tx, bells);
      return true;
    }),

  /**
   * One step back (TA correcting a move), all in one transaction:
   *   interviewing → sourced: scores deleted (copied into the audit row),
   *     live slots cancelled, the position re-settled;
   *   interviewed → interviewing: the LAST scored round reopens (its score
   *     deleted, copied into the audit row);
   *   decision / selected / offered → interviewed: the offer is returned —
   *     approval cleared, the signed letter discarded, the draft kept.
   * Returns the new stage, or false when the application moved meanwhile.
   */
  moveBack: (
    id: string,
    from: ApplicationStage,
    reason: string,
    progress: Record<PositionStatus, number>,
    actor: ActorContext,
  ): Promise<ApplicationStage | false> =>
    db.transaction(async (tx) => {
      const cur = (
        await tx.query<{ stage: ApplicationStage; position_id: string }>(
          `SELECT stage, position_id FROM ta.applications WHERE id = $1 FOR UPDATE`,
          [id],
        )
      )[0];
      if (!cur || cur.stage !== from) return false;
      let to: ApplicationStage;
      let removed: unknown[] = [];
      if (from === 'interviewing') {
        removed = await tx.query(
          `DELETE FROM ta.interview_scores WHERE application_id = $1
            RETURNING round, interviewer_id, recommendation, scores, notes`,
          [id],
        );
        await tx.query(
          `UPDATE ta.interview_slots SET status = 'cancelled', end_reason = 'Moved back',
                  updated_at = now()
            WHERE application_id = $1 AND status = 'scheduled'`,
          [id],
        );
        await tx.query(
          `UPDATE ta.applications SET stage = 'sourced', current_round = NULL,
                  interviews_started_at = NULL, updated_at = now()
            WHERE id = $1`,
          [id],
        );
        to = 'sourced';
        await settlePosition(tx, cur.position_id, progress);
      } else if (from === 'interviewed') {
        removed = await tx.query<{ round: InterviewRound }>(
          `DELETE FROM ta.interview_scores s WHERE s.application_id = $1 AND s.round = (
              SELECT round FROM ta.interview_scores WHERE application_id = $1
               ORDER BY array_position(${ROUND_ARRAY}, round) DESC LIMIT 1)
            RETURNING round, interviewer_id, recommendation, scores, notes`,
          [id],
        );
        const round =
          (removed[0] as { round?: InterviewRound } | undefined)?.round ?? null;
        await tx.query(
          `UPDATE ta.applications SET stage = 'interviewing', current_round = $2::interview_round,
                  updated_at = now()
            WHERE id = $1`,
          [id, round],
        );
        to = 'interviewing';
      } else {
        await returnOfferIn(tx, id, reason);
        to = 'interviewed';
        if (from === 'offered') await settlePosition(tx, cur.position_id, progress);
      }
      await audit(tx, actor, 'application.moved_back', `applications:${id}`, {
        from,
        to,
        reason,
        removedScores: removed,
      });
      return to;
    }),

  /**
   * Bring a rejected / withdrawn candidate back to the stage they ended from:
   * a rejected interview round reopens (a "do not hire" score for it is
   * deleted, copied into the audit row); an offer-stage one comes back as
   * interviewed with the offer returned; unknown (ended before this was
   * recorded) → sourced. The rejection record clears; the 6-month clock restarts.
   */
  restore: (
    id: string,
    reason: string,
    retainUntil: string,
    progress: Record<PositionStatus, number>,
    actor: ActorContext,
  ): Promise<ApplicationStage | false> =>
    db.transaction(async (tx) => {
      const cur = (
        await tx.query<{
          stage: ApplicationStage;
          pre_end_stage: ApplicationStage | null;
          rejected_round: InterviewRound | null;
          candidate_id: string;
          position_id: string;
        }>(
          `SELECT stage, pre_end_stage, rejected_round, candidate_id, position_id
             FROM ta.applications WHERE id = $1 FOR UPDATE`,
          [id],
        )
      )[0];
      if (!cur || (cur.stage !== 'rejected' && cur.stage !== 'withdrawn')) return false;
      const was = cur.pre_end_stage;
      let to: ApplicationStage =
        was === 'interviewing'
          ? 'interviewing'
          : was === 'interviewed' || was === 'decision' || was === 'selected'
            ? 'interviewed'
            : 'sourced';
      let removed: unknown[] = [];
      let round: InterviewRound | null = null;
      if (to === 'interviewing') {
        if (cur.rejected_round) {
          removed = await tx.query(
            `DELETE FROM ta.interview_scores
              WHERE application_id = $1 AND round = $2::interview_round
                AND recommendation = 'no_hire'
              RETURNING round, interviewer_id, recommendation, scores, notes`,
            [id, cur.rejected_round],
          );
        }
        // The first of the line's rounds still without a score reopens.
        round =
          (
            await tx.query<{ round: InterviewRound }>(
              `SELECT rr.round FROM ta.positions p
                 JOIN ta.requisition_rounds rr ON rr.requisition_id = p.requisition_id
                WHERE p.id = $1 AND NOT EXISTS (
                  SELECT 1 FROM ta.interview_scores s
                   WHERE s.application_id = $2 AND s.round = rr.round)
                ORDER BY array_position(${ROUND_ARRAY}, rr.round) LIMIT 1`,
              [cur.position_id, id],
            )
          )[0]?.round ?? null;
        if (!round) to = 'interviewed';
      }
      if (to === 'interviewed') await returnOfferIn(tx, id, reason);
      await tx.query(
        `UPDATE ta.applications SET stage = $2::application_stage,
                current_round = $3::interview_round, rejected_round = NULL, rejected_by = NULL,
                informed_at = NULL, outcome_reason = NULL, pre_end_stage = NULL, updated_at = now()
          WHERE id = $1`,
        [id, to, round],
      );
      await tx.query(
        `UPDATE ta.candidates SET retain_until = greatest(retain_until, $2::date), updated_at = now()
          WHERE id = $1`,
        [cur.candidate_id, retainUntil],
      );
      if (to !== 'sourced') await settlePosition(tx, cur.position_id, progress);
      await audit(tx, actor, 'application.restored', `applications:${id}`, {
        from: cur.stage,
        endedFrom: was,
        to,
        reason,
        removedScores: removed,
      });
      return to;
    }),

  /** Put a position on hold / take it off (TA RM or HRBP); false = already so. */
  setHold: (
    positionId: string,
    hold: { reason: string } | null,
    actor: ActorContext,
    bells: Bell[],
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = hold
        ? await tx.query(
            `UPDATE ta.positions SET on_hold_at = now(), on_hold_by = $2, on_hold_reason = $3,
                    updated_at = now()
              WHERE id = $1 AND on_hold_at IS NULL RETURNING id`,
            [positionId, actor.actorEmployeeId, hold.reason],
          )
        : await tx.query(
            `UPDATE ta.positions SET on_hold_at = NULL, on_hold_by = NULL, on_hold_reason = NULL,
                    updated_at = now()
              WHERE id = $1 AND on_hold_at IS NOT NULL RETURNING id`,
            [positionId],
          );
      if (!moved[0]) return false;
      await audit(
        tx,
        actor,
        hold ? 'position.on_hold' : 'position.resumed',
        `positions:${positionId}`,
        hold ? { reason: hold.reason } : {},
      );
      await ring(tx, bells);
      return true;
    }),

  /** A position's hold state and who may lift it (for the service's checks). */
  positionHold: async (positionId: string) =>
    (
      await db.query<{
        id: string;
        on_hold_at: Date | null;
        recruiter_id: string | null;
        ta_rm_id: string | null;
        role_title: string;
        number: number;
        department_id: string;
      }>(
        `SELECT p.id, p.on_hold_at, p.recruiter_id, q.ta_rm_id, q.role_title, p.number,
                q.department_id
           FROM ta.positions p JOIN ta.requisitions q ON q.id = p.requisition_id
          WHERE p.id = $1`,
        [positionId],
      )
    )[0],

  /**
   * Sourced → interviewing with `firstRound` open (the screening). The first
   * candidate in interviews moves the position to `interviewing` and its
   * hiring goal to that stage's progress.
   */
  startInterviews: (
    id: string,
    firstRound: InterviewRound,
    progress: number,
    actor: ActorContext,
    bells: Bell[],
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query<{ position_id: string }>(
        `UPDATE ta.applications SET stage = 'interviewing', interviews_started_at = now(),
            current_round = $2::interview_round, updated_at = now()
          WHERE id = $1 AND stage IN ('sourced', 'shortlisted') RETURNING position_id`,
        [id, firstRound],
      );
      if (!moved[0]) return false;
      const pos = await tx.query<{ id: string }>(
        `UPDATE ta.positions SET status = 'interviewing', updated_at = now()
          WHERE id = $1 AND status = 'open' RETURNING id`,
        [moved[0].position_id],
      );
      if (pos[0]) {
        await tx.query(
          `UPDATE org.goals g SET progress = greatest(g.progress, $2), updated_at = now()
             FROM org.review_cycles c
            WHERE c.id = g.cycle_id AND c.closed_at IS NULL AND g.position_id = $1`,
          [pos[0].id, progress],
        );
      }
      await audit(tx, actor, 'application.interviewing', `applications:${id}`);
      await ring(tx, bells);
      return true;
    }),

  /** TA swaps a round's interviewer on the line (the head is told). */
  swapInterviewer: (
    requisitionId: string,
    round: InterviewRound,
    interviewerId: string,
    actor: ActorContext,
    bells: Bell[],
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query(
        `UPDATE ta.requisition_rounds SET interviewer_id = $3
          WHERE requisition_id = $1 AND round = $2::interview_round RETURNING id`,
        [requisitionId, round, interviewerId],
      );
      if (!moved[0]) return false;
      await audit(
        tx,
        actor,
        'requisition.interviewer_swapped',
        `requisitions:${requisitionId}`,
        {
          round,
          interviewerId,
        },
      );
      await ring(tx, bells);
      return true;
    }),

  // ── Interview scores ────────────────────────────────────────────────────

  /** Who conducts this round of this application (null = nobody named yet). */
  interviewerOf: async (applicationId: string, round: InterviewRound) =>
    (
      await db.query<{ interviewer_id: string | null }>(
        `SELECT ${INTERVIEWER_OF} AS interviewer_id
           FROM ta.applications a
           JOIN ta.positions p ON p.id = a.position_id
           JOIN ta.requisition_rounds rr ON rr.requisition_id = p.requisition_id
          WHERE a.id = $1 AND rr.round = $2::interview_round`,
        [applicationId, round],
      )
    )[0],

  /** Record that the candidate was told the outcome (the rejection record). */
  markInformed: (id: string, actor: ActorContext): Promise<boolean> =>
    db.transaction(async (tx) => {
      const rows = await tx.query(
        `UPDATE ta.applications SET informed_at = now(), updated_at = now()
          WHERE id = $1 AND stage IN ('rejected', 'withdrawn') AND informed_at IS NULL
          RETURNING id`,
        [id],
      );
      if (!rows[0]) return false;
      await audit(tx, actor, 'application.informed', `applications:${id}`);
      return true;
    }),

  /** Fill or correct a candidate's profile; only the given fields change. Audited. */
  updateCandidate: (
    id: string,
    patch: Record<string, unknown>,
    actor: ActorContext,
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const cols: Record<string, string> = {
        name: 'name',
        education: 'education',
        experienceYears: 'experience_years',
        currentCompany: 'current_company',
        designation: 'designation',
        location: 'location',
        noticeDays: 'notice_days',
        currentCtc: 'current_ctc',
        expectedCtc: 'expected_ctc',
        availableFrom: 'available_from',
      };
      const keys = Object.keys(patch).filter((k) => k in cols && patch[k] !== undefined);
      if (keys.length === 0) return true;
      const sets = keys.map((k, i) => `${cols[k]} = $${i + 2}`).join(', ');
      const rows = await tx.query(
        `UPDATE ta.candidates SET ${sets}, updated_at = now()
          WHERE id = $1 AND anonymised_at IS NULL RETURNING id`,
        [id, ...keys.map((k) => patch[k])],
      );
      if (!rows[0]) return false;
      // Field names only — no personal data in the audit trail.
      await audit(tx, actor, 'candidate.updated', `candidates:${id}`, { fields: keys });
      return true;
    }),

  /** Set (or clear) what happens next on an application. */
  setNextAction: (
    id: string,
    input: { nextAction: string | null; ownerId: string | null; due: string | null },
    actor: ActorContext,
  ): Promise<void> =>
    db.transaction(async (tx) => {
      await tx.query(
        `UPDATE ta.applications SET next_action = $2, next_action_owner_id = $3,
                next_action_due = $4::date, updated_at = now()
          WHERE id = $1`,
        [id, input.nextAction, input.ownerId, input.due],
      );
      await audit(tx, actor, 'application.next_action', `applications:${id}`, {
        due: input.due,
      });
    }),

  activitiesOf: (applicationId: string) =>
    db.query<{
      id: string;
      kind: 'call' | 'email' | 'whatsapp' | 'meeting';
      outcome: 'connected' | 'no_answer' | 'busy' | 'wrong_number' | 'other';
      notes: string | null;
      happened_at: Date;
      by_name: string;
    }>(
      `SELECT x.id, x.kind, x.outcome, x.notes, x.happened_at, e.name AS by_name
         FROM ta.activities x JOIN org.employees e ON e.id = x.created_by
        WHERE x.application_id = $1
        ORDER BY x.happened_at DESC`,
      [applicationId],
    ),

  logActivity: (
    input: {
      applicationId: string;
      kind: string;
      outcome: string;
      notes: string | null;
      happenedAt: string | null;
    },
    actor: ActorContext,
  ): Promise<void> =>
    db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO ta.activities (application_id, kind, outcome, notes, happened_at, created_by)
         VALUES ($1, $2::ta_activity_kind, $3::ta_activity_outcome, $4,
                 coalesce($5::timestamptz, now()), $6)`,
        [
          input.applicationId,
          input.kind,
          input.outcome,
          input.notes,
          input.happenedAt,
          actor.actorEmployeeId,
        ],
      );
      await tx.query(`UPDATE ta.applications SET updated_at = now() WHERE id = $1`, [
        input.applicationId,
      ]);
    }),

  /** Each round's current slot — the live one, else the done one, else the latest (history stays). */
  slotsOf: (applicationIds: string[]) =>
    db.query<SlotRow>(
      `SELECT DISTINCT ON (s.application_id, s.round)
              s.id, s.application_id, s.round, s.interviewer_id, s.starts_at, s.duration_min,
              s.mode, s.location, s.status, s.end_reason
         FROM ta.interview_slots s
        WHERE s.application_id = ANY($1::uuid[])
        ORDER BY s.application_id, s.round,
                 (s.status = 'scheduled') DESC, (s.status = 'done') DESC, s.created_at DESC`,
      [applicationIds],
    ),

  /**
   * Schedule a round, or move its live slot. Only while the candidate is in
   * interviews and the round isn't scored. One transaction, audited; the
   * interviewer is told.
   */
  scheduleSlot: (
    input: {
      applicationId: string;
      round: InterviewRound;
      interviewerId: string;
      startsAt: string;
      durationMin: number;
      mode: 'in_person' | 'video' | 'phone';
      location: string | null;
    },
    actor: ActorContext,
    bells: Bell[],
  ): Promise<'not_interviewing' | 'scored' | 'scheduled' | 'moved'> =>
    db.transaction(async (tx) => {
      const app = (
        await tx.query<{ stage: string }>(
          `SELECT stage FROM ta.applications WHERE id = $1 FOR UPDATE`,
          [input.applicationId],
        )
      )[0];
      if (!app || app.stage !== 'interviewing') return 'not_interviewing';
      const scored = await tx.query(
        `SELECT 1 FROM ta.interview_scores WHERE application_id = $1 AND round = $2::interview_round`,
        [input.applicationId, input.round],
      );
      if (scored.length) return 'scored';
      const moved = await tx.query<{ id: string }>(
        `UPDATE ta.interview_slots
            SET starts_at = $3, duration_min = $4, mode = $5::interview_mode, location = $6,
                interviewer_id = $7, scheduled_by = $8, updated_at = now()
          WHERE application_id = $1 AND round = $2::interview_round AND status = 'scheduled'
          RETURNING id`,
        [
          input.applicationId,
          input.round,
          input.startsAt,
          input.durationMin,
          input.mode,
          input.location,
          input.interviewerId,
          actor.actorEmployeeId,
        ],
      );
      if (!moved[0]) {
        await tx.query(
          `INSERT INTO ta.interview_slots (application_id, round, interviewer_id, starts_at,
                                           duration_min, mode, location, scheduled_by)
           VALUES ($1, $2::interview_round, $7, $3, $4, $5::interview_mode, $6, $8)`,
          [
            input.applicationId,
            input.round,
            input.startsAt,
            input.durationMin,
            input.mode,
            input.location,
            input.interviewerId,
            actor.actorEmployeeId,
          ],
        );
      }
      await audit(
        tx,
        actor,
        moved[0] ? 'application.round_rescheduled' : 'application.round_scheduled',
        `applications:${input.applicationId}`,
        { round: input.round, startsAt: input.startsAt, mode: input.mode },
      );
      await ring(tx, bells);
      return moved[0] ? 'moved' : 'scheduled';
    }),

  /** Call off a round's live slot: cancelled, or the candidate did not show. */
  endSlot: (
    applicationId: string,
    round: InterviewRound,
    status: 'cancelled' | 'no_show',
    reason: string,
    actor: ActorContext,
    bells: Bell[],
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const rows = await tx.query<{ id: string }>(
        `UPDATE ta.interview_slots SET status = $3::interview_slot_status, end_reason = $4,
                updated_at = now()
          WHERE application_id = $1 AND round = $2::interview_round AND status = 'scheduled'
          RETURNING id`,
        [applicationId, round, status, reason],
      );
      if (!rows[0]) return false;
      await audit(
        tx,
        actor,
        `application.round_${status}`,
        `applications:${applicationId}`,
        {
          round,
          reason,
        },
      );
      await ring(tx, bells);
      return true;
    }),

  /** The attributes of one round's sheet on the application's position scorecard. */
  attributesFor: async (
    applicationId: string,
    round: InterviewRound,
  ): Promise<string[]> =>
    (
      await db.query<{ name: string }>(
        `SELECT y->>'name' AS name
           FROM ta.applications a
           JOIN ta.positions p ON p.id = a.position_id
           JOIN ta.documents d ON d.position_id = p.id AND d.kind = 'scorecard'
           CROSS JOIN LATERAL jsonb_array_elements(d.content->'rounds') x
           CROSS JOIN LATERAL jsonb_array_elements(x->'attributes') y
          WHERE a.id = $1 AND x->>'round' = $2`,
        [applicationId, round],
      )
    ).map((r) => r.name),

  /**
   * Write one round's scores — final, never updated. When every round of the
   * line is scored the application becomes `interviewed`. The application row
   * is locked so two last rounds can't both miss the finish.
   */
  insertScore: (
    input: {
      applicationId: string;
      round: InterviewRound;
      interviewerId: string;
      scores: Array<{ attribute: string; score: number; evidence: string | null }>;
      recommendation: 'hire' | 'no_hire';
      notes: string | null;
    },
    actor: ActorContext,
    bellsFor: (
      outcome: 'rejected' | 'next_round' | 'all_scored',
      next: { round: InterviewRound; interviewerId: string | null } | null,
    ) => Bell[],
  ): Promise<
    | 'not_interviewing'
    | 'not_open'
    | 'already_scored'
    | 'rejected'
    | 'next_round'
    | 'all_scored'
  > =>
    db.transaction(async (tx) => {
      const app = (
        await tx.query<{ stage: string; current_round: InterviewRound | null }>(
          `SELECT stage, current_round FROM ta.applications WHERE id = $1 FOR UPDATE`,
          [input.applicationId],
        )
      )[0];
      if (!app || app.stage !== 'interviewing') return 'not_interviewing';
      if (app.current_round !== input.round) return 'not_open';
      const ins = await tx.query(
        `INSERT INTO ta.interview_scores (application_id, round, interviewer_id, scores, recommendation, notes)
         VALUES ($1, $2::interview_round, $3, $4::jsonb, $5::interview_recommendation, $6)
         ON CONFLICT (application_id, round) DO NOTHING RETURNING id`,
        [
          input.applicationId,
          input.round,
          input.interviewerId,
          JSON.stringify(input.scores),
          input.recommendation,
          input.notes,
        ],
      );
      if (!ins[0]) return 'already_scored';
      await tx.query(
        `UPDATE ta.interview_slots SET status = 'done', updated_at = now()
          WHERE application_id = $1 AND round = $2::interview_round AND status = 'scheduled'`,
        [input.applicationId, input.round],
      );
      await audit(
        tx,
        actor,
        'application.round_scored',
        `applications:${input.applicationId}`,
        {
          round: input.round,
          recommendation: input.recommendation,
        },
      );
      // "Do not hire" ends it at once: rejected in this round, by this interviewer.
      if (input.recommendation === 'no_hire') {
        await tx.query(
          `UPDATE ta.applications SET stage = 'rejected', outcome_reason = $2,
                  rejected_round = $3::interview_round, rejected_by = $4, current_round = NULL,
                  pre_end_stage = stage, updated_at = now()
            WHERE id = $1`,
          [input.applicationId, input.notes, input.round, input.interviewerId],
        );
        await audit(
          tx,
          actor,
          'application.rejected',
          `applications:${input.applicationId}`,
          {
            round: input.round,
            reason: input.notes,
          },
        );
        await ring(tx, bellsFor('rejected', null));
        return 'rejected';
      }
      // A pass opens the next round of the line, in order.
      const next = (
        await tx.query<{ round: InterviewRound; interviewer_id: string | null }>(
          `SELECT rr.round, ${INTERVIEWER_OF} AS interviewer_id
             FROM ta.applications a
             JOIN ta.positions p ON p.id = a.position_id
             JOIN ta.requisition_rounds rr ON rr.requisition_id = p.requisition_id
            WHERE a.id = $1 AND NOT EXISTS (
              SELECT 1 FROM ta.interview_scores s
               WHERE s.application_id = a.id AND s.round = rr.round)
            ORDER BY array_position(ARRAY['hr','technical','practical','managerial','hr_final']::interview_round[], rr.round)
            LIMIT 1`,
          [input.applicationId],
        )
      )[0];
      if (next) {
        await tx.query(
          `UPDATE ta.applications SET current_round = $2::interview_round, updated_at = now()
            WHERE id = $1`,
          [input.applicationId, next.round],
        );
        await ring(
          tx,
          bellsFor('next_round', {
            round: next.round,
            interviewerId: next.interviewer_id,
          }),
        );
        return 'next_round';
      }
      await tx.query(
        `UPDATE ta.applications SET stage = 'interviewed', current_round = NULL, updated_at = now()
          WHERE id = $1`,
        [input.applicationId],
      );
      // Every round passed: TA asks for the documents (workflow deck step 13).
      await tx.query(
        `INSERT INTO ta.application_documents (application_id, name)
         SELECT $1, unnest($2::text[]) ON CONFLICT (application_id, name) DO NOTHING`,
        [input.applicationId, [...DEFAULT_CANDIDATE_DOCUMENTS]],
      );
      await ring(tx, bellsFor('all_scored', null));
      return 'all_scored';
    }),

  /** Rounds I conduct on live applications, with the round's scorecard and my score. */
  myInterviews: (employeeId: string) =>
    db.query<{
      application_id: string;
      candidate_id: string;
      candidate_name: string;
      has_cv: boolean;
      role_title: string;
      department_name: string;
      round: InterviewRound;
      round_weight: number | null;
      attributes: Array<{ name: string; questions: string[] }> | null;
      education: string | null;
      experience_years: string | null;
      jd_summary: string | null;
    }>(
      `SELECT a.id AS application_id, c.id AS candidate_id, c.name AS candidate_name,
              EXISTS (SELECT 1 FROM ta.candidate_cvs v WHERE v.candidate_id = c.id) AS has_cv,
              q.role_title, d.name AS department_name, rr.round,
              (SELECT (x->>'weight')::int
                 FROM ta.documents sc, jsonb_array_elements(sc.content->'rounds') x
                WHERE sc.position_id = p.id AND sc.kind = 'scorecard'
                  AND x->>'round' = rr.round::text) AS round_weight,
              (SELECT x->'attributes'
                 FROM ta.documents sc, jsonb_array_elements(sc.content->'rounds') x
                WHERE sc.position_id = p.id AND sc.kind = 'scorecard'
                  AND x->>'round' = rr.round::text) AS attributes,
              c.education, c.experience_years,
              (SELECT jd.content->>'roleSummary' FROM ta.documents jd
                WHERE jd.position_id = p.id AND jd.kind = 'jd') AS jd_summary
         FROM ta.applications a
         JOIN ta.candidates c ON c.id = a.candidate_id
         JOIN ta.positions p ON p.id = a.position_id
         JOIN ta.requisitions q ON q.id = p.requisition_id
         JOIN org.departments d ON d.id = q.department_id
         JOIN ta.requisition_rounds rr ON rr.requisition_id = q.id
        WHERE ${ROUND_VISIBLE} AND ${INTERVIEWER_OF} = $1
        ORDER BY a.interviews_started_at DESC`,
      [employeeId],
    ),
});

export type CandidatesRepository = ReturnType<typeof createCandidatesRepository>;
