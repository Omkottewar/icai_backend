-- ─── 0063 — Convert partial unique index on checklist_instance_responses ──
--
-- Background: migration 0053 created a partial unique index
--   ux_checklist_responses_instance_iquestion
--   ON (instance_id, instance_question_id)
--   WHERE instance_question_id IS NOT NULL
-- to allow legacy NULL rows alongside new non-NULL rows during the
-- backfill window.
--
-- Drizzle's onConflictDoUpdate({ target: [...] }) doesn't pass the WHERE
-- predicate to Postgres, so every PUT /responses INSERT now throws:
--   "there is no unique or exclusion constraint matching the ON CONFLICT
--    specification"
--
-- Fix: drop the partial index and recreate as a non-partial unique index.
-- All rows now have a non-NULL instance_question_id (verified post-0053
-- backfill + every new row sets it), so the index is safe.
--
-- We also drop the OLDER partial index on (instance_id, question_id) since
-- that column is fully deprecated post-0053 and no caller targets it.

DROP INDEX IF EXISTS "ux_checklist_responses_instance_iquestion";
DROP INDEX IF EXISTS "ux_checklist_responses_instance_question";

-- New canonical unique index — non-partial so Drizzle's ON CONFLICT
-- inference finds it.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_checklist_responses_instance_iquestion"
  ON "checklist_instance_responses" ("instance_id", "instance_question_id");
