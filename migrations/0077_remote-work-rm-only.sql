-- Remote work is approved by the RM alone (learner, 2026-11-05). Requests
-- left half-way by the old RM + HR flow: the RM already approved → approved;
-- only HR approved → back to waiting on the RM.
UPDATE org.wfh_requests
   SET status = 'approved', decided_at = coalesce(rm_approved_at, now())
 WHERE status = 'partially_approved' AND rm_approved_by IS NOT NULL;--> statement-breakpoint
UPDATE org.wfh_requests
   SET status = 'pending'
 WHERE status = 'partially_approved';
