-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0087 — Remove CPE tracking
--
-- The ICAI CPE API is no longer available to us, and without a way to
-- publish credits back to ICAI's central register the branch's own
-- CPE ledger is misleading (members would think their hours are counted
-- when they aren't). The safer thing is to remove the whole feature
-- until the upstream API returns.
--
-- What goes:
--   • cpe_credits table (the ledger)
--   • events.cpe_hours column (per-event hour attribution)
--   • cpe_type enum ('structured' / 'unstructured')
--   • cpe_credit_awarded notification template
--   • cpe_certificate value from doc_locker_type enum (safe: never used
--     outside the cpeCredits.certificate_file_id column that we're dropping)
--
-- What stays:
--   • Event attendance certificates — the PDF generator drops the
--     "CPE hours" line but still produces attendance certs.
--   • events.gst_applicable / gst_percent — orthogonal to CPE.
--
-- CASCADE drops any leftover FKs (users→cpe_credits, events→cpe_credits,
-- files→certificate_file_id). Safe to re-run: uses IF EXISTS.
-- ════════════════════════════════════════════════════════════════════════════

-- Step 1: drop the ledger table. FKs on cpe_credits itself go with it.
DROP TABLE IF EXISTS "cpe_credits" CASCADE;

-- Step 2: drop the per-event hours column. Removed with IF EXISTS so a
-- re-run after schema drift is silent.
ALTER TABLE "events"
  DROP COLUMN IF EXISTS "cpe_hours";

-- Step 2b: resource_quizzes had a `cpe_credit_minutes` column used to
-- award "unstructured CPE" for passing a paper's quiz. That path went
-- away with the rest of CPE tracking. The quizzes themselves still work
-- as a comprehension check — they just no longer award hours.
ALTER TABLE "resource_quizzes"
  DROP COLUMN IF EXISTS "cpe_credit_minutes";

-- Step 2c: some resource_quiz_attempts installs also carried the earned
-- minutes on the attempt row. Drop it if present; harmless if not.
ALTER TABLE "resource_quiz_attempts"
  DROP COLUMN IF EXISTS "cpe_credit_minutes";

-- Step 3: drop the cpe_type enum. Only cpe_credits.type referenced it,
-- which we just dropped. CASCADE catches any residual dependents.
DROP TYPE IF EXISTS "cpe_type" CASCADE;

-- Step 4: retire the notification templates. Uses UPDATE, not DELETE, so
-- any delivery rows referencing these keys keep working (they hold the
-- rendered subject/body inline). `enabled = false` stops future dispatches;
-- the deprecation note documents why for the next maintainer.
UPDATE "notification_templates"
   SET "enabled" = false,
       "description" = coalesce("description", '') || ' [deprecated: CPE feature removed 2026-07 — migration 0087]'
 WHERE "key" IN ('cpe_credit_awarded');

-- Step 5: strip "CPE hours will be credited" line from the event_registered
-- template. notification_templates uses email_body and inapp_body — no
-- generic 'body' column exists on that table. We rewrite in place rather
-- than deleting the whole template because event_registered is still in
-- active use for confirmations.
UPDATE "notification_templates"
   SET "email_body" = regexp_replace(
         coalesce("email_body", ''),
         '\s*\{\{cpe_hours\}\}[^\n]*CPE[^\n]*\n?',
         '',
         'g'
       ),
       "inapp_body" = regexp_replace(
         coalesce("inapp_body", ''),
         '\s*\{\{cpe_hours\}\}[^\n]*CPE[^\n]*\n?',
         '',
         'g'
       )
 WHERE "key" = 'event_registered';
