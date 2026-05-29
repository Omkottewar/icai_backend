-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0004 (companion) — Event checklists: indexes + triggers
--
-- Pair this with 0004_lumpy_klaw.sql (drizzle-generated). That file creates
-- the enums, tables, and FKs; this one adds the indexes and the two triggers
-- that make the workflow self-healing (auto-publish + updated_at).
--
-- Safe to re-run: indexes/triggers use IF NOT EXISTS / DROP IF EXISTS.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Indexes ─────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS "idx_event_checklists_status"
  ON "event_checklists"("status");

CREATE INDEX IF NOT EXISTS "idx_event_checklist_items_checklist"
  ON "event_checklist_items"("checklist_id");

CREATE INDEX IF NOT EXISTS "idx_event_checklist_reviews_checklist"
  ON "event_checklist_reviews"("checklist_id");

-- ─── 2. Auto-publish trigger ───────────────────────────────────────────────
-- When the checklist transitions to 'approved', flip the event status to
-- 'published' and stamp finalized_at. Single source of truth so the API
-- doesn't have to remember.
CREATE OR REPLACE FUNCTION "auto_publish_event_on_checklist_approval"() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'approved' AND (OLD.status IS DISTINCT FROM 'approved') THEN
    UPDATE "events"
      SET "status" = 'published', "updated_at" = now()
      WHERE "id" = NEW.event_id
        AND "status" <> 'cancelled';
    NEW.finalized_at := COALESCE(NEW.finalized_at, now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_auto_publish_event_on_checklist_approval" ON "event_checklists";
CREATE TRIGGER "trg_auto_publish_event_on_checklist_approval"
  BEFORE UPDATE ON "event_checklists"
  FOR EACH ROW EXECUTE FUNCTION "auto_publish_event_on_checklist_approval"();

-- ─── 3. updated_at maintenance ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION "touch_event_checklist_updated_at"() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_touch_event_checklist_updated_at" ON "event_checklists";
CREATE TRIGGER "trg_touch_event_checklist_updated_at"
  BEFORE UPDATE ON "event_checklists"
  FOR EACH ROW EXECUTE FUNCTION "touch_event_checklist_updated_at"();
