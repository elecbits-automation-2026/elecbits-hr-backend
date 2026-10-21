-- Leave policy v1 (19 Feb 2026) data alignment:
-- sick quota drops 12 -> 6; never below what is already used.
UPDATE org.leave_balances
   SET allocated = GREATEST(LEAST(allocated, 6), used)
 WHERE type = 'sick';--> statement-breakpoint
-- Earned rows keep their allocation; the lazy accrual only ever raises it and
-- the 30-day effective cap is applied at read/approval time.
-- Casual rows stay untouched as history (the type is no longer raisable).
SELECT 1;
