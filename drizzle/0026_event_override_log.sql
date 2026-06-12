-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0026 — event_override_log + approval escalation column
--
-- Three changes packaged together (all related to the approvals workflow):
--
--   1. event_override_log table — records every time a chairman/VC clicks
--      the inline /publish "override" path on an event whose checklist
--      isn't fully approved. Captures who, when, why, and a JSON snapshot
--      of the approval stage states at the moment of override.
--
--   2. escalated_at column on checklist_instance_approvals — used by the
--      escalation cron to deduplicate sends. NULL = not yet escalated;
--      timestamp = the cron has already mailed the chairperson, don't spam.
--
--   3. checklist_instance_action enum gains 'rejected_final' — for the new
--      "reject completely" action that cancels the linked event.
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "event_override_log" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"         uuid NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "actor_id"         uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "acted_at"         timestamptz NOT NULL DEFAULT now(),
  "reason"           text,
  "checklist_state"  jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS "event_override_log_event_idx"
  ON "event_override_log" ("event_id");
CREATE INDEX IF NOT EXISTS "event_override_log_actor_idx"
  ON "event_override_log" ("actor_id");

-- ─── escalation dedup column ─────────────────────────────────────────────
ALTER TABLE "checklist_instance_approvals"
  ADD COLUMN IF NOT EXISTS "escalated_at" timestamptz;

-- ─── extend enum with 'rejected_final' ──────────────────────────────────
-- Wrapped in DO $$ so re-running on a DB that already has the value is a
-- no-op rather than an error.
DO $$ BEGIN
  ALTER TYPE "checklist_instance_action" ADD VALUE IF NOT EXISTS 'rejected_final';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
