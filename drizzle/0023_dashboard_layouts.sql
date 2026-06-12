-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0023 — dashboard_layouts
--
-- Per-user widget layout for the customizable dashboard (branch chairman and
-- any future role that gets a configurable dashboard). One row per user.
-- `layout` is a JSON array of { id, size } where id is a widget key the
-- frontend registry knows about and size is one of 'sm' | 'md' | 'lg'.
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "dashboard_layouts" (
  "user_id"    uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "layout"     jsonb NOT NULL DEFAULT '[]'::jsonb,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dashboard_layouts_layout_is_array CHECK (jsonb_typeof("layout") = 'array')
);
