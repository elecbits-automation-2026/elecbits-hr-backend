import type { DbClient } from '../../db/client.js';

/** Kinds of someone else's sensitive record whose READ is audited (report M12). */
export type SensitiveRead =
  'salary' | 'bank_details' | 'payslip_pdf' | 'medical_certificate';

/** Cut-off dates (YYYY-MM-DD): data older than these is past retention. */
export interface RetentionCutoffs {
  gps: string;
  medical: string;
  exEmployee: string;
}

/**
 * Personal-contact fields cleared for a long-gone ex-employee. Name, code,
 * company email, dates and every payroll / tax / PF record stay — the law
 * needs them; these are what identify and reach the person privately.
 */
const EX_EMPLOYEE_CONTACT_FIELDS = [
  'phone',
  'personal_email',
  'preferred_contact_email',
  'current_address',
  'permanent_address',
] as const;
const ANY_CONTACT = EX_EMPLOYEE_CONTACT_FIELDS.map((f) => `e.${f} IS NOT NULL`).join(
  ' OR ',
);

/** Relieved before the cut-off (the exit's relieving date; inactive people only). */
const EX_EMPLOYEE_WHERE = `e.status = 'inactive' AND (${ANY_CONTACT})
  AND EXISTS (SELECT 1 FROM org.exits x
               WHERE x.employee_id = e.id AND x.relieved_at IS NOT NULL
                 AND x.relieved_at::date < $1::date)`;

const GPS_WHERE = `date < $1::date AND (check_in_lat IS NOT NULL OR check_in_lng IS NOT NULL
  OR check_out_lat IS NOT NULL OR check_out_lng IS NOT NULL
  OR check_in_accuracy_m IS NOT NULL OR check_out_accuracy_m IS NOT NULL)`;

const MEDICAL_WHERE = `leave_id IN (SELECT id FROM org.leave_requests WHERE end_date < $1::date)`;

