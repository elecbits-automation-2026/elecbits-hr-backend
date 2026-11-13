-- Reimbursements move off the RM and the payslip (learner, 2026-11-05):
-- claims still waiting on an RM go to PR;
UPDATE org.reimbursement_claims
   SET status = 'pending_payroll', updated_at = now()
 WHERE status = 'pending_rm';--> statement-breakpoint
-- open draft payslips drop the approved claims they were carrying (those
-- claims stay `approved` and are paid from the reimbursement sheet).
UPDATE org.payslips p
   SET final_pay = p.final_pay - p.reimbursement, reimbursement = 0, updated_at = now()
  FROM org.payroll_runs r
 WHERE p.run_id = r.id AND r.status = 'draft' AND p.reimbursement <> 0;
