-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0009 — Performance indexes for the admin panel
--
-- The admin pages issue filtered + paginated queries against events, users,
-- and committees. Without indexes on the filter columns Postgres falls back
-- to sequential scans + sorts.
--
-- Partial indexes "WHERE deleted_at IS NULL" mirror the actual query pattern
-- (admin lists always exclude soft-deleted rows) and keep the indexes small.
--
-- All idempotent.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── EVENTS admin list ─────────────────────────────────────────────────────
-- Filters used: status, committee_id, ILIKE on title. Sort: starts_at DESC.

-- Status filter (admin events page, "All / Draft / Published / …")
CREATE INDEX IF NOT EXISTS "idx_events_status_active"
  ON "events"("status")
  WHERE "deleted_at" IS NULL;

-- Sort + soft-delete combo (covers ORDER BY starts_at DESC with the filter)
CREATE INDEX IF NOT EXISTS "idx_events_starts_at_active"
  ON "events"("starts_at" DESC)
  WHERE "deleted_at" IS NULL;

-- Committee + start time composite (the existing events_committee_starts_idx
-- from migration 0001 should already exist — guard just in case)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public' AND indexname = 'events_committee_starts_idx'
  ) THEN
    CREATE INDEX "events_committee_starts_idx" ON "events"("committee_id", "starts_at");
  END IF;
END $$;

-- ─── USERS admin list ──────────────────────────────────────────────────────
-- Filters: primary_role, status. Search: ILIKE on name/email. Sort: created_at DESC.

CREATE INDEX IF NOT EXISTS "idx_users_primary_role_active"
  ON "users"("primary_role")
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_users_status_active"
  ON "users"("status")
  WHERE "deleted_at" IS NULL;

CREATE INDEX IF NOT EXISTS "idx_users_created_at_active"
  ON "users"("created_at" DESC)
  WHERE "deleted_at" IS NULL;

-- Email lookup is the hottest single-row read (signup, /me, admin lookup).
-- "users.email" already has a UNIQUE constraint which creates an index, but
-- a case-insensitive index would help the LOWER(email) lookups in
-- promote-admin.mjs and similar tools.
CREATE INDEX IF NOT EXISTS "idx_users_email_lower"
  ON "users"(LOWER("email"));

-- ─── EVENT REGISTRATIONS admin list ────────────────────────────────────────
-- Filters: status. Sort: registered_at DESC. event_id already indexed.
CREATE INDEX IF NOT EXISTS "idx_registrations_status_active"
  ON "event_registrations"("status")
  WHERE "deleted_at" IS NULL;

-- ─── COMMITTEES admin list ─────────────────────────────────────────────────
-- Filter: active. Sort: name ASC. Small table; indexes are still cheap.
CREATE INDEX IF NOT EXISTS "idx_committees_active_name"
  ON "committees"("active", "name");

-- ─── USER_ROLE_ASSIGNMENTS — admin "active roles per user" lookup ──────────
-- The /api/admin/users list endpoint batch-fetches active assignments for
-- every user on the current page (via WHERE user_id = ANY(...) + active).
-- Composite index speeds this.
CREATE INDEX IF NOT EXISTS "idx_ura_user_active_filtered"
  ON "user_role_assignments"("user_id", "role_id")
  WHERE "effective_to" IS NULL;

-- ─── Refresh planner statistics ────────────────────────────────────────────
ANALYZE "events";
ANALYZE "users";
ANALYZE "event_registrations";
ANALYZE "committees";
ANALYZE "user_role_assignments";
