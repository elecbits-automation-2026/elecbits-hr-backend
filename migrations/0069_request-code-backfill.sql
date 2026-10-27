-- Give the hiring lines made before 2026-10-27 their readable Hiring Request ID
-- (HR-<quarter>-0001, …), oldest first, from the same sequence new lines use.
UPDATE ta.requisitions r
   SET request_code = 'HR-' || coalesce(replace(p.quarter, '-', ''), 'URGENT') || '-' ||
                      lpad(nextval('ta.requisition_code_seq')::text, 4, '0')
  FROM (SELECT r2.id, hp.quarter
          FROM ta.requisitions r2
          LEFT JOIN ta.hiring_plans hp ON hp.id = r2.plan_id
         WHERE r2.request_code IS NULL
         ORDER BY r2.created_at) p
 WHERE p.id = r.id;
