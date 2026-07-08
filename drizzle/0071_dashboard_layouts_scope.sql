-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0071 — dashboard_layouts.scope
--
-- Adds a `scope` column so a single user can hold multiple dashboard layouts
-- side-by-side (chairman insights vs treasurer insights, etc). All existing
-- rows are labelled 'chairman' — that was the only surface using the table
-- before this migration.
--
-- The primary key is broadened from (user_id) to (user_id, scope) so upsert
-- works per-scope. Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "dashboard_layouts"
  ADD COLUMN IF NOT EXISTS "scope" text NOT NULL DEFAULT 'chairman';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conrelid = 'dashboard_layouts'::regclass
    AND    conname  = 'dashboard_layouts_pkey'
  ) THEN
    ALTER TABLE "dashboard_layouts" DROP CONSTRAINT "dashboard_layouts_pkey";
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM   pg_constraint
    WHERE  conrelid = 'dashboard_layouts'::regclass
    AND    contype  = 'p'
  ) THEN
    ALTER TABLE "dashboard_layouts"
      ADD CONSTRAINT "dashboard_layouts_pkey" PRIMARY KEY ("user_id", "scope");
  END IF;
END $$;
