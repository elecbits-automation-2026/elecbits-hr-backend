-- PIPs start active, with no HR approval (learner, 2026-11-05). Any PIP still
-- waiting for HR starts now (or on its own later start date) and runs 60 days.
INSERT INTO access.audit_log (actor_user_id, action, subject, detail)
SELECT NULL, 'pip.approved', 'pips:' || p.id,
       json_build_object('reason', 'HR approval step removed')::text
  FROM org.pips p WHERE p.status = 'pending_hr';--> statement-breakpoint
UPDATE org.pips
   SET status = 'active',
       start_on = greatest(start_on, current_date),
       end_on = greatest(start_on, current_date) + 60,
       updated_at = now()
 WHERE status = 'pending_hr';
