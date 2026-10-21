-- Accounts claimed before the invited -> active flip existed (auth.repository
-- insertUser now does it in the claim transaction) were left as 'invited'.
-- A users row existing IS the definition of claimed (§5.4), so flip them.
UPDATE "org"."employees" e
   SET "status" = 'active', "updated_at" = now()
 WHERE e."status" = 'invited'
   AND EXISTS (SELECT 1 FROM "public"."users" u WHERE u."employee_id" = e."id");
