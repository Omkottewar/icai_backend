-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0008 — Performance indexes for hot lookup paths
--
-- Issues this fixes:
--   • user_role_assignments has no index on (user_id) — every permission check
--     was doing a sequential scan. Three calls per request × N requests = pain.
--   • forum_threads/forum_posts created_by lookups (for "my threads", deletion
--     auth) had no covering index.
--   • events(created_by) lookups had none.
--
-- All idempotent.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── Hot path: role lookups by user_id ─────────────────────────────────────
-- Composite covers WHERE user_id = ? AND (effective_to IS NULL OR ...).
-- Partial: most queries only care about active assignments.
CREATE INDEX IF NOT EXISTS "idx_ura_user_active"
  ON "user_role_assignments"("user_id")
  WHERE "effective_to" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_ura_user_all"
  ON "user_role_assignments"("user_id");

-- ─── Hot path: "my threads" / authorship checks ────────────────────────────
CREATE INDEX IF NOT EXISTS "idx_forum_threads_author"
  ON "forum_threads"("created_by")
  WHERE "deleted_at" IS NULL;

-- ─── Hot path: events created_by (for admin "my events" later) ─────────────
CREATE INDEX IF NOT EXISTS "idx_events_created_by"
  ON "events"("created_by")
  WHERE "deleted_at" IS NULL;

-- ─── Hot path: registration aggregates per event ───────────────────────────
-- Branch metrics counts registrations per event/per committee.
CREATE INDEX IF NOT EXISTS "idx_registrations_event_active"
  ON "event_registrations"("event_id")
  WHERE "deleted_at" IS NULL;

-- ─── Hot path: checklist by status (dashboard widgets) ─────────────────────
-- Already added in 0004 as idx_event_checklists_status — confirm presence.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'idx_event_checklists_status'
  ) THEN
    CREATE INDEX "idx_event_checklists_status" ON "event_checklists"("status");
  END IF;
END $$;

-- ─── Refresh planner statistics on touched tables ──────────────────────────
ANALYZE "user_role_assignments";
ANALYZE "forum_threads";
ANALYZE "events";
ANALYZE "event_registrations";
ANALYZE "event_checklists";
