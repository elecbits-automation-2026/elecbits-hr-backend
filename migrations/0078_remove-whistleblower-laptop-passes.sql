-- Quick removals (learner, 2026-11-05).
-- 1. The whistleblower section is gone: its access module (hrbp.vigil) and
--    any grants of it go too, each removal logged as a system action.
INSERT INTO access.audit_log (actor_user_id, action, subject, detail)
SELECT NULL, 'batch.grant.removed', 'batches:' || bg.batch_id,
       json_build_object('moduleKey', bg.module_key, 'action', bg.action, 'scope', bg.scope,
                         'reason', 'whistleblower section removed')::text
  FROM access.batch_grants bg WHERE bg.module_key = 'hrbp.vigil';--> statement-breakpoint
INSERT INTO access.audit_log (actor_user_id, action, subject, detail)
SELECT NULL, 'grant.individual.removed', 'employees:' || ig.employee_id,
       json_build_object('moduleKey', ig.module_key, 'action', ig.action, 'scope', ig.scope,
                         'reason', 'whistleblower section removed')::text
  FROM access.individual_grants ig WHERE ig.module_key = 'hrbp.vigil';--> statement-breakpoint
DELETE FROM access.batch_grants WHERE module_key = 'hrbp.vigil';--> statement-breakpoint
DELETE FROM access.individual_grants WHERE module_key = 'hrbp.vigil';--> statement-breakpoint
DELETE FROM access.modules WHERE key = 'hrbp.vigil';--> statement-breakpoint
-- 2. No gate passes for issued equipment such as laptops: only lent (lab)
--    categories may keep the flag.
UPDATE ops.asset_categories SET requires_gate_pass = false
 WHERE kind <> 'lab' AND requires_gate_pass;
