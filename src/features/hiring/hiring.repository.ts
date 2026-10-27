import type { DbClient } from '../../db/client.js';
import { auditLog } from '../../db/schema/index.js';
import { insertNotifications, type NotificationEvent } from '../notifications/index.js';
import type { ApproverRole, DocRole, InterviewRound } from './hiring.schema.js';

export type PositionStatus =
  'awaiting_docs' | 'open' | 'interviewing' | 'offer' | 'filled' | 'cancelled';
export type DocumentKind = 'jd' | 'scorecard';

export interface PositionRow {
  id: string;
  requisition_id: string;
  number: number;
  status: PositionStatus;
  recruiter_id: string | null;
  recruiter_name: string | null;
  opened_at: Date | null;
  goal_id: string | null;
  goal_weight: number | null;
  goal_progress: number | null;
}

export interface DocumentRow {
  id: string;
  requisition_id: string;
  kind: DocumentKind;
  version: number;
  status: 'draft' | 'in_review' | 'returned' | 'approved';
  content: Record<string, unknown>;
  written_by: string;
  written_by_name: string;
  return_reason: string | null;
  submitted_at: Date | null;
  approved_at: Date | null;
}

const SELECT_DOC = `
  SELECT d.id, d.requisition_id, d.kind, d.version, d.status, d.content, d.written_by,
         w.name AS written_by_name, d.return_reason, d.submitted_at, d.approved_at
    FROM ta.documents d JOIN org.employees w ON w.id = d.written_by`;

/** Who performed the mutation. */
export interface ActorContext {
  actorUserId: string | null;
  actorEmployeeId: string;
}

export interface Bell {
  to: string[];
  event: NotificationEvent;
}

export type RequisitionStatus =
  'draft' | 'queued' | 'submitted' | 'returned' | 'approved' | 'cancelled';

/** A requisition joined with the names the screens show. */
export interface RequisitionRow {
  id: string;
  plan_id: string | null;
  department_id: string;
  department_name: string;
  quarter: string | null;
  role_title: string;
  quantity: number;
  notes: string | null;
  budget_min: string | null;
  budget_max: string | null;
  version: number;
  status: RequisitionStatus;
  urgent: boolean;
  created_by: string;
  created_by_name: string;
  submitted_by: string | null;
  submitted_at: Date | null;
  return_reason: string | null;
  approved_at: Date | null;
  ta_rm_id: string | null;
  ta_rm_name: string | null;
  ta_rm_assigned_at: Date | null;
  created_at: Date;
}

export interface RoundRow {
  requisition_id: string;
  round: InterviewRound;
  interviewer_id: string | null;
  interviewer_name: string | null;
}

export interface ApprovalRow {
  subject_id: string;
  version: number;
  role: ApproverRole;
  decision: 'approve' | 'reject';
  decided_by_name: string;
  reason: string | null;
  decided_at: Date;
}

const SELECT_REQ = `
  SELECT r.id, r.plan_id, r.department_id, d.name AS department_name, p.quarter,
         r.role_title, r.quantity, r.notes, r.budget_min::text, r.budget_max::text,
         r.version, r.status, r.urgent,
         r.created_by, c.name AS created_by_name, r.submitted_by, r.submitted_at,
         r.return_reason, r.approved_at, r.ta_rm_id, t.name AS ta_rm_name,
         r.ta_rm_assigned_at, r.created_at
    FROM ta.requisitions r
    JOIN org.departments d ON d.id = r.department_id
    JOIN org.employees c ON c.id = r.created_by
    LEFT JOIN org.employees t ON t.id = r.ta_rm_id
    LEFT JOIN ta.hiring_plans p ON p.id = r.plan_id`;

const audit = (
  tx: DbClient,
  actor: ActorContext,
  action: string,
  requisitionId: string,
  detail?: Record<string, unknown>,
) =>
  tx.orm.insert(auditLog).values({
    actorUserId: actor.actorUserId,
    action,
    subject: `requisitions:${requisitionId}`,
    detail: detail ? JSON.stringify(detail) : null,
  });

const ring = async (tx: DbClient, bells: Bell[] = []) => {
  for (const b of bells) await insertNotifications(tx, b.to, b.event);
};

