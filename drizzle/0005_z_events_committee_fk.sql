-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0005 — Add the missing events.committee_id → committees.id FK
--
-- The original schema declared events.committee_id as NOT NULL but never
-- attached the actual REFERENCES constraint. That left a gap: SQL editors
-- (or future code paths) could insert events pointing at non-existent
-- committee ids, or hard-delete a committee from under a referencing event.
--
-- ON DELETE RESTRICT mirrors the app-level guard in
-- server/routes/admin/committees.ts so the DB and the API agree.
--
-- Safe to re-run: drops + recreates the constraint by a stable name.
-- Will FAIL if any current event rows reference a non-existent committee —
-- run the diagnostic block first to find them.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Diagnostic: any orphaned event rows? ───────────────────────────────
-- Run this first. If it returns rows, fix or delete them before continuing
-- (the FK creation will fail otherwise).
DO $$
DECLARE
  orphan_count int;
BEGIN
  SELECT COUNT(*) INTO orphan_count
  FROM events e
  WHERE e.committee_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM committees c WHERE c.id = e.committee_id);
  IF orphan_count > 0 THEN
    RAISE EXCEPTION 'Cannot add FK: % event row(s) reference a non-existent committee_id. Fix them first.', orphan_count;
  END IF;
END $$;

-- ─── 2. Add the FK constraint ──────────────────────────────────────────────
ALTER TABLE "events"
  DROP CONSTRAINT IF EXISTS "events_committee_id_fk";

ALTER TABLE "events"
  ADD CONSTRAINT "events_committee_id_fk"
  FOREIGN KEY ("committee_id") REFERENCES "committees"("id")
  ON DELETE RESTRICT
  ON UPDATE NO ACTION;

-- ─── 3. Helpful index for the join direction ──────────────────────────────
-- The reverse direction (committees → events) is exercised by the admin
-- committees list endpoint (which counts events per committee). An index
-- on events(committee_id) keeps that scan fast.
CREATE INDEX IF NOT EXISTS "idx_events_committee_id" ON "events"("committee_id");
