import type { DbClient } from '../../db/client.js';
import { auditLog } from '../../db/schema/index.js';
import { insertNotifications } from '../notifications/index.js';
import type { ActorContext, Bell } from './hiring.repository.js';
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
  has_cv: boolean;
  retain_until: string;
  anonymised_at: Date | null;
  created_at: Date;
}

export interface ApplicationRow {
  id: string;
  candidate_id: string;
  candidate_name: string;
  position_id: string;
  position_number: number;
  position_status: string;
  recruiter_id: string | null;
  requisition_id: string;
  /** The line's TA RM (Admin gave them the line). */
  ta_rm_id: string | null;
  role_title: string;
  department_id: string;
  department_name: string;
  stage: ApplicationStage;
  shortlisted_by_name: string | null;
  outcome_reason: string | null;
  created_at: Date;
  // Step E
  requisition_status: string;
  budget_min: string | null;
  budget_max: string | null;
  urgent: boolean;
  offered_ctc: string | null;
  joining_date: string | null;
  has_offer_letter: boolean;
  bgv_status: 'not_started' | 'in_progress' | 'clear' | 'failed';
  bgv_notes: string | null;
  employee_id: string | null;
}

export interface ScoreRow {
  application_id: string;
  round: InterviewRound;
  interviewer_id: string;
  interviewer_name: string;
  scores: Array<{ criterion: string; score: number }>;
  recommendation: 'hire' | 'no_hire';
  notes: string | null;
  submitted_at: Date;
}

const SELECT_CANDIDATE = `
  SELECT c.id, c.name, c.email, c.phone, c.source, r.name AS referred_by_name, c.notes,
         EXISTS (SELECT 1 FROM ta.candidate_cvs v WHERE v.candidate_id = c.id) AS has_cv,
         c.retain_until::text, c.anonymised_at, c.created_at
    FROM ta.candidates c LEFT JOIN org.employees r ON r.id = c.referred_by`;

const SELECT_APPLICATION = `
  SELECT a.id, a.candidate_id, c.name AS candidate_name, a.position_id,
         p.number AS position_number, p.status::text AS position_status, p.recruiter_id,
         p.requisition_id, q.ta_rm_id, q.role_title, q.department_id, d.name AS department_name,
         a.stage, s.name AS shortlisted_by_name, a.outcome_reason, a.created_at,
         q.status::text AS requisition_status, q.urgent, a.offered_ctc::text,
         q.budget_min::text, q.budget_max::text,
         a.joining_date::text,
         EXISTS (SELECT 1 FROM ta.offer_letters o WHERE o.application_id = a.id) AS has_offer_letter,
         a.bgv_status, a.bgv_notes, a.employee_id
    FROM ta.applications a
    JOIN ta.candidates c ON c.id = a.candidate_id
    JOIN ta.positions p ON p.id = a.position_id
    JOIN ta.requisitions q ON q.id = p.requisition_id
    JOIN org.departments d ON d.id = q.department_id
    LEFT JOIN org.employees s ON s.id = a.shortlisted_by`;

/**
 * Who conducts a round of an application: the interviewer the head named on
 * the line — or, for the HR rounds left blank, the position's recruiter.
 */