/** The only place the privacy feature touches the database. */
export const createPrivacyRepository = (db: DbClient) => ({
  latestAcceptance: async (
    employeeId: string,
  ): Promise<{ version: string; accepted_at: Date } | undefined> => {
    const rows = await db.query<{ version: string; accepted_at: Date }>(
      `SELECT version, accepted_at FROM org.privacy_acceptances
        WHERE employee_id = $1 ORDER BY accepted_at DESC LIMIT 1`,
      [employeeId],
    );
    return rows[0];
  },

  hasAccepted: async (employeeId: string, version: string): Promise<boolean> => {
    const rows = await db.query(
      `SELECT 1 FROM org.privacy_acceptances WHERE employee_id = $1 AND version = $2`,
      [employeeId, version],
    );
    return rows.length > 0;
  },

  /** Record the acceptance + its audit row together; accepting twice is a no-op. */
  accept: (employeeId: string, version: string, actorUserId: string) =>
    db.transaction(async (tx) => {
      const rows = await tx.query<{ id: string }>(
        `INSERT INTO org.privacy_acceptances (employee_id, version)
         VALUES ($1, $2) ON CONFLICT (employee_id, version) DO NOTHING RETURNING id`,
        [employeeId, version],
      );
      if (rows.length > 0) {
        await tx.query(
          `INSERT INTO access.audit_log (actor_user_id, action, subject, detail)
           VALUES ($1, 'privacy.accepted', $2, $3)`,
          [actorUserId, `employees:${employeeId}`, JSON.stringify({ version })],
        );
      }
    }),

  /**
   * Audit a read of someone else's sensitive record. Append-only, outside any
   * transaction: the read already happened, the row just records who looked.
   */
  recordSensitiveRead: async (input: {
    actorUserId: string;
    subjectEmployeeId: string;
    what: SensitiveRead;
    ref?: string;
  }): Promise<void> => {
    await db.query(
      `INSERT INTO access.audit_log (actor_user_id, action, subject, detail)
       VALUES ($1, 'sensitive.read', $2, $3)`,
      [
        input.actorUserId,
        `employees:${input.subjectEmployeeId}`,
        JSON.stringify({ what: input.what, ...(input.ref ? { ref: input.ref } : {}) }),
      ],
    );
  },

  payslipOwner: async (payslipId: string): Promise<string | undefined> => {
    const rows = await db.query<{ employee_id: string }>(
      `SELECT employee_id FROM org.payslips WHERE id = $1`,
      [payslipId],
    );
    return rows[0]?.employee_id;
  },

  leaveOwner: async (leaveId: string): Promise<string | undefined> => {
    const rows = await db.query<{ employee_id: string }>(
      `SELECT employee_id FROM org.leave_requests WHERE id = $1`,
      [leaveId],
    );
    return rows[0]?.employee_id;
  },

  /**
   * "Download my data": every section is keyed to the caller's own id — no
   * other person's record is read. File BYTES are never included, only their
   * names and dates (the files stay downloadable one by one in the app).
   */
  exportFor: async (employeeId: string): Promise<Record<string, unknown>> => {
    const q = (sql: string) => db.query(sql, [employeeId]);
    const [
      profile,
      salary,
      leaveBalances,
      leaves,
      attendance,
      remoteWork,
      payslips,
      claims,
      loans,
      goals,
      workUpdates,
      trainings,
      awards,
      policyAcks,
      assets,
      exits,
      documents,
      privacy,
    ] = await Promise.all([
      q(`SELECT e.employee_code, e.name, e.salutation, e.first_name, e.middle_name, e.last_name,
                e.email, e.phone, e.personal_email, e.preferred_contact_email, e.gender,
                e.date_of_birth, e.current_address, e.permanent_address, e.designation,
                e.level, e.employment_type, e.status, e.date_of_joining, e.confirmation_date,
                e.notice_days, d.name AS department, m.name AS reporting_manager,
                la.name AS leave_approver, e.work_start, e.work_end, e.created_at
           FROM org.employees e
           LEFT JOIN org.departments d ON d.id = e.department_id
           LEFT JOIN org.employees m ON m.id = e.reports_to
           LEFT JOIN org.employees la ON la.id = e.leave_approver
          WHERE e.id = $1`),
      q(`SELECT ctc, salary_currency, salary_mode, basic_percent, hra_percent, variable_pay,
                pan_number, uan_number, provident_fund_account, esic_ip_number, bank_name,
                bank_account_no, ifsc_code, updated_at
           FROM org.employee_salary WHERE employee_id = $1`),
      q(`SELECT type, year, opening, allocated, used FROM org.leave_balances
          WHERE employee_id = $1 ORDER BY year, type`),
      q(`SELECT type, start_date, end_date, day_part, days, reason, status, decision_reason,
                decided_at, created_at
           FROM org.leave_requests WHERE employee_id = $1 ORDER BY start_date`),
      q(`SELECT date, check_in_at, check_out_at, source, check_in_lat, check_in_lng,
                check_out_lat, check_out_lng, check_in_accuracy_m, check_out_accuracy_m
           FROM org.attendance WHERE employee_id = $1 ORDER BY date`),
      q(`SELECT type, start_date, end_date, reason, status, decision_reason, decided_at, created_at
           FROM org.wfh_requests WHERE employee_id = $1 ORDER BY start_date`),
      // Published slips only — a draft run is not yet the person's payslip.
      q(`SELECT r.month, r.status AS run_status, p.monthly_gross, p.earnings_total,
                p.deductions_total, p.net_pay, p.lop_days, p.pf, p.tds, p.professional_tax
           FROM org.payslips p JOIN org.payroll_runs r ON r.id = p.run_id
          WHERE p.employee_id = $1 AND r.status IN ('finalized', 'paid')
          ORDER BY r.month`),
      q(`SELECT spent_on, category, description, amount, status, decline_reason, paid_on,
                created_at
           FROM org.reimbursement_claims WHERE employee_id = $1 ORDER BY spent_on`),
      q(`SELECT kind, principal, interest_rate_pct, months, start_month, emi, status, created_at
           FROM org.loans WHERE employee_id = $1 ORDER BY created_at`),
      q(`SELECT title, category, metric, target, weight, progress, due_on, created_at
           FROM org.goals WHERE employee_id = $1 ORDER BY created_at`),
      q(`SELECT date, note, score, feedback, created_at
           FROM org.work_updates WHERE employee_id = $1 ORDER BY date`),
      q(`SELECT title, stream, status, due_on, assigned_at, completed_at, completion_note
           FROM org.trainings WHERE employee_id = $1 ORDER BY assigned_at`),
      q(`SELECT award_name, type, citation, value_inr, status, cycle, created_at
           FROM org.recognitions WHERE employee_id = $1 AND status = 'approved'
          ORDER BY created_at`),
      q(`SELECT p.title AS policy, a.version, a.acked_at
           FROM org.policy_acks a JOIN org.policies p ON p.id = a.policy_id
          WHERE a.employee_id = $1 ORDER BY a.acked_at`),
      q(`SELECT asset_code, name, make, model, serial_no, loan_due_on
           FROM ops.assets WHERE holder_id = $1 ORDER BY asset_code`),
      q(`SELECT kind, status, reason, notice_start_on, last_working_day, relieved_at, created_at
           FROM org.exits WHERE employee_id = $1 ORDER BY created_at`),
      q(`SELECT 'leave_certificate' AS kind, c.file_name, c.content_type, c.size_bytes, c.uploaded_at
           FROM org.leave_certificates c JOIN org.leave_requests l ON l.id = c.leave_id
          WHERE l.employee_id = $1
         UNION ALL
         SELECT 'claim_receipt', r.file_name, r.content_type, r.size_bytes, r.uploaded_at
           FROM org.claim_receipts r JOIN org.reimbursement_claims c ON c.id = r.claim_id
          WHERE c.employee_id = $1
         UNION ALL
         SELECT 'training_certificate', t.file_name, t.content_type, t.size_bytes, t.uploaded_at
           FROM org.training_certificates t JOIN org.trainings tr ON tr.id = t.training_id
          WHERE tr.employee_id = $1
         ORDER BY 5`),
      q(`SELECT version, accepted_at FROM org.privacy_acceptances
          WHERE employee_id = $1 ORDER BY accepted_at`),
    ]);
    return {
      profile: profile[0] ?? null,
      salaryAndBank: salary[0] ?? null,
      leaveBalances,
      leaves,
      attendance,
      remoteWork,
      payslips,
      expenseClaims: claims,
      loans,
      goals,
      workUpdates,
      trainings,
      awards,
      policyAcknowledgements: policyAcks,
      assetsInYourCustody: assets,
      exit: exits,
      documents,
      privacyAcceptances: privacy,
    };
  },

  // ── Retention (report M12) ────────────────────────────────────────────────

  retentionCounts: async (c: RetentionCutoffs) => {
    const [gps, medical, ex] = await Promise.all([
      db.query<{ n: string }>(
        `SELECT count(*) AS n FROM org.attendance WHERE ${GPS_WHERE}`,
        [c.gps],
      ),
      db.query<{ n: string }>(
        `SELECT count(*) AS n FROM org.leave_certificates WHERE ${MEDICAL_WHERE}`,
        [c.medical],
      ),
      db.query<{ n: string }>(
        `SELECT count(*) AS n FROM org.employees e WHERE ${EX_EMPLOYEE_WHERE}`,
        [c.exEmployee],
      ),
    ]);
    return {
      punchLocations: Number(gps[0]?.n ?? 0),
      medicalCertificates: Number(medical[0]?.n ?? 0),
      exEmployeeContactRecords: Number(ex[0]?.n ?? 0),
    };
  },

  /** Remove everything past retention, with one audit row of the counts. */
  purge: (c: RetentionCutoffs) =>
    db.transaction(async (tx) => {
      const gps = await tx.query(
        `UPDATE org.attendance
            SET check_in_lat = NULL, check_in_lng = NULL, check_out_lat = NULL,
                check_out_lng = NULL, check_in_accuracy_m = NULL, check_out_accuracy_m = NULL
          WHERE ${GPS_WHERE} RETURNING id`,
        [c.gps],
      );
      const medical = await tx.query(
        `DELETE FROM org.leave_certificates WHERE ${MEDICAL_WHERE} RETURNING id, drive_file_id`,
        [c.medical],
      );
      const ex = await tx.query(
        `UPDATE org.employees e
            SET ${EX_EMPLOYEE_CONTACT_FIELDS.map((f) => `${f} = NULL`).join(', ')},
                updated_at = now()
          WHERE ${EX_EMPLOYEE_WHERE} RETURNING e.id`,
        [c.exEmployee],
      );
      const counts = {
        punchLocations: gps.length,
        medicalCertificates: medical.length,
        exEmployeeContactRecords: ex.length,
      };
      if (
        counts.punchLocations +
        counts.medicalCertificates +
        counts.exEmployeeContactRecords
      ) {
        await tx.query(
          `INSERT INTO access.audit_log (actor_user_id, action, subject, detail)
           VALUES (NULL, 'privacy.purged', 'retention', $1)`,
          [JSON.stringify({ ...counts, cutoffs: c })],
        );
      }
      // Drive copies of deleted certificates are trashed by the service after commit.
      const driveFileIds = (medical as Array<{ drive_file_id: string | null }>)
        .map((r) => r.drive_file_id)
        .filter((id): id is string => Boolean(id));
      return { counts, driveFileIds };
    }),
});

export type PrivacyRepository = ReturnType<typeof createPrivacyRepository>;