const writeRounds = async (
  tx: DbClient,
  requisitionId: string,
  rounds: Array<{ round: InterviewRound; interviewerId: string | null }>,
) => {
  await tx.query(`DELETE FROM ta.requisition_rounds WHERE requisition_id = $1`, [
    requisitionId,
  ]);
  for (const r of rounds) {
    await tx.query(
      `INSERT INTO ta.requisition_rounds (requisition_id, round, interviewer_id)
       VALUES ($1, $2::interview_round, $3)`,
      [requisitionId, r.round, r.interviewerId],
    );
  }
};

/** The only place the hiring feature touches the database. */
export const createHiringRepository = (db: DbClient) => ({
  // ── Who is who ───────────────────────────────────────────────────────────

  /** Departments whose head seat this person holds right now. */
  headOf: (employeeId: string) =>
    db.query<{ department_id: string; department_name: string; acting: boolean }>(
      `SELECT s.department_id, d.name AS department_name, s.acting
         FROM org.seats s JOIN org.departments d ON d.id = s.department_id
        WHERE s.seat = 'dept_head' AND s.ended_at IS NULL AND s.employee_id = $1
        ORDER BY d.name`,
      [employeeId],
    ),

  /** Who holds each approver role right now (missing key = nobody: it waits). */
  /**
   * The HR approver is the head of the department set as HR in
   * `hiring.hrDepartment` (the VP seat carries no approval power).
   */
  approverHolders: async (
    hrDepartmentId: string | null,
  ): Promise<Partial<Record<ApproverRole, string>>> => {
    const rows = await db.query<{ role: ApproverRole; employee_id: string }>(
      `SELECT 'hr_head' AS role, employee_id FROM org.seats
        WHERE seat = 'dept_head' AND department_id = $1 AND ended_at IS NULL
       UNION ALL
       SELECT 'admin', employee_id FROM access.org_owner`,
      [hrDepartmentId],
    );
    return Object.fromEntries(rows.map((r) => [r.role, r.employee_id]));
  },

  nameOf: async (employeeId: string): Promise<string> =>
    (
      await db.query<{ name: string }>(`SELECT name FROM org.employees WHERE id = $1`, [
        employeeId,
      ])
    )[0]?.name ?? 'Someone',

  departmentHead: async (departmentId: string): Promise<string | undefined> =>
    (
      await db.query<{ employee_id: string }>(
        `SELECT employee_id FROM org.seats
          WHERE seat = 'dept_head' AND department_id = $1 AND ended_at IS NULL`,
        [departmentId],
      )
    )[0]?.employee_id,

  /** Active people who aren't the Admin account — can be named as interviewers. */
  eligiblePeople: async (ids: string[]): Promise<Set<string>> =>
    new Set(
      (
        await db.query<{ id: string }>(
          `SELECT id FROM org.employees
            WHERE id = ANY($1::uuid[]) AND status = 'active'
              AND id NOT IN (SELECT employee_id FROM access.org_owner)`,
          [ids],
        )
      ).map((r) => r.id),
    ),

  // ── Reads ────────────────────────────────────────────────────────────────

  findRequisition: async (id: string): Promise<RequisitionRow | undefined> =>
    (await db.query<RequisitionRow>(`${SELECT_REQ} WHERE r.id = $1`, [id]))[0],

  planRequisitions: (departmentId: string, quarter: string) =>
    db.query<RequisitionRow>(
      `${SELECT_REQ} WHERE r.department_id = $1 AND p.quarter = $2 ORDER BY r.created_at`,
      [departmentId, quarter],
    ),

  listRequisitions: (status?: RequisitionStatus) =>
    db.query<RequisitionRow>(
      `${SELECT_REQ} WHERE ($1::text IS NULL OR r.status::text = $1)
        ORDER BY r.updated_at DESC LIMIT 500`,
      [status ?? null],
    ),

  /** Submitted lines that still miss a decision from any of these roles. */
  waitingOn: (roles: ApproverRole[]) =>
    db.query<RequisitionRow>(
      `${SELECT_REQ}
        WHERE r.status = 'submitted'
          AND EXISTS (
            SELECT 1 FROM unnest($1::approver_role[]) AS want(role)
             WHERE NOT EXISTS (
               SELECT 1 FROM ta.approvals a
                WHERE a.subject_kind = 'requisition' AND a.subject_id = r.id
                  AND a.version = r.version AND a.role = want.role))
        ORDER BY r.submitted_at`,
      [roles],
    ),

  roundsOf: (ids: string[]) =>
    db.query<RoundRow>(
      `SELECT rr.requisition_id, rr.round, rr.interviewer_id, e.name AS interviewer_name
         FROM ta.requisition_rounds rr LEFT JOIN org.employees e ON e.id = rr.interviewer_id
        WHERE rr.requisition_id = ANY($1::uuid[])
        ORDER BY array_position(ARRAY['hr','technical','practical','managerial','hr_final']::interview_round[], rr.round)`,
      [ids],
    ),

  approvalsOf: (ids: string[]) =>
    db.query<ApprovalRow>(
      `SELECT a.subject_id, a.version, a.role, a.decision, e.name AS decided_by_name,
              a.reason, a.decided_at
         FROM ta.approvals a JOIN org.employees e ON e.id = a.decided_by
        WHERE a.subject_kind = 'requisition' AND a.subject_id = ANY($1::uuid[])
        ORDER BY a.decided_at`,
      [ids],
    ),

  // ── Writes (each one transaction + audit row + bells) ───────────────────

  /** Add a line to the department's plan for the quarter (plan created on first use). */
  create: (
    input: {
      departmentId: string;
      quarter: string;
      roleTitle: string;
      quantity: number;
      notes: string | null;
      budgetMin: number;
      budgetMax: number;
      rounds: Array<{ round: InterviewRound; interviewerId: string | null }>;
    },
    actor: ActorContext,
  ): Promise<string> =>
    db.transaction(async (tx) => {
      const plan = (
        await tx.query<{ id: string }>(
          `INSERT INTO ta.hiring_plans (department_id, quarter, created_by) VALUES ($1, $2, $3)
           ON CONFLICT (department_id, quarter) DO UPDATE SET quarter = EXCLUDED.quarter
           RETURNING id`,
          [input.departmentId, input.quarter, actor.actorEmployeeId],
        )
      )[0]!;
      const row = (
        await tx.query<{ id: string }>(
          `INSERT INTO ta.requisitions (plan_id, department_id, role_title, quantity, notes,
                                        budget_min, budget_max, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            plan.id,
            input.departmentId,
            input.roleTitle,
            input.quantity,
            input.notes,
            input.budgetMin,
            input.budgetMax,
            actor.actorEmployeeId,
          ],
        )
      )[0]!;
      await writeRounds(tx, row.id, input.rounds);
      await audit(tx, actor, 'requisition.created', row.id, {
        quarter: input.quarter,
        roleTitle: input.roleTitle,
        quantity: input.quantity,
        budgetMin: input.budgetMin,
        budgetMax: input.budgetMax,
      });
      return row.id;
    }),

  /**
   * Edit a draft or returned line. Editing a RETURNED line starts a new
   * version (status back to draft) — every earlier approval stops counting.
   * False = it moved meanwhile.
   */
  update: (
    id: string,
    patch: {
      roleTitle?: string;
      quantity?: number;
      notes?: string | null;
      budgetMin?: number;
      budgetMax?: number;
    },
    rounds: Array<{ round: InterviewRound; interviewerId: string | null }> | undefined,
    actor: ActorContext,
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query<{ version: number }>(
        `UPDATE ta.requisitions SET
            role_title = coalesce($2, role_title),
            quantity = coalesce($3, quantity),
            notes = CASE WHEN $4::boolean THEN $5 ELSE notes END,
            budget_min = coalesce($6, budget_min),
            budget_max = coalesce($7, budget_max),
            version = CASE WHEN status = 'returned' THEN version + 1 ELSE version END,
            status = 'draft',
            updated_at = now()
          WHERE id = $1 AND status IN ('draft', 'returned')
          RETURNING version`,
        [
          id,
          patch.roleTitle ?? null,
          patch.quantity ?? null,
          patch.notes !== undefined,
          patch.notes ?? null,
          patch.budgetMin ?? null,
          patch.budgetMax ?? null,
        ],
      );
      if (!moved[0]) return false;
      if (rounds) await writeRounds(tx, id, rounds);
      await audit(tx, actor, 'requisition.edited', id, { version: moved[0].version });
      return true;
    }),

  /**
   * The head submits a draft for the quarter: it waits (queued) in that
   * quarter's plan until the deadline. The plan is the one being planned
   * now — a draft left in an earlier quarter moves forward with it.
   */
  queue: (
    id: string,
    departmentId: string,
    quarter: string,
    actor: ActorContext,
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const plan = (
        await tx.query<{ id: string }>(
          `INSERT INTO ta.hiring_plans (department_id, quarter, created_by) VALUES ($1, $2, $3)
           ON CONFLICT (department_id, quarter) DO UPDATE SET quarter = EXCLUDED.quarter
           RETURNING id`,
          [departmentId, quarter, actor.actorEmployeeId],
        )
      )[0]!;
      const moved = await tx.query(
        `UPDATE ta.requisitions SET status = 'queued', plan_id = $2, submitted_by = $3,
            updated_at = now()
          WHERE id = $1 AND status = 'draft' RETURNING id`,
        [id, plan.id, actor.actorEmployeeId],
      );
      if (!moved[0]) return false;
      await audit(tx, actor, 'requisition.queued', id, { quarter });
      return true;
    }),

  /** Take a queued line back to draft (before the deadline sends it). */
  unqueue: (id: string, actor: ActorContext): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query(
        `UPDATE ta.requisitions SET status = 'draft', submitted_by = NULL, updated_at = now()
          WHERE id = $1 AND status = 'queued' RETURNING id`,
        [id],
      );
      if (!moved[0]) return false;
      await audit(tx, actor, 'requisition.unqueued', id);
      return true;
    }),

  /**
   * A line that already went for approval once (returned, maybe edited back
   * to draft) goes straight back to the approvers — its quarter was sent.
   */
  submit: (id: string, actor: ActorContext, bells: Bell[]): Promise<number | null> =>
    db.transaction(async (tx) => {
      const moved = await tx.query<{ version: number }>(
        `UPDATE ta.requisitions SET
            version = CASE WHEN status = 'returned' THEN version + 1 ELSE version END,
            status = 'submitted', submitted_by = $2, submitted_at = now(),
            return_reason = NULL, updated_at = now()
          WHERE id = $1 AND (status = 'returned' OR (status = 'draft' AND submitted_at IS NOT NULL))
          RETURNING version`,
        [id, actor.actorEmployeeId],
      );
      if (!moved[0]) return null;
      await audit(tx, actor, 'requisition.submitted', id, { version: moved[0].version });
      await ring(tx, bells);
      return moved[0].version;
    }),

  cancel: (id: string, actor: ActorContext): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query(
        `UPDATE ta.requisitions SET status = 'cancelled', updated_at = now()
          WHERE id = $1 AND status IN ('draft', 'queued', 'submitted', 'returned') RETURNING id`,
        [id],
      );
      if (!moved[0]) return false;
      await audit(tx, actor, 'requisition.cancelled', id);
      return true;
    }),

  /**
   * Record one person's decision for each role they hold, on the version they
   * saw. A reject returns the line; the last missing approve approves it.
   * The row is locked so two approvers deciding at once can't both "finish" it.
   */
  decide: (
    id: string,
    version: number,
    roles: ApproverRole[],
    /** The roles that may decide this line (Admin alone for the HR head's own lines). */
    needed: ApproverRole[],
    decision: 'approve' | 'reject',
    reason: string | null,
    actor: ActorContext,
    bellsFor: (outcome: 'returned' | 'approved' | 'pending') => Bell[],
  ): Promise<'stale' | 'decided' | 'returned' | 'approved' | 'pending'> =>
    db.transaction(async (tx) => {
      const cur = (
        await tx.query<{ status: RequisitionStatus; version: number }>(
          `SELECT status, version FROM ta.requisitions WHERE id = $1 FOR UPDATE`,
          [id],
        )
      )[0];
      if (!cur || cur.status !== 'submitted' || cur.version !== version) return 'stale';
      const done = await tx.query<{ role: ApproverRole }>(
        `SELECT role FROM ta.approvals
          WHERE subject_kind = 'requisition' AND subject_id = $1 AND version = $2`,
        [id, version],
      );
      const open = roles.filter((r) => !done.some((d) => d.role === r));
      if (open.length === 0) return 'decided';
      for (const role of open) {
        await tx.query(
          `INSERT INTO ta.approvals (subject_kind, subject_id, version, role, decided_by, decision, reason)
           VALUES ('requisition', $1, $2, $3::approver_role, $4, $5::approval_decision, $6)`,
          [id, version, role, actor.actorEmployeeId, decision, reason],
        );
      }
      let outcome: 'returned' | 'approved' | 'pending' = 'pending';
      if (decision === 'reject') {
        await tx.query(
          `UPDATE ta.requisitions SET status = 'returned', return_reason = $2, updated_at = now()
            WHERE id = $1`,
          [id, reason],
        );
        outcome = 'returned';
      } else {
        const approved = await tx.query<{ n: number }>(
          `SELECT count(DISTINCT role)::int AS n FROM ta.approvals
            WHERE subject_kind = 'requisition' AND subject_id = $1 AND version = $2
              AND decision = 'approve' AND role = ANY($3::approver_role[])`,
          [id, version, needed],
        );
        // One approval from any of them is enough (learner, 2026-10-26).
        if (approved[0]!.n >= 1) {
          await tx.query(
            `UPDATE ta.requisitions SET status = 'approved', approved_at = now(), updated_at = now()
              WHERE id = $1`,
            [id],
          );
          // One position per seat ("2 × …" → #1, #2); they wait for the JD + scorecard.
          await tx.query(
            `INSERT INTO ta.positions (requisition_id, number)
             SELECT r.id, n FROM ta.requisitions r, generate_series(1, r.quantity) AS n
              WHERE r.id = $1
             ON CONFLICT (requisition_id, number) DO NOTHING`,
            [id],
          );
          outcome = 'approved';
        }
      }
      await audit(
        tx,
        actor,
        decision === 'approve' ? 'requisition.approval' : 'requisition.rejection',
        id,
        { version, roles: open, reason, outcome },
      );
      await ring(tx, bellsFor(outcome));
      return outcome;
    }),

  // ── Step C: positions, JD + scorecard ───────────────────────────────────

  positionsOf: (requisitionIds: string[]) =>
    db.query<PositionRow>(
      `SELECT p.id, p.requisition_id, p.number, p.status, p.recruiter_id,
              e.name AS recruiter_name, p.opened_at,
              g.id AS goal_id, g.weight::float8 AS goal_weight, g.progress AS goal_progress
         FROM ta.positions p
         LEFT JOIN org.employees e ON e.id = p.recruiter_id
         LEFT JOIN LATERAL (
           SELECT g.* FROM org.goals g JOIN org.review_cycles c ON c.id = g.cycle_id
            WHERE g.position_id = p.id ORDER BY c.start_date DESC LIMIT 1) g ON true
        WHERE p.requisition_id = ANY($1::uuid[])
        ORDER BY p.number`,
      [requisitionIds],
    ),

  findPosition: async (id: string) =>
    (
      await db.query<{
        id: string;
        requisition_id: string;
        number: number;
        status: PositionStatus;
        recruiter_id: string | null;
      }>(
        `SELECT id, requisition_id, number, status, recruiter_id FROM ta.positions WHERE id = $1`,
        [id],
      )
    )[0],

  documentsOf: (requisitionIds: string[]) =>
    db.query<DocumentRow>(`${SELECT_DOC} WHERE d.requisition_id = ANY($1::uuid[])`, [
      requisitionIds,
    ]),

  findDocument: async (requisitionId: string, kind: DocumentKind) =>
    (
      await db.query<DocumentRow>(
        `${SELECT_DOC} WHERE d.requisition_id = $1 AND d.kind = $2`,
        [requisitionId, kind],
      )
    )[0],

  findDocumentById: async (id: string) =>
    (await db.query<DocumentRow>(`${SELECT_DOC} WHERE d.id = $1`, [id]))[0],

  documentApprovalsOf: (documentIds: string[]) =>
    db.query<ApprovalRow>(
      `SELECT a.subject_id, a.version, a.role, a.decision, e.name AS decided_by_name,
              a.reason, a.decided_at
         FROM ta.approvals a JOIN org.employees e ON e.id = a.decided_by
        WHERE a.subject_kind IN ('jd', 'scorecard') AND a.subject_id = ANY($1::uuid[])
        ORDER BY a.decided_at`,
      [documentIds],
    ),

  /** Documents in review that still miss my decision (as dept head of their line, or Admin). */
  reviewsWaiting: (employeeId: string, isAdmin: boolean) =>
    db.query<DocumentRow>(
      `${SELECT_DOC}
         JOIN ta.requisitions r ON r.id = d.requisition_id
        WHERE d.status = 'in_review'
          AND (
            ($2 AND NOT EXISTS (SELECT 1 FROM ta.approvals a
                 WHERE a.subject_kind = d.kind::text::approval_subject AND a.subject_id = d.id
                   AND a.version = d.version AND a.role = 'admin'))
            OR (EXISTS (SELECT 1 FROM org.seats s
                 WHERE s.seat = 'dept_head' AND s.department_id = r.department_id
                   AND s.ended_at IS NULL AND s.employee_id = $1)
                AND NOT EXISTS (SELECT 1 FROM ta.approvals a
                 WHERE a.subject_kind = d.kind::text::approval_subject AND a.subject_id = d.id
                   AND a.version = d.version AND a.role = 'dept_head')))
        ORDER BY d.submitted_at`,
      [employeeId, isAdmin],
    ),

  /**
   * Write the line's JD or scorecard: create it (draft v1), or edit a draft /
   * returned one — editing a RETURNED document starts a new version, so its
   * earlier approvals stop counting. False = it is in review or approved.
   */
  saveDocument: (
    requisitionId: string,
    kind: DocumentKind,
    content: unknown,
    actor: ActorContext,
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const rows = await tx.query<{ id: string; version: number }>(
        `INSERT INTO ta.documents (requisition_id, kind, content, written_by)
         VALUES ($1, $2::ta_document_kind, $3::jsonb, $4)
         ON CONFLICT (requisition_id, kind) DO UPDATE SET
           content = EXCLUDED.content,
           written_by = EXCLUDED.written_by,
           version = CASE WHEN ta.documents.status = 'returned'
                          THEN ta.documents.version + 1 ELSE ta.documents.version END,
           status = 'draft',
           updated_at = now()
         WHERE ta.documents.status IN ('draft', 'returned')
         RETURNING id, version`,
        [requisitionId, kind, JSON.stringify(content), actor.actorEmployeeId],
      );
      if (!rows[0]) return false;
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: `ta_document.saved`,
        subject: `ta_documents:${rows[0].id}`,
        detail: JSON.stringify({ requisitionId, kind, version: rows[0].version }),
      });
      return true;
    }),

  /** Draft (or returned, unedited — a new version) → in review; reviewers are told. */
  submitDocument: (id: string, actor: ActorContext, bells: Bell[]): Promise<boolean> =>
    db.transaction(async (tx) => {
      const rows = await tx.query<{ version: number }>(
        `UPDATE ta.documents SET
            version = CASE WHEN status = 'returned' THEN version + 1 ELSE version END,
            status = 'in_review', submitted_at = now(), return_reason = NULL, updated_at = now()
          WHERE id = $1 AND status IN ('draft', 'returned')
          RETURNING version`,
        [id],
      );
      if (!rows[0]) return false;
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'ta_document.submitted',
        subject: `ta_documents:${id}`,
        detail: JSON.stringify({ version: rows[0].version }),
      });
      await ring(tx, bells);
      return true;
    }),

  /**
   * One reviewer's decision on the version they saw (dept head and/or Admin).
   * A reject returns the document; the second approve approves it — and when
   * the line's OTHER document is approved too, its positions open and their
   * hiring goals move to the open-stage progress.
   */
  decideDocument: (
    id: string,
    version: number,
    roles: DocRole[],
    decision: 'approve' | 'reject',
    reason: string | null,
    actor: ActorContext,
    openProgress: number,
    bellsFor: (outcome: 'returned' | 'approved' | 'opened' | 'pending') => Bell[],
  ): Promise<'stale' | 'decided' | 'returned' | 'approved' | 'opened' | 'pending'> =>
    db.transaction(async (tx) => {
      const cur = (
        await tx.query<{
          status: string;
          version: number;
          kind: DocumentKind;
          requisition_id: string;
        }>(
          `SELECT status, version, kind, requisition_id FROM ta.documents WHERE id = $1 FOR UPDATE`,
          [id],
        )
      )[0];
      if (!cur || cur.status !== 'in_review' || cur.version !== version) return 'stale';
      const done = await tx.query<{ role: DocRole }>(
        `SELECT role FROM ta.approvals WHERE subject_kind = $1::approval_subject
            AND subject_id = $2 AND version = $3`,
        [cur.kind, id, version],
      );
      const open = roles.filter((r) => !done.some((d) => d.role === r));
      if (open.length === 0) return 'decided';
      for (const role of open) {
        await tx.query(
          `INSERT INTO ta.approvals (subject_kind, subject_id, version, role, decided_by, decision, reason)
           VALUES ($1::approval_subject, $2, $3, $4::approver_role, $5, $6::approval_decision, $7)`,
          [cur.kind, id, version, role, actor.actorEmployeeId, decision, reason],
        );
      }
      let outcome: 'returned' | 'approved' | 'opened' | 'pending' = 'pending';
      if (decision === 'reject') {
        await tx.query(
          `UPDATE ta.documents SET status = 'returned', return_reason = $2, updated_at = now()
            WHERE id = $1`,
          [id, reason],
        );
        outcome = 'returned';
      } else {
        const n = (
          await tx.query<{ n: number }>(
            `SELECT count(DISTINCT role)::int AS n FROM ta.approvals
              WHERE subject_kind = $1::approval_subject AND subject_id = $2 AND version = $3
                AND decision = 'approve'`,
            [cur.kind, id, version],
          )
        )[0]!.n;
        if (n === 2) {
          await tx.query(
            `UPDATE ta.documents SET status = 'approved', approved_at = now(), updated_at = now()
              WHERE id = $1`,
            [id],
          );
          outcome = 'approved';
          const both = (
            await tx.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM ta.documents
                WHERE requisition_id = $1 AND status = 'approved'`,
              [cur.requisition_id],
            )
          )[0]!.n;
          if (both === 2) {
            const opened = await tx.query<{ id: string }>(
              `UPDATE ta.positions SET status = 'open', opened_at = now(), updated_at = now()
                WHERE requisition_id = $1 AND status = 'awaiting_docs' RETURNING id`,
              [cur.requisition_id],
            );
            await tx.query(
              `UPDATE org.goals g SET progress = $2, updated_at = now()
                 FROM org.review_cycles c
                WHERE c.id = g.cycle_id AND c.closed_at IS NULL
                  AND g.position_id = ANY($1::uuid[])`,
              [opened.map((o) => o.id), openProgress],
            );
            outcome = 'opened';
          }
        }
      }
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: decision === 'approve' ? 'ta_document.approval' : 'ta_document.rejection',
        subject: `ta_documents:${id}`,
        detail: JSON.stringify({ version, roles: open, reason, outcome }),
      });
      await ring(tx, bellsFor(outcome));
      return outcome;
    }),

  // ── TA RM: Admin gives each approved line to one ─────────────────────────

  /**
   * Who can take a line: holds the TA batch and has at least one active
   * report (effective RM — the same link position assignment checks).
   */
  taRmOptions: (onlyId?: string) =>
    db.query<{ id: string; name: string; employee_code: string; reports: number }>(
      `SELECT e.id, e.name, e.employee_code, count(r.id)::int AS reports
         FROM org.employees e
         JOIN access.employee_batches eb ON eb.employee_id = e.id
         JOIN access.batches b ON b.id = eb.batch_id AND b.name = 'TA'
         JOIN org.employees r ON coalesce(r.leave_approver, r.reports_to) = e.id
                              AND r.status = 'active'
        WHERE e.status = 'active' AND ($1::uuid IS NULL OR e.id = $1)
        GROUP BY e.id
        ORDER BY e.name`,
      [onlyId ?? null],
    ),

  /**
   * Set (or change) the line's TA RM. Changing is allowed only while none of
   * its positions has a recruiter yet — after that the positions belong to
   * the first TA RM's team.
   */
  assignTaRm: (
    id: string,
    taRmId: string,
    actor: ActorContext,
    bells: Bell[],
  ): Promise<'not_ready' | 'same' | 'positions_assigned' | 'ok'> =>
    db.transaction(async (tx) => {
      const cur = (
        await tx.query<{ status: RequisitionStatus; ta_rm_id: string | null }>(
          `SELECT status, ta_rm_id FROM ta.requisitions WHERE id = $1 FOR UPDATE`,
          [id],
        )
      )[0];
      if (!cur || cur.status !== 'approved') {
        return 'not_ready';
      }
      if (cur.ta_rm_id === taRmId) return 'same';
      if (cur.ta_rm_id) {
        const taken = await tx.query(
          `SELECT 1 FROM ta.positions WHERE requisition_id = $1 AND recruiter_id IS NOT NULL LIMIT 1`,
          [id],
        );
        if (taken.length > 0) return 'positions_assigned';
      }
      await tx.query(
        `UPDATE ta.requisitions
            SET ta_rm_id = $2, ta_rm_assigned_at = now(), ta_rm_assigned_by = $3, updated_at = now()
          WHERE id = $1`,
        [id, taRmId, actor.actorEmployeeId],
      );
      await audit(tx, actor, 'requisition.ta_rm', id, { from: cur.ta_rm_id, to: taRmId });
      await ring(tx, bells);
      return 'ok';
    }),

  /** The recruiter's effective RM and status — only the line's TA RM's own reports qualify. */
  recruiterOf: async (employeeId: string) =>
    (
      await db.query<{ status: string; effective_rm: string | null }>(
        `SELECT status, coalesce(leave_approver, reports_to) AS effective_rm
           FROM org.employees WHERE id = $1`,
        [employeeId],
      )
    )[0],

  /** This quarter's review cycle (created lazily, like the goals feature does). */
  ensureCycle: async (name: string, startDate: string, endDate: string) => {
    await db.query(
      `INSERT INTO org.review_cycles (name, start_date, end_date) VALUES ($1, $2, $3)
       ON CONFLICT (name) DO NOTHING`,
      [name, startDate, endDate],
    );
    return (
      await db.query<{ id: string; end_date: string; closed_at: Date | null }>(
        `SELECT id, end_date::text, closed_at FROM org.review_cycles WHERE name = $1`,
        [name],
      )
    )[0]!;
  },

  /**
   * Give a position to a recruiter: set it on the position and on this
   * quarter's hiring goal — moving the goal to them if one exists (reassign),
   * creating it otherwise. One transaction, audited, the recruiter is told.
   */
  assignPosition: (
    input: {
      positionId: string;
      recruiterId: string;
      weight: number;
      cycleId: string;
      dueOn: string;
      title: string;
      progress: number;
    },
    actor: ActorContext,
    bells: Bell[],
  ): Promise<boolean> =>
    db.transaction(async (tx) => {
      const moved = await tx.query(
        `UPDATE ta.positions SET recruiter_id = $2, updated_at = now()
          WHERE id = $1 AND status IN ('awaiting_docs', 'open', 'interviewing') RETURNING id`,
        [input.positionId, input.recruiterId],
      );
      if (!moved[0]) return false;
      const existing = await tx.query<{ id: string }>(
        `UPDATE org.goals SET employee_id = $3, weight = $4, updated_at = now()
          WHERE position_id = $1 AND cycle_id = $2 RETURNING id`,
        [input.positionId, input.cycleId, input.recruiterId, input.weight],
      );
      if (!existing[0]) {
        await tx.query(
          `INSERT INTO org.goals (employee_id, cycle_id, title, category, metric, target,
                                  weight, progress, due_on, position_id, created_by)
           VALUES ($1, $2, $3, 'fundamental', 'Position filled', '1 hire', $4, $5, $6::date, $7, $8)`,
          [
            input.recruiterId,
            input.cycleId,
            input.title,
            input.weight,
            input.progress,
            input.dueOn,
            input.positionId,
            actor.actorEmployeeId,
          ],
        );
      }
      await tx.orm.insert(auditLog).values({
        actorUserId: actor.actorUserId,
        action: 'position.assigned',
        subject: `positions:${input.positionId}`,
        detail: JSON.stringify({ recruiterId: input.recruiterId, weight: input.weight }),
      });
      await ring(tx, bells);
      return true;
    }),
});

export type HiringRepository = ReturnType<typeof createHiringRepository>;
