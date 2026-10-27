import type { DbClient } from '../../db/client.js';

/** The period bounds as India-local days (inclusive). */
const IN_PERIOD = (col: string) =>
  `(${col} AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date`;

/** DB reads for the TA tracker report and the hiring trackers (workflow deck slides 13–16). */
export const createReportsRepository = (db: DbClient) => ({
  /** One row per position on an approved line, counted over the period. */
  report: (from: string, to: string, today: string) =>
    db.query<{
      position_id: string;
      request_code: string | null;
      role_title: string;
      position_number: number;
      department_name: string;
      spoc_name: string | null;
      sourced: number;
      call_attempts: number;
      call_unique: number;
      screened: number;
      aligned: number;
      held: number;
      offers_shared: number;
      accepted: number;
      joined: number;
      rejected: number;
      withdrawn: number;
      overdue: number;
    }>(
      `SELECT p.id AS position_id, q.request_code, q.role_title, p.number AS position_number,
              d.name AS department_name, s.name AS spoc_name,
              (SELECT count(*)::int FROM ta.applications a
                WHERE a.position_id = p.id AND ${IN_PERIOD('a.created_at')}) AS sourced,
              (SELECT count(*)::int FROM ta.activities x JOIN ta.applications a ON a.id = x.application_id
                WHERE a.position_id = p.id AND x.kind = 'call' AND ${IN_PERIOD('x.happened_at')}) AS call_attempts,
              (SELECT count(DISTINCT a.candidate_id)::int FROM ta.activities x
                 JOIN ta.applications a ON a.id = x.application_id
                WHERE a.position_id = p.id AND x.kind = 'call' AND ${IN_PERIOD('x.happened_at')}) AS call_unique,
              (SELECT count(*)::int FROM ta.interview_scores sc JOIN ta.applications a ON a.id = sc.application_id
                WHERE a.position_id = p.id AND sc.round = 'hr' AND ${IN_PERIOD('sc.submitted_at')}) AS screened,
              (SELECT count(*)::int FROM ta.interview_slots sl JOIN ta.applications a ON a.id = sl.application_id
                WHERE a.position_id = p.id AND ${IN_PERIOD('sl.created_at')}) AS aligned,
              (SELECT count(*)::int FROM ta.interview_slots sl JOIN ta.applications a ON a.id = sl.application_id
                WHERE a.position_id = p.id AND sl.status = 'done' AND ${IN_PERIOD('sl.starts_at')}) AS held,
              (SELECT count(*)::int FROM ta.applications a
                WHERE a.position_id = p.id AND a.offered_at IS NOT NULL AND ${IN_PERIOD('a.offered_at')}) AS offers_shared,
              (SELECT count(*)::int FROM ta.applications a
                WHERE a.position_id = p.id AND a.hired_at IS NOT NULL AND ${IN_PERIOD('a.hired_at')}) AS accepted,
              (SELECT count(*)::int FROM ta.applications a
                WHERE a.position_id = p.id AND a.joined_at IS NOT NULL AND ${IN_PERIOD('a.joined_at')}) AS joined,
              (SELECT count(*)::int FROM ta.applications a
                WHERE a.position_id = p.id AND a.stage = 'rejected' AND ${IN_PERIOD('a.updated_at')}) AS rejected,
              (SELECT count(*)::int FROM ta.applications a
                WHERE a.position_id = p.id AND a.stage = 'withdrawn' AND ${IN_PERIOD('a.updated_at')}) AS withdrawn,
              (SELECT count(*)::int FROM ta.applications a
                WHERE a.position_id = p.id AND a.next_action IS NOT NULL
                  AND a.next_action_due < $3::date) AS overdue
         FROM ta.positions p
         JOIN ta.requisitions q ON q.id = p.requisition_id
         JOIN org.departments d ON d.id = q.department_id
         LEFT JOIN org.employees s ON s.id = p.recruiter_id
        WHERE q.status = 'approved' AND p.status <> 'cancelled'
        ORDER BY d.name, q.role_title, p.number`,
      [from, to, today],
    ),

  /** Every open next action, earliest due first (no due date last). */
  pendingActions: (today: string) =>
    db.query<{
      application_id: string;
      candidate_name: string;
      candidate_code: string | null;
      role_title: string;
      position_number: number;
      stage: string;
      next_action: string;
      owner_name: string | null;
      due: string | null;
      overdue: boolean;
    }>(
      `SELECT a.id AS application_id, c.name AS candidate_name, c.candidate_code, q.role_title,
              p.number AS position_number, a.stage::text, a.next_action, o.name AS owner_name,
              a.next_action_due::text AS due,
              coalesce(a.next_action_due < $1::date, false) AS overdue
         FROM ta.applications a
         JOIN ta.candidates c ON c.id = a.candidate_id
         JOIN ta.positions p ON p.id = a.position_id
         JOIN ta.requisitions q ON q.id = p.requisition_id
         LEFT JOIN org.employees o ON o.id = a.next_action_owner_id
        WHERE a.next_action IS NOT NULL
        ORDER BY a.next_action_due NULLS LAST, c.name`,
      [today],
    ),

  /** Candidates on positions — every department, or only the given ones (dept heads). */
  tracker: (departmentIds: string[] | null) =>
    db.query<{
      application_id: string;
      request_code: string | null;
      candidate_code: string | null;
      candidate_name: string;
      role_title: string;
      position_number: number;
      department_name: string;
      spoc_name: string | null;
      source: string;
      stage: string;
      current_round: string | null;
      experience_years: string | null;
      location: string | null;
      notice_days: number | null;
      joining_date: string | null;
      created_at: Date;
      email: string | null;
      phone: string | null;
      current_ctc: string | null;
      expected_ctc: string | null;
      offered_ctc: string | null;
    }>(
      `SELECT a.id AS application_id, q.request_code, c.candidate_code, c.name AS candidate_name,
              q.role_title, p.number AS position_number, d.name AS department_name,
              s.name AS spoc_name, c.source::text, a.stage::text, a.current_round::text,
              c.experience_years::text, c.location, c.notice_days, a.joining_date::text,
              a.created_at, c.email, c.phone, c.current_ctc::text, c.expected_ctc::text,
              a.offered_ctc::text
         FROM ta.applications a
         JOIN ta.candidates c ON c.id = a.candidate_id
         JOIN ta.positions p ON p.id = a.position_id
         JOIN ta.requisitions q ON q.id = p.requisition_id
         JOIN org.departments d ON d.id = q.department_id
         LEFT JOIN org.employees s ON s.id = p.recruiter_id
        WHERE c.anonymised_at IS NULL
          AND ($1::uuid[] IS NULL OR q.department_id = ANY($1::uuid[]))
        ORDER BY d.name, q.role_title, p.number, a.created_at`,
      [departmentIds],
    ),

  /** Round scores per application, for the tracker's total (weights from the position scorecard). */
  scoreTotals: (applicationIds: string[]) =>
    db.query<{ application_id: string; total: number | null }>(
      `SELECT a.id AS application_id,
              round(sum((
                SELECT avg((y->>'score')::numeric) / 4 * 100
                  FROM jsonb_array_elements(sc.scores) y
              ) * (r->>'weight')::numeric / 100), 1)::float8 AS total
         FROM ta.applications a
         JOIN ta.interview_scores sc ON sc.application_id = a.id
         JOIN ta.documents d ON d.position_id = a.position_id AND d.kind = 'scorecard'
         CROSS JOIN LATERAL jsonb_array_elements(d.content->'rounds') r
        WHERE a.id = ANY($1::uuid[]) AND r->>'round' = sc.round::text
        GROUP BY a.id`,
      [applicationIds],
    ),
});

export type ReportsRepository = ReturnType<typeof createReportsRepository>;
