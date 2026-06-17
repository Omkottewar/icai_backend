-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0034 — Starter templates flag
--
-- Adds `is_starter` to checklist_templates so the admin UI can show curated,
-- ready-to-use templates (CPE Seminar, Workshop, etc.) on the "+ New template"
-- screen. The user clicks one, the row is cloned into a fresh family they
-- own, and they're dropped into the builder with everything pre-filled —
-- collapsing the create flow from ~15 clicks to 2 for the common case.
--
-- Starters themselves are hidden from the main list (GET /), surfaced via
-- the dedicated /starters endpoint, and never editable in place — they're
-- read-only system rows that always sit at version 1, is_published = true.
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "checklist_templates"
  ADD COLUMN IF NOT EXISTS "is_starter" boolean NOT NULL DEFAULT false;

-- Partial index — only a handful of starter rows ever, but lookups happen
-- on every "new template" click.
CREATE INDEX IF NOT EXISTS "idx_checklist_templates_starter"
  ON "checklist_templates" ("is_starter") WHERE "is_starter" = true;
