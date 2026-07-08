-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0077 — budgets (per-FY planned amounts by committee + category)
--
-- Actuals are computed at read time by joining bills. Keeping planned vs
-- actual in separate tables (rather than a materialised summary) means the
-- budget stays stable even as bills come in.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "budgets" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "fy_start_year"   integer NOT NULL,
  "committee_id"    uuid REFERENCES "committees"("id") ON DELETE CASCADE,
  "category_id"     uuid NOT NULL REFERENCES "expense_categories"("id") ON DELETE RESTRICT,
  "planned_paise"   integer NOT NULL,
  "notes"           text,
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  -- Postgres unique constraints treat NULLs as distinct, so multiple rows
  -- with committee_id = NULL for the same (fy, category) *would* pass
  -- naïvely. NULLS NOT DISTINCT forces branch-wide rows to still be unique.
  CONSTRAINT "budgets_uq" UNIQUE NULLS NOT DISTINCT ("fy_start_year", "committee_id", "category_id")
);

CREATE INDEX IF NOT EXISTS "budgets_fy_idx"        ON "budgets" ("fy_start_year");
CREATE INDEX IF NOT EXISTS "budgets_committee_idx" ON "budgets" ("committee_id");
