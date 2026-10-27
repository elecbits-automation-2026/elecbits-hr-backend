import type { DbClient } from '../../db/client.js';
import { auditLog, remindersSent } from '../../db/schema/index.js';
import { insertNotifications } from '../notifications/index.js';

/** One bell + its reminders_sent row (the once-per-quarter dedupe). */
export interface QuarterlyBell {
  kind: string;
  subjectId: string;
  recipientId: string;
  type: string;
  title: string;
  link: string;
}

/** Applications that keep a candidate in play — never anonymised while one is. */
const LIVE = `('sourced', 'shortlisted', 'interviewing', 'interviewed', 'decision', 'selected', 'offered', 'hired')`;

/** DB access for the hiring scheduled jobs (TA Step F). */
export const createHiringJobsRepository = (db: DbClient) => ({
  // ── Quarterly hiring-plan window ────────────────────────────────────────

  /** Current department heads not yet sent this `kind` (one per department). */
  headsNotSent: (kind: string) =>
    db.query<{ department_id: string; department_name: string; head_id: string }>(
      `SELECT s.department_id, d.name AS department_name, s.employee_id AS head_id
         FROM org.seats s JOIN org.departments d ON d.id = s.department_id
        WHERE s.seat = 'dept_head' AND s.ended_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM ops.reminders_sent r
                           WHERE r.kind = $1 AND r.subject_id = s.department_id)
        ORDER BY d.name`,
      [kind],
    ),

  /**
   * Close every plan whose deadline has passed (quarter before `planning`):
   * its queued lines go to the approvers (submitted), and drafts still in it
   * move to the `planning` quarter's plan. One transaction, audited per line.
   */
  releasePlans: (
    planning: string,
    bellsFor: (
      released: Array<{ id: string; quarter: string; submitted_by: string | null }>,
    ) => Array<{ to: string[]; type: string; title: string; link: string }>,
  ) =>
    db.transaction(async (tx) => {
      const released = await tx.query<{
        id: string;
        quarter: string;
        submitted_by: string | null;
      }>(
        `UPDATE ta.requisitions r SET status = 'submitted', submitted_at = now(), updated_at = now()
           FROM ta.hiring_plans p
          WHERE p.id = r.plan_id AND r.status = 'queued' AND p.quarter < $1
          RETURNING r.id, p.quarter, r.submitted_by`,
        [planning],
      );
      for (const r of released) {
        await tx.orm.insert(auditLog).values({
          actorUserId: null,
          action: 'requisition.released',
          subject: `requisitions:${r.id}`,
          detail: JSON.stringify({ quarter: r.quarter }),
        });
      }
      await tx.query(
        `INSERT INTO ta.hiring_plans (department_id, quarter)
         SELECT DISTINCT p.department_id, $1 FROM ta.requisitions r
           JOIN ta.hiring_plans p ON p.id = r.plan_id
          WHERE r.status = 'draft' AND r.submitted_at IS NULL AND p.quarter < $1
         ON CONFLICT (department_id, quarter) DO NOTHING`,
        [planning],
      );
      const carried = await tx.query<{ id: string }>(
        `UPDATE ta.requisitions r SET plan_id = np.id, updated_at = now()
           FROM ta.hiring_plans p, ta.hiring_plans np
          WHERE p.id = r.plan_id AND r.status = 'draft' AND r.submitted_at IS NULL
            AND p.quarter < $1
            AND np.department_id = p.department_id AND np.quarter = $1
          RETURNING r.id`,
        [planning],
      );
      for (const b of bellsFor(released)) {
        await insertNotifications(tx, b.to, { type: b.type, title: b.title, link: b.link });
      }
      return { released: released.length, carried: carried.length };
    }),

  /** Every bell with its reminders_sent row, one transaction. */
  sendBells: async (items: QuarterlyBell[]): Promise<void> => {
    if (items.length === 0) return;
    await db.transaction(async (tx) => {
      await tx.orm
        .insert(remindersSent)
        .values(
          items.map((i) => ({
            kind: i.kind,
            subjectId: i.subjectId,
            recipientId: i.recipientId,
          })),
        );
      for (const i of items) {
        await insertNotifications(tx, [i.recipientId], {
          type: i.type,
          title: i.title,
          link: i.link,
        });
      }
    });
  },

  // ── Talent-pool retention ───────────────────────────────────────────────

  /**
   * Candidates past their 6 months with nothing in play: no live
   * application, never hired (a hire's data lives on as their employee record).
   */
  expiredCandidateIds: async (today: string): Promise<string[]> =>
    (
      await db.query<{ id: string }>(
        `SELECT c.id FROM ta.candidates c
          WHERE c.anonymised_at IS NULL AND c.retain_until < $1::date
            AND NOT EXISTS (SELECT 1 FROM ta.applications a
                             WHERE a.candidate_id = c.id AND a.stage IN ${LIVE})
          LIMIT 500`,
        [today],
      )
    ).map((r) => r.id),

  /**
   * Remove the personal data, keep the rows (and so the counts): name,
   * contact, notes, referrer, the CV and offer letters go; interview notes,
   * BGV notes and reasons are blanked; scores and stages stay.
   */
  anonymise: (ids: string[]): Promise<number> =>
    db.transaction(async (tx) => {
      if (ids.length === 0) return 0;
      const done = await tx.query<{ id: string }>(
        `UPDATE ta.candidates SET name = 'Anonymised candidate', email = NULL, phone = NULL,
            notes = NULL, referred_by = NULL, anonymised_at = now(), updated_at = now()
          WHERE id = ANY($1::uuid[]) AND anonymised_at IS NULL RETURNING id`,
        [ids],
      );
      const gone = done.map((d) => d.id);
      if (gone.length === 0) return 0;
      await tx.query(
        `DELETE FROM ta.candidate_cvs WHERE candidate_id = ANY($1::uuid[])`,
        [gone],
      );
      await tx.query(
        `DELETE FROM ta.offer_letters o USING ta.applications a
          WHERE o.application_id = a.id AND a.candidate_id = ANY($1::uuid[])`,
        [gone],
      );
      await tx.query(
        `UPDATE ta.interview_scores s SET notes = NULL FROM ta.applications a
          WHERE s.application_id = a.id AND a.candidate_id = ANY($1::uuid[])`,
        [gone],
      );
      await tx.query(
        `UPDATE ta.applications SET outcome_reason = NULL, bgv_notes = NULL, updated_at = now()
          WHERE candidate_id = ANY($1::uuid[])`,
        [gone],
      );
      // Counts only — the audit trail must not keep what was just removed.
      await tx.orm.insert(auditLog).values({
        actorUserId: null,
        action: 'candidate.anonymised',
        subject: 'ta.candidates',
        detail: JSON.stringify({ count: gone.length }),
      });
      return gone.length;
    }),

  // ── Hiring-goal carry-over ──────────────────────────────────────────────

  /**
   * Positions still being worked (with a recruiter) that have NO goal in this
   * quarter — with their latest earlier goal to copy the weight from.
   */
  positionsWithoutGoal: (cycleId: string) =>
    db.query<{
      position_id: string;
      status: string;
      recruiter_id: string;
      title: string;
      weight: string;
    }>(
      `SELECT p.id AS position_id, p.status::text, p.recruiter_id,
              coalesce(last.title, 'Fill: ' || q.role_title || ' #' || p.number || ' (' || d.name || ')') AS title,
              coalesce(last.weight, 10)::text AS weight
         FROM ta.positions p
         JOIN ta.requisitions q ON q.id = p.requisition_id
         JOIN org.departments d ON d.id = q.department_id
         LEFT JOIN LATERAL (
           SELECT g.title, g.weight FROM org.goals g JOIN org.review_cycles c ON c.id = g.cycle_id
            WHERE g.position_id = p.id ORDER BY c.start_date DESC LIMIT 1) last ON true
        WHERE p.recruiter_id IS NOT NULL
          AND p.status IN ('awaiting_docs', 'open', 'interviewing', 'offer')
          AND NOT EXISTS (SELECT 1 FROM org.goals g WHERE g.position_id = p.id AND g.cycle_id = $1)`,
      [cycleId],
    ),

  /** Next quarter's hiring goals, one transaction; each recruiter is told. */
  insertCarryOver: (
    cycle: { id: string; endDate: string; name: string },
    rows: Array<{
      positionId: string;
      recruiterId: string;
      title: string;
      weight: string;
      progress: number;
    }>,
  ): Promise<number> =>
    db.transaction(async (tx) => {
      let n = 0;
      for (const r of rows) {
        const ins = await tx.query(
          `INSERT INTO org.goals (employee_id, cycle_id, title, category, metric, target, weight,
                                  progress, due_on, position_id, created_by)
           VALUES ($1, $2, $3, 'fundamental', 'Position filled', '1 hire', $4, $5, $6::date, $7, $1)
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            r.recruiterId,
            cycle.id,
            r.title,
            r.weight,
            r.progress,
            cycle.endDate,
            r.positionId,
          ],
        );
        if (!ins[0]) continue;
        n += 1;
        await insertNotifications(tx, [r.recruiterId], {
          type: 'hiring.goal_carried',
          title: `Carried into ${cycle.name}: ${r.title}`,
          link: '/performance',
        });
      }
      if (n > 0) {
        await tx.orm.insert(auditLog).values({
          actorUserId: null,
          action: 'goal.hiring_carried_over',
          subject: `review_cycles:${cycle.id}`,
          detail: JSON.stringify({ goals: n }),
        });
      }
      return n;
    }),

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
});

export type HiringJobsRepository = ReturnType<typeof createHiringJobsRepository>;
