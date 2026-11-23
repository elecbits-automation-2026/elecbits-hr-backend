-- Remote work is approved by the RM alone (learner, 2026-11-05). Requests
-- left half-way by the old RM + HR flow: the RM already approved → approved;
-- only HR approved → back to waiting on the RM.
-- status is compared as text: 'partially_approved' is added by 0011, and on a
-- fresh database every pending migration runs in ONE transaction, where
-- Postgres refuses an enum value added in the same transaction (C4, 23 Nov).
UPDATE org.wfh_requests
   SET status = 'approved', decided_at = coalesce(rm_approved_at, now())
 WHERE status::text = 'partially_approved' AND rm_approved_by IS NOT NULL;--> statement-breakpoint
UPDATE org.wfh_requests
   SET status = 'pending'
 WHERE status::text = 'partially_approved';