const INTERVIEWER_OF = `coalesce(rr.interviewer_id,
  CASE WHEN rr.round IN ('hr', 'hr_final') THEN p.recruiter_id END)`;

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
  for (const b of bells) await insertNotifications(tx, b.to, b.event);
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
      retainUntil: string;
    },
    actor: ActorContext,
  ): Promise<string> =>
    db.transaction(async (tx) => {
      const row = (
        await tx.query<{ id: string }>(
          `INSERT INTO ta.candidates (name, email, phone, source, referred_by, notes,
                                      consent_at, retain_until, created_by)
           VALUES ($1, $2, $3, $4::candidate_source, $5, $6, now(), $7::date, $8)
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
    file: { fileName: string; contentType: string; data: Buffer },
    actor: ActorContext,
  ): Promise<void> =>
    db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO ta.candidate_cvs (candidate_id, file_name, content_type, size_bytes, data, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (candidate_id) DO UPDATE SET
           file_name = EXCLUDED.file_name, content_type = EXCLUDED.content_type,
           size_bytes = EXCLUDED.size_bytes, data = EXCLUDED.data,
           uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
        [
          candidateId,
          file.fileName,
          file.contentType,
          file.data.length,
          file.data,
          actor.actorEmployeeId,
        ],
      );
      await audit(tx, actor, 'candidate.cv_uploaded', `candidates:${candidateId}`, {
        bytes: file.data.length,
      });
    }),

  cv: async (candidateId: string) =>
    (
      await db.query<{ file_name: string; content_type: string; data: Buffer }>(
        `SELECT file_name, content_type, data FROM ta.candidate_cvs WHERE candidate_id = $1`,
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
          WHERE a.candidate_id = $1 AND a.stage IN ('interviewing', 'interviewed')
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
    }>(
      `SELECT a.id AS application_id, rr.round, ${INTERVIEWER_OF} AS interviewer_id,
              e.name AS interviewer_name
         FROM ta.applications a
         JOIN ta.positions p ON p.id = a.position_id
         JOIN ta.requisition_rounds rr ON rr.requisition_id = p.requisition_id
         LEFT JOIN org.employees e ON e.id = ${INTERVIEWER_OF}
        WHERE a.id = ANY($1::uuid[])
        ORDER BY array_position(ARRAY['hr','technical','practical','managerial','hr_final']::interview_round[], rr.round)`,
      [applicationIds],
    ),

  /** Final hire decisions (subject `hire`, version 1) on these applications. */
  hireDecisionsOf: (applicationIds: string[]) =>
    db.query<{
      subject_id: string;
      role: 'dept_head' | 'ta_head' | 'ta_rm' | 'hr_head' | 'admin';
      decision: 'approve' | 'reject';
      decided_by_name: string;
      reason: string | null;
    }>(
      `SELECT a.subject_id, a.role, a.decision, e.name AS decided_by_name, a.reason
         FROM ta.approvals a JOIN org.employees e ON e.id = a.decided_by
        WHERE a.subject_kind = 'hire' AND a.subject_id = ANY($1::uuid[])
        ORDER BY a.decided_at`,
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
      await db.query<{ id: string; status: string }>(
        `SELECT id, status::text FROM ta.positions WHERE id = $1`,
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
    patch: { shortlistedBy?: string; outcomeReason?: string },
    actor: ActorContext,
    bells: Bell[] = [],
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query(
        `UPDATE ta.applications SET stage = $3::application_stage,
            shortlisted_by = coalesce($4, shortlisted_by),
            shortlisted_at = CASE WHEN $4::uuid IS NOT NULL THEN now() ELSE shortlisted_at END,
            outcome_reason = coalesce($5, outcome_reason),
            updated_at = now()
          WHERE id = $1 AND stage = ANY($2::application_stage[]) RETURNING id`,
        [id, from, to, patch.shortlistedBy ?? null, patch.outcomeReason ?? null],
      );
      if (!moved[0]) return false;
      await audit(tx, actor, `application.${to}`, `applications:${id}`, {
        reason: patch.outcomeReason ?? null,
      });
      await ring(tx, bells);
      return true;
    }),

  /**
   * Shortlisted → interviewing. The first candidate in interviews moves the
   * position to `interviewing` and its hiring goal to that stage's progress.
   */
  startInterviews: (
    id: string,
    progress: number,
    actor: ActorContext,
    bells: Bell[],
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query<{ position_id: string }>(
        `UPDATE ta.applications SET stage = 'interviewing', interviews_started_at = now(),
            updated_at = now()
          WHERE id = $1 AND stage = 'shortlisted' RETURNING position_id`,
        [id],
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

  /** The scorecard's criteria for one round of the application's line. */
  criteriaFor: async (applicationId: string, round: InterviewRound): Promise<string[]> =>
    (
      await db.query<{ criterion: string }>(
        `SELECT x->>'criterion' AS criterion
           FROM ta.applications a
           JOIN ta.positions p ON p.id = a.position_id
           JOIN ta.documents d ON d.requisition_id = p.requisition_id AND d.kind = 'scorecard'
           CROSS JOIN LATERAL jsonb_array_elements(d.content->'criteria') x
          WHERE a.id = $1 AND x->>'round' = $2`,
        [applicationId, round],
      )
    ).map((r) => r.criterion),

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
      scores: Array<{ criterion: string; score: number }>;
      recommendation: 'hire' | 'no_hire';
      notes: string | null;
    },
    actor: ActorContext,
    bellsIfDone: Bell[],
  ): Promise<'not_interviewing' | 'already_scored' | 'scored' | 'all_scored'> =>
    db.transaction(async (tx) => {
      const app = (
        await tx.query<{ stage: string }>(
          `SELECT stage FROM ta.applications WHERE id = $1 FOR UPDATE`,
          [input.applicationId],
        )
      )[0];
      if (!app || app.stage !== 'interviewing') return 'not_interviewing';
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
      const left = (
        await tx.query<{ n: number }>(
          `SELECT count(*)::int AS n
             FROM ta.applications a
             JOIN ta.positions p ON p.id = a.position_id
             JOIN ta.requisition_rounds rr ON rr.requisition_id = p.requisition_id
            WHERE a.id = $1 AND NOT EXISTS (
              SELECT 1 FROM ta.interview_scores s
               WHERE s.application_id = a.id AND s.round = rr.round)`,
          [input.applicationId],
        )
      )[0]!.n;
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
      if (left > 0) return 'scored';
      await tx.query(
        `UPDATE ta.applications SET stage = 'interviewed', updated_at = now() WHERE id = $1`,
        [input.applicationId],
      );
      await ring(tx, bellsIfDone);
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
      criteria: Array<{ criterion: string; guidance: string | null }> | null;
      jd_summary: string | null;
    }>(
      `SELECT a.id AS application_id, c.id AS candidate_id, c.name AS candidate_name,
              EXISTS (SELECT 1 FROM ta.candidate_cvs v WHERE v.candidate_id = c.id) AS has_cv,
              q.role_title, d.name AS department_name, rr.round,
              (SELECT jsonb_agg(jsonb_build_object('criterion', x->>'criterion',
                                                   'guidance', x->>'guidance'))
                 FROM ta.documents sc, jsonb_array_elements(sc.content->'criteria') x
                WHERE sc.requisition_id = q.id AND sc.kind = 'scorecard'
                  AND x->>'round' = rr.round::text) AS criteria,
              (SELECT jd.content->>'summary' FROM ta.documents jd
                WHERE jd.requisition_id = q.id AND jd.kind = 'jd') AS jd_summary
         FROM ta.applications a
         JOIN ta.candidates c ON c.id = a.candidate_id
         JOIN ta.positions p ON p.id = a.position_id
         JOIN ta.requisitions q ON q.id = p.requisition_id
         JOIN org.departments d ON d.id = q.department_id
         JOIN ta.requisition_rounds rr ON rr.requisition_id = q.id
        WHERE a.stage IN ('interviewing', 'interviewed') AND ${INTERVIEWER_OF} = $1
        ORDER BY a.interviews_started_at DESC`,
      [employeeId],
    ),
});

export type CandidatesRepository = ReturnType<typeof createCandidatesRepository>;
