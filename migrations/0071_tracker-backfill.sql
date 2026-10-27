-- Candidates added before 2026-10-27 get their readable ID (C-000001, …), oldest
-- first; positions take their line's priority.
UPDATE ta.candidates c
   SET candidate_code = 'C-' || lpad(nextval('ta.candidate_code_seq')::text, 6, '0')
  FROM (SELECT id FROM ta.candidates WHERE candidate_code IS NULL ORDER BY created_at) o
 WHERE o.id = c.id;
--> statement-breakpoint
UPDATE ta.positions p SET priority = r.priority
  FROM ta.requisitions r
 WHERE r.id = p.requisition_id;
