-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0010 — Editable site content (lightweight in-app CMS)
--
-- Two tables back the admin-editable content surface:
--   • site_content  — named slots with typed JSON payloads, one row per slot
--                     (chairman_message, about_vision, home_hero, …)
--   • site_settings — flat key/value strings (branch_phone, footer_disclaimer, …)
--
-- Both are idempotent. Allowed slugs + setting keys are enforced in app code
-- (server/lib/siteContentSlots.ts) — the DB intentionally stays permissive so
-- we can extend the slot list without a migration.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "site_content" (
  "slug"       text PRIMARY KEY,
  "data"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "site_settings" (
  "key"        text PRIMARY KEY,
  "value"      text NOT NULL DEFAULT '',
  "updated_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
