-- TA change (2026-10-26): the TA head seat is retired — Admin gives each
-- approved hiring line to a TA RM instead. End any open TA head tenure (rows
-- are ended, never deleted, so the history stays).
UPDATE org.seats
   SET ended_at = now(), ended_reason = 'TA head seat retired'
 WHERE seat = 'ta_head' AND ended_at IS NULL;
