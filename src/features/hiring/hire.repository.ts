import type { DbClient } from '../../db/client.js';
import { auditLog } from '../../db/schema/index.js';
import { insertNotifications } from '../notifications/index.js';
import type { ActorContext, Bell, PositionStatus } from './hiring.repository.js';
import { HIRE_ROLES } from './candidates.schema.js';

export type HireRole = (typeof HIRE_ROLES)[number];

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

/** DB access for the final decision, offer, BGV and hire (TA Step E). */
export const createHireRepository = (db: DbClient) => ({
  /** Where an application stands, for the rules (locked inside a write). */
  findApplication: async (id: string) =>
    (
      await db.query<{
        id: string;
        stage: string;
        candidate_id: string;
        candidate_name: string;
        candidate_phone: string | null;
        position_id: string;
        position_number: number;
        recruiter_id: string | null;
        requisition_id: string;
        ta_rm_id: string | null;
        requisition_status: string;
        budget_max: string | null;
        role_title: string;
        department_id: string;
        department_name: string;
        joining_date: string | null;
        offered_at: Date | null;
        employee_id: string | null;
      }>(
        `SELECT a.id, a.stage::text, a.candidate_id, c.name AS candidate_name, c.phone AS candidate_phone,
                a.position_id, p.number AS position_number, p.recruiter_id, p.requisition_id,
                q.ta_rm_id, q.status::text AS requisition_status, q.budget_max::text, q.role_title, q.department_id,
                d.name AS department_name, a.joining_date::text, a.offered_at, a.employee_id
           FROM ta.applications a
           JOIN ta.candidates c ON c.id = a.candidate_id
           JOIN ta.positions p ON p.id = a.position_id
           JOIN ta.requisitions q ON q.id = p.requisition_id
           JOIN org.departments d ON d.id = q.department_id
          WHERE a.id = $1`,
        [id],
      )
    )[0],

  /**
   * Hire decisions still missing one of my roles. `deptIds` = departments I
   * head and `employeeId` as a line's TA RM (both per line); `orgRoles` =
   * the company-wide roles I hold (hr_head / admin).
   */
  pendingDecisionIds: async (
    deptIds: string[],
    employeeId: string,
    orgRoles: HireRole[],
  ): Promise<string[]> =>
    (
      await db.query<{ id: string }>(
        `SELECT a.id FROM ta.applications a
           JOIN ta.positions p ON p.id = a.position_id
           JOIN ta.requisitions q ON q.id = p.requisition_id
          WHERE a.stage = 'decision'
            AND (
              (q.department_id = ANY($1::uuid[]) AND NOT EXISTS (
                 SELECT 1 FROM ta.approvals x WHERE x.subject_kind = 'hire'
                    AND x.subject_id = a.id AND x.role = 'dept_head'))
              OR (q.ta_rm_id = $3 AND NOT EXISTS (
                 SELECT 1 FROM ta.approvals x WHERE x.subject_kind = 'hire'
                    AND x.subject_id = a.id AND x.role = 'ta_rm'))
              OR EXISTS (
                 SELECT 1 FROM unnest($2::approver_role[]) AS want(role)
                  WHERE NOT EXISTS (SELECT 1 FROM ta.approvals x WHERE x.subject_kind = 'hire'
                         AND x.subject_id = a.id AND x.role = want.role)))
          ORDER BY a.decision_started_at`,
        [deptIds, orgRoles, employeeId],
      )
    ).map((r) => r.id),

  /** Interviewed → decision: the four are asked. */
  sendForDecision: (id: string, actor: ActorContext, bells: Bell[]): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query(
        `UPDATE ta.applications SET stage = 'decision', decision_started_at = now(), updated_at = now()
          WHERE id = $1 AND stage = 'interviewed' RETURNING id`,
        [id],
      );
      if (!moved[0]) return false;
      await audit(tx, actor, 'application.decision', id);
      await ring(tx, bells);
      return true;
    }),

  /**
   * One person's decision for every hire role they hold. A reject ends the
   * application (not selected); the fourth approve selects the candidate.
   */
  decideHire: (
    id: string,
    roles: HireRole[],
    decision: 'approve' | 'reject',
    reason: string | null,
    actor: ActorContext,
    bellsFor: (outcome: 'rejected' | 'selected' | 'pending') => Bell[],
  ): Promise<'stale' | 'decided' | 'rejected' | 'selected' | 'pending'> =>
    db.transaction(async (tx) => {
      const cur = (
        await tx.query<{ stage: string }>(
          `SELECT stage::text FROM ta.applications WHERE id = $1 FOR UPDATE`,
          [id],
        )
      )[0];
      if (!cur || cur.stage !== 'decision') return 'stale';
      const done = await tx.query<{ role: HireRole }>(
        `SELECT role FROM ta.approvals WHERE subject_kind = 'hire' AND subject_id = $1`,
        [id],
      );
      const open = roles.filter((r) => !done.some((d) => d.role === r));
      if (open.length === 0) return 'decided';
      for (const role of open) {
        await tx.query(
          `INSERT INTO ta.approvals (subject_kind, subject_id, version, role, decided_by, decision, reason)
           VALUES ('hire', $1, 1, $2::approver_role, $3, $4::approval_decision, $5)`,
          [id, role, actor.actorEmployeeId, decision, reason],
        );
      }
      let outcome: 'rejected' | 'selected' | 'pending' = 'pending';
      if (decision === 'reject') {
        await tx.query(
          `UPDATE ta.applications SET stage = 'rejected', outcome_reason = $2, updated_at = now()
            WHERE id = $1`,
          [id, `Not selected: ${reason}`],
        );
        outcome = 'rejected';
      } else {
        const n = (
          await tx.query<{ n: number }>(
            `SELECT count(DISTINCT role)::int AS n FROM ta.approvals
              WHERE subject_kind = 'hire' AND subject_id = $1 AND decision = 'approve'
                AND role = ANY($2::approver_role[])`,
            [id, [...HIRE_ROLES]],
          )
        )[0]!.n;
        if (n === HIRE_ROLES.length) {
          await tx.query(
            `UPDATE ta.applications SET stage = 'selected', selected_at = now(), updated_at = now()
              WHERE id = $1`,
            [id],
          );
          outcome = 'selected';
        }
      }
      await audit(tx, actor, `application.hire_${decision}`, id, {
        roles: open,
        outcome,
      });
      await ring(tx, bellsFor(outcome));
      return outcome;
    }),

  saveOfferLetter: (
    id: string,
    file: { fileName: string; contentType: string; data: Buffer },
    actor: ActorContext,
  ): Promise<void> =>
    db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO ta.offer_letters (application_id, file_name, content_type, size_bytes, data, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (application_id) DO UPDATE SET
           file_name = EXCLUDED.file_name, content_type = EXCLUDED.content_type,
           size_bytes = EXCLUDED.size_bytes, data = EXCLUDED.data,
           uploaded_by = EXCLUDED.uploaded_by, uploaded_at = now()`,
        [
          id,
          file.fileName,
          file.contentType,
          file.data.length,
          file.data,
          actor.actorEmployeeId,
        ],
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
    (await db.query(`SELECT 1 FROM ta.offer_letters WHERE application_id = $1`, [id]))
      .length > 0,

  /** Selected → offered; the position moves to `offer`. */
  makeOffer: (
    id: string,
    input: {
      ctc: number;
      joiningDate: string;
      positionId: string;
      progress: number;
      overBudget: boolean;
    },
    actor: ActorContext,
    bells: Bell[],
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query(
        `UPDATE ta.applications SET stage = 'offered', offered_ctc = $2, joining_date = $3::date,
            offered_at = now(), updated_at = now()
          WHERE id = $1 AND stage = 'selected' RETURNING id`,
        [id, input.ctc, input.joiningDate],
      );
      if (!moved[0]) return false;
      await movePosition(
        tx,
        input.positionId,
        ['open', 'interviewing'],
        'offer',
        input.progress,
      );
      await audit(tx, actor, 'application.offered', id, {
        joiningDate: input.joiningDate,
        overBudget: input.overBudget,
      });
      await ring(tx, bells);
      return true;
    }),

  /** BGV with the previous employer — runs alongside the decision and the offer. */
  setBgv: (
    id: string,
    status: string,
    notes: string | null,
    actor: ActorContext,
    bells: Bell[],
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query(
        `UPDATE ta.applications SET bgv_status = $2::bgv_status, bgv_notes = $3,
            bgv_updated_at = now(), updated_at = now()
          WHERE id = $1 AND stage IN ('interviewed', 'decision', 'selected', 'offered')
          RETURNING id`,
        [id, status, notes],
      );
      if (!moved[0]) return false;
      await audit(tx, actor, 'application.bgv', id, { status });
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
    await movePosition(
      tx,
      positionId,
      ['offer', 'interviewing', 'open'],
      'filled',
      progress,
    );
    await audit(tx, actor, 'application.hired', id, { employeeId });
    await ring(tx, bells);
    return true;
  },

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
