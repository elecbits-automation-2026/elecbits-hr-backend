-- Onboarding rework (learner, 2026-11-05), applied to journeys still open:
-- only the Code of Conduct is acknowledged — the handbook step goes (unless
-- it was already done, which stays as history);
DELETE FROM org.onboarding_tasks t
 USING org.onboarding_journeys j
 WHERE j.id = t.journey_id AND j.status = 'open'
   AND t.task_key = 'handbook' AND t.done_at IS NULL;--> statement-breakpoint
-- OPS decides and issues the joiner's assets (no designation kit any more);
UPDATE org.onboarding_tasks t SET title = 'Assets decided and issued — OPS'
  FROM org.onboarding_journeys j
 WHERE j.id = t.journey_id AND j.status = 'open' AND t.task_key = 'kit';--> statement-breakpoint
-- the signed offer letter is uploaded by HR;
UPDATE org.onboarding_tasks t SET title = 'Signed offer letter uploaded — HR'
  FROM org.onboarding_journeys j
 WHERE j.id = t.journey_id AND j.status = 'open' AND t.task_key = 'offer';--> statement-breakpoint
-- the account step completes by itself when the account is claimed.
UPDATE org.onboarding_tasks t SET title = 'HRMS account claimed'
  FROM org.onboarding_journeys j
 WHERE j.id = t.journey_id AND j.status = 'open' AND t.task_key = 'claim';
