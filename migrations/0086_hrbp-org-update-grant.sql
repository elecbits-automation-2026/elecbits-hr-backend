-- Departments page (learner, 2026-11-16): HR renames and moves units, sets
-- department heads and manages memberships, which needs `update` on
-- hrbp.org. The HRBP baseline role gains it (each addition logged as a
-- system action); Admin can still tune it under Roles & access.
INSERT INTO access.audit_log (actor_user_id, action, subject, detail)
SELECT NULL, 'batch.grant.added', 'batches:' || b.id,
       json_build_object('moduleKey', 'hrbp.org', 'action', 'update', 'scope', 'org',
                         'reason', 'departments page')::text
  FROM access.batches b
 WHERE b.name = 'HRBP'
   AND NOT EXISTS (SELECT 1 FROM access.batch_grants bg
                    WHERE bg.batch_id = b.id AND bg.module_key = 'hrbp.org'
                      AND bg.action = 'update' AND bg.scope = 'org');--> statement-breakpoint
INSERT INTO access.batch_grants (batch_id, module_key, action, scope)
SELECT b.id, 'hrbp.org', 'update', 'org' FROM access.batches b WHERE b.name = 'HRBP'
ON CONFLICT DO NOTHING;
