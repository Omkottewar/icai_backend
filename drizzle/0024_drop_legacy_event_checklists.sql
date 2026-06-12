-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0024 — Drop legacy event_checklists tables and their enums
--
-- The legacy checklist tables were created in migration 0004 and
-- soft-deprecated in 2026-06 in favour of the generic checklist_instances
-- engine (migrations 0011-0013). The sunset window was scheduled for
-- 2026-09-04 but we're pulling it in: the legacy system is the single
-- biggest source of UX confusion (two parallel state machines, two pages,
-- two dashboard badges) and there are no in-flight rows worth preserving.
--
-- This migration drops:
--   • Triggers   auto_publish_event_on_checklist_approval, touch_event_checklist_updated_at
--   • Tables     event_checklist_reviews, event_checklist_items, event_checklists
--   • Enums      event_checklist_action, event_checklist_item_kind, event_checklist_status
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- Drop dependent triggers + functions first (CASCADE on the tables would
-- otherwise leave the functions behind).
DROP TRIGGER IF EXISTS "trg_event_checklist_touch_updated_at" ON "event_checklists";
DROP TRIGGER IF EXISTS "trg_event_checklist_auto_publish"     ON "event_checklists";
DROP FUNCTION IF EXISTS "touch_event_checklist_updated_at"() CASCADE;
DROP FUNCTION IF EXISTS "auto_publish_event_on_checklist_approval"() CASCADE;

-- Tables — drop in dependency order (children first).
DROP TABLE IF EXISTS "event_checklist_reviews" CASCADE;
DROP TABLE IF EXISTS "event_checklist_items"   CASCADE;
DROP TABLE IF EXISTS "event_checklists"        CASCADE;

-- Enums become unused once the tables are gone.
DROP TYPE IF EXISTS "event_checklist_action";
DROP TYPE IF EXISTS "event_checklist_item_kind";
DROP TYPE IF EXISTS "event_checklist_status";
