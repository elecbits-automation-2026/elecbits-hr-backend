import type { DbClient } from '../../db/client.js';
import { auditLog } from '../../db/schema/index.js';
import { insertNotifications } from '../notifications/index.js';
import type { ActorContext, Bell, PositionStatus } from './hiring.repository.js';
import type { CandidateDocStatus } from './hire.schema.js';

const audit = (
  tx: DbClient,
  actor: ActorContext,
  action: string,
  applicationId: string,
  detail?: Record<string, unknown>,
) =>
  tx.orm.insert(auditLog).values({
    actorUserId: actor.actorUserId,
    action,
    subject: `applications:${applicationId}`,
    detail: detail ? JSON.stringify(detail) : null,
  });

const ring = async (tx: DbClient, bells: Bell[] = []) => {
  for (const b of bells) await insertNotifications(tx, b.to, b.event);
};

/** Stages in which a candidate still holds a position's attention. */
const LIVE_ON_POSITION = `('interviewing', 'interviewed', 'decision', 'selected', 'offered')`;

/**
 * After an offer falls through (declined, withdrawn, didn't join) the
 * position goes back to `interviewing` if anyone is still in play, else
 * `open` — and its hiring goal follows (set, not raised).
 */
const reopenPosition = async (
  tx: DbClient,
  positionId: string,
  progress: Record<PositionStatus, number>,
) => {
  const row = (
    await tx.query<{ status: PositionStatus }>(
      `UPDATE ta.positions p SET
          status = CASE WHEN EXISTS (SELECT 1 FROM ta.applications a
                                      WHERE a.position_id = p.id AND a.stage IN ${LIVE_ON_POSITION})
                        THEN 'interviewing'::position_status ELSE 'open'::position_status END,
          updated_at = now()
        WHERE p.id = $1 RETURNING status`,
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

/** Set a position's stage and its hiring goal's progress (open quarter only). */
const movePosition = async (
  tx: DbClient,
  positionId: string,
  from: PositionStatus[],
  to: PositionStatus,
  progress: number,
) => {
  const moved = await tx.query(
    `UPDATE ta.positions SET status = $3::position_status, updated_at = now()
      WHERE id = $1 AND status = ANY($2::position_status[]) RETURNING id`,
    [positionId, from, to],
  );
  if (!moved[0]) return;
  await tx.query(
    `UPDATE org.goals g SET progress = $2, updated_at = now()
       FROM org.review_cycles c
      WHERE c.id = g.cycle_id AND c.closed_at IS NULL AND g.position_id = $1`,
    [positionId, progress],
  );
};

type LetterFile = { fileName: string; contentType: string; data: Buffer };

/** DB access for documents, the HR Head-approved offer and the hire (TA, 2026-10-27). */
export const createHireRepository = (db: DbClient) => ({
  /** Where an application stands, for the rules (locked inside a write). */
  findApplication: async (id: string) =>
    (
      await db.query<{
        id: string;
        stage: string;
        candidate_id: string;
        candidate_name: string;
        candidate_code: string | null;
        candidate_phone: string | null;
        position_id: string;
        position_number: number;
        recruiter_id: string | null;
        requisition_id: string;
        ta_rm_id: string | null;
        requisition_status: string;
        role_title: string;
        department_id: string;
        department_name: string;
        offered_ctc: string | null;
        joining_date: string | null;
        offer_terms: string | null;
        offer_status: 'draft' | 'pending' | 'approved' | 'returned' | null;
        offered_at: Date | null;
        employee_id: string | null;
        next_action: string | null;
      }>(
        `SELECT a.id, a.stage::text, a.candidate_id, c.name AS candidate_name,
                c.candidate_code, c.phone AS candidate_phone,
                a.position_id, p.number AS position_number, p.recruiter_id, p.requisition_id,
                q.ta_rm_id, q.status::text AS requisition_status, q.role_title, q.department_id,
                d.name AS department_name, a.offered_ctc::text, a.joining_date::text,
                a.offer_terms, a.offer_status, a.offered_at, a.employee_id, a.next_action
           FROM ta.applications a
           JOIN ta.candidates c ON c.id = a.candidate_id
           JOIN ta.positions p ON p.id = a.position_id
           JOIN ta.requisitions q ON q.id = p.requisition_id
           JOIN org.departments d ON d.id = q.department_id
          WHERE a.id = $1`,
        [id],
      )
    )[0],

  // ── Documents (workflow deck steps 13–14) ───────────────────────────────

  documentsOf: (id: string) =>
    db.query<{ id: string; name: string; status: CandidateDocStatus; updated_at: Date }>(
      `SELECT id, name, status, updated_at FROM ta.application_documents
        WHERE application_id = $1 ORDER BY created_at, name`,
      [id],
    ),

  addDocument: (id: string, name: string, actor: ActorContext): Promise<boolean> =>
    db.transaction(async (tx) => {
      const rows = await tx.query(
        `INSERT INTO ta.application_documents (application_id, name, updated_by)
         VALUES ($1, $2, $3) ON CONFLICT (application_id, name) DO NOTHING RETURNING id`,
        [id, name, actor.actorEmployeeId],
      );
      if (!rows[0]) return false;
      await audit(tx, actor, 'application.document_requested', id, { name });
      return true;
    }),

  setDocument: (
    id: string,
    docId: string,
    status: CandidateDocStatus,
    actor: ActorContext,
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const rows = await tx.query<{ name: string }>(
        `UPDATE ta.application_documents
            SET status = $3::candidate_doc_status, updated_by = $4, updated_at = now()
          WHERE id = $2 AND application_id = $1 RETURNING name`,
        [id, docId, status, actor.actorEmployeeId],
      );
      if (!rows[0]) return false;
      await audit(tx, actor, 'application.document', id, { name: rows[0].name, status });
      return true;
    }),

  setFolder: (id: string, link: string | null, actor: ActorContext): Promise<void> =>
    db.transaction(async (tx) => {
      await tx.query(
        `UPDATE ta.applications SET folder_link = $2, updated_at = now() WHERE id = $1`,
        [id, link],
      );
      await audit(tx, actor, 'application.folder', id);
    }),

  // ── Offer: draft → HR Head approves + signs → shared ────────────────────

  saveOfferLetter: (id: string, file: LetterFile, actor: ActorContext): Promise<void> =>
    db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO ta.offer_letters (application_id, file_name, content_type, size_bytes, data, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (application_id) DO UPDATE SET
           file_name = EXCLUDED.file_name, content_type = EXCLUDED.content_type,
           size_bytes = EXCLUDED.size_bytes, data = EXCLUDED.data,
           uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
        [id, file.fileName, file.contentType, file.data.length, file.data, actor.actorEmployeeId],
      );
      await audit(tx, actor, 'application.offer_letter', id, { bytes: file.data.length });
    }),

  offerLetter: async (id: string) =>
    (
      await db.query<{ file_name: string; content_type: string; data: Buffer }>(
        `SELECT file_name, content_type, data FROM ta.offer_letters WHERE application_id = $1`,
        [id],
      )
    )[0],

  hasOfferLetter: async (id: string): Promise<boolean> =>
    (await db.query(`SELECT 1 FROM ta.offer_letters WHERE application_id = $1`, [id])).length > 0,

  saveSignedLetter: (id: string, file: LetterFile, actor: ActorContext): Promise<void> =>
    db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO ta.signed_offer_letters (application_id, file_name, content_type, size_bytes, data, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (application_id) DO UPDATE SET
           file_name = EXCLUDED.file_name, content_type = EXCLUDED.content_type,
           size_bytes = EXCLUDED.size_bytes, data = EXCLUDED.data,
           uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
        [id, file.fileName, file.contentType, file.data.length, file.data, actor.actorEmployeeId],
      );
      await audit(tx, actor, 'application.signed_offer_letter', id, { bytes: file.data.length });
    }),

  signedLetter: async (id: string) =>
    (
      await db.query<{ file_name: string; content_type: string; data: Buffer }>(
        `SELECT file_name, content_type, data FROM ta.signed_offer_letters WHERE application_id = $1`,
        [id],
      )
    )[0],

  hasSignedLetter: async (id: string): Promise<boolean> =>
    (await db.query(`SELECT 1 FROM ta.signed_offer_letters WHERE application_id = $1`, [id]))
      .length > 0,

  /**
   * Save the negotiated terms. While interviewed (draft / returned) or waiting
   * for the HR Head they are simply updated; APPROVED terms that change go
   * back to the HR Head — approval cleared, the signed letter discarded.
   * Returns 'saved' | 'reopened' | false (wrong stage).
   */
  saveOfferDraft: (
    id: string,
    input: { ctc: number; joiningDate: string; terms: string | null },
    actor: ActorContext,
    bellsIfReopened: Bell[],
  ): Promise<'saved' | 'reopened' | false> =>
    db.transaction(async (tx) => {
      const cur = (
        await tx.query<{ stage: string; offer_status: string | null }>(
          `SELECT stage::text, offer_status::text FROM ta.applications WHERE id = $1 FOR UPDATE`,
          [id],
        )
      )[0];
      if (!cur || !['interviewed', 'decision', 'selected'].includes(cur.stage)) return false;
      const reopen = cur.stage === 'selected';
      await tx.query(
        `UPDATE ta.applications SET offered_ctc = $2, joining_date = $3::date, offer_terms = $4,
            offer_status = CASE WHEN $5 THEN 'pending'::offer_status
                                WHEN offer_status IS NULL THEN 'draft'::offer_status
                                ELSE offer_status END,
            stage = CASE WHEN $5 THEN 'decision'::application_stage ELSE stage END,
            offer_approved_by = CASE WHEN $5 THEN NULL ELSE offer_approved_by END,
            offer_approved_at = CASE WHEN $5 THEN NULL ELSE offer_approved_at END,
            updated_at = now()
          WHERE id = $1`,
        [id, input.ctc, input.joiningDate, input.terms, reopen],
      );
      if (reopen) {
        await tx.query(`DELETE FROM ta.signed_offer_letters WHERE application_id = $1`, [id]);
      }
      await audit(tx, actor, reopen ? 'application.offer_reopened' : 'application.offer_draft', id, {
        joiningDate: input.joiningDate,
      });
      if (reopen) await ring(tx, bellsIfReopened);
      return reopen ? 'reopened' : 'saved';
    }),

  /** Interviewed → decision: the drafted offer goes to the HR Head. */
  submitOffer: (id: string, actor: ActorContext, bells: Bell[]): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query(
        `UPDATE ta.applications SET stage = 'decision', offer_status = 'pending',
            offer_return_reason = NULL, decision_started_at = now(), updated_at = now()
          WHERE id = $1 AND stage = 'interviewed' AND offered_ctc IS NOT NULL
            AND joining_date IS NOT NULL RETURNING id`,
        [id],
      );
      if (!moved[0]) return false;
      await audit(tx, actor, 'application.offer_submitted', id);
      await ring(tx, bells);
      return true;
    }),

  /** Applications whose offer waits for the HR Head. */
  pendingOfferIds: async (): Promise<string[]> =>
    (
      await db.query<{ id: string }>(
        `SELECT id FROM ta.applications
          WHERE stage = 'decision' AND offer_status = 'pending'
          ORDER BY decision_started_at`,
      )
    ).map((r) => r.id),

  /** The HR Head approves (the signed letter is in place): decision → selected. */
  approveOffer: (id: string, actor: ActorContext, bells: Bell[]): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query(
        `UPDATE ta.applications SET stage = 'selected', offer_status = 'approved',
            offer_approved_by = $2, offer_approved_at = now(), selected_at = now(),
            updated_at = now()
          WHERE id = $1 AND stage = 'decision' AND offer_status = 'pending' RETURNING id`,
        [id, actor.actorEmployeeId],
      );
      if (!moved[0]) return false;
      await audit(tx, actor, 'application.offer_approved', id);
      await ring(tx, bells);
      return true;
    }),

  /** The HR Head sends it back to TA with what to change: decision → interviewed. */
  returnOffer: (id: string, reason: string, actor: ActorContext, bells: Bell[]): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query(
        `UPDATE ta.applications SET stage = 'interviewed', offer_status = 'returned',
            offer_return_reason = $2, updated_at = now()
          WHERE id = $1 AND stage = 'decision' AND offer_status = 'pending' RETURNING id`,
        [id, reason],
      );
      if (!moved[0]) return false;
      await audit(tx, actor, 'application.offer_returned', id, { reason });
      await ring(tx, bells);
      return true;
    }),

  /** Selected (approved + signed) → offered: TA shares it; the position moves to `offer`. */
  shareOffer: (
    id: string,
    positionId: string,
    progress: number,
    actor: ActorContext,
    bells: Bell[],
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query(
        `UPDATE ta.applications SET stage = 'offered', offered_at = now(), updated_at = now()
          WHERE id = $1 AND stage = 'selected' AND offer_status = 'approved' RETURNING id`,
        [id],
      );
      if (!moved[0]) return false;
      await movePosition(tx, positionId, ['open', 'interviewing'], 'offer', progress);
      await audit(tx, actor, 'application.offered', id);
      await ring(tx, bells);
      return true;
    }),

  /** Offered → declined by the candidate / withdrawn by us; the position reopens. */
  endOffer: (
    id: string,
    to: 'offer_declined' | 'offer_withdrawn',
    reason: string,
    positionId: string,
    progress: Record<PositionStatus, number>,
    actor: ActorContext,
    bells: Bell[],
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query(
        `UPDATE ta.applications SET stage = $2::application_stage, outcome_reason = $3,
            updated_at = now()
          WHERE id = $1 AND stage = 'offered' RETURNING id`,
        [id, to, reason],
      );
      if (!moved[0]) return false;
      await reopenPosition(tx, positionId, progress);
      await audit(tx, actor, `application.${to}`, id, { reason });
      await ring(tx, bells);
      return true;
    }),

  /**
   * Offered → hired, inside the caller's transaction (the one that created
   * the employee record): the position is filled and its goal reaches 100.
   */
  markHired: async (
    tx: DbClient,
    id: string,
    employeeId: string,
    positionId: string,
    progress: number,
    actor: ActorContext,
    bells: Bell[],
  ): Promise<boolean> => {
    const moved = await tx.query(
      `UPDATE ta.applications SET stage = 'hired', employee_id = $2, hired_at = now(), updated_at = now()
        WHERE id = $1 AND stage = 'offered' RETURNING id`,
      [id, employeeId],
    );
    if (!moved[0]) return false;
    await movePosition(tx, positionId, ['offer', 'interviewing', 'open'], 'filled', progress);
    await audit(tx, actor, 'application.hired', id, { employeeId });
    await ring(tx, bells);
    return true;
  },

  /** What HRBP needs at handover: documents received / still pending. */
  documentCounts: async (id: string) =>
    (
      await db.query<{ received: number; pending: number }>(
        `SELECT count(*) FILTER (WHERE status = 'received')::int AS received,
                count(*) FILTER (WHERE status = 'requested')::int AS pending
           FROM ta.application_documents WHERE application_id = $1`,
        [id],
      )
    )[0]!,

  /** HRBP confirms the actual joining (accepted and joined are counted apart). */
  confirmJoined: (id: string, actor: ActorContext, bells: Bell[]): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query(
        `UPDATE ta.applications SET stage = 'joined', joined_confirmed_by = $2, joined_at = now(),
            updated_at = now()
          WHERE id = $1 AND stage = 'hired' RETURNING id`,
        [id, actor.actorEmployeeId],
      );
      if (!moved[0]) return false;
      await audit(tx, actor, 'application.joined', id);
      await ring(tx, bells);
      return true;
    }),

  /**
   * Hired → no_show (backed out before joining): the never-started employee
   * record is deactivated — never deleted — and the position reopens.
   */
  noShow: (
    id: string,
    employeeId: string,
    reason: string,
    positionId: string,
    progress: Record<PositionStatus, number>,
    actor: ActorContext,
    bells: Bell[],
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query(
        `UPDATE ta.applications SET stage = 'no_show', outcome_reason = $2, updated_at = now()
          WHERE id = $1 AND stage = 'hired' RETURNING id`,
        [id, reason],
      );
      if (!moved[0]) return false;
      await tx.query(
        `UPDATE org.employees SET status = 'inactive', updated_at = now() WHERE id = $1`,
        [employeeId],
      );
      await tx.query(
        `UPDATE ta.positions SET status = 'open', updated_at = now() WHERE id = $1 AND status = 'filled'`,
        [positionId],
      );
      await reopenPosition(tx, positionId, progress);
      await audit(tx, actor, 'application.no_show', id, { employeeId, reason });
      await ring(tx, bells);
      return true;
    }),

  /** The joiner's record: still before their first day? (`invited` or joining date ahead). */
  employeeBeforeJoining: async (employeeId: string, today: string): Promise<boolean> =>
    (
      await db.query(
        `SELECT 1 FROM org.employees
          WHERE id = $1 AND (status = 'invited' OR date_of_joining > $2::date)`,
        [employeeId, today],
      )
    ).length > 0,
});

export type HireRepository = ReturnType<typeof createHireRepository>;
