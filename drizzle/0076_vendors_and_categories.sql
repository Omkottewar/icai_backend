-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0076 — vendor directory + expense categories + bill linkage
--
-- Turns the free-text vendor_name field on bills into structured references
-- so the treasurer dashboard can produce vendor-spend + category-spend
-- analyses without heuristic parsing of names.
--
-- The old `vendor_name` column stays — it's used as a fallback whenever
-- vendor_id is NULL (e.g. one-off vendors the treasurer doesn't want to
-- add to the directory permanently).
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "expense_categories" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"        text NOT NULL,
  "label"       text NOT NULL,
  "description" text,
  "kind"        text NOT NULL DEFAULT 'expense',
  "sort_order"  integer NOT NULL DEFAULT 0,
  "active"      boolean NOT NULL DEFAULT true,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "expense_categories_code_uq" UNIQUE ("code")
);
CREATE INDEX IF NOT EXISTS "expense_categories_active_idx"
  ON "expense_categories" ("active", "sort_order");

CREATE TABLE IF NOT EXISTS "vendors" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "name"                text NOT NULL,
  "contact_person"      text,
  "contact_phone"       text,
  "contact_email"       text,
  "address"             text,
  "gstin"               text,
  "pan"                 text,
  "default_category_id" uuid REFERENCES "expense_categories"("id") ON DELETE SET NULL,
  "notes"               text,
  "active"              boolean NOT NULL DEFAULT true,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now(),
  "deleted_at"          timestamptz
);
CREATE INDEX IF NOT EXISTS "vendors_active_idx" ON "vendors" ("active");

-- Attach both onto the existing bills table. Nullable so historical rows
-- keep working; new bills should populate them.
ALTER TABLE "bills"
  ADD COLUMN IF NOT EXISTS "vendor_id"   uuid REFERENCES "vendors"("id")            ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "category_id" uuid REFERENCES "expense_categories"("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "bills_vendor_idx"   ON "bills" ("vendor_id");
CREATE INDEX IF NOT EXISTS "bills_category_idx" ON "bills" ("category_id");

-- Seed a starting catalogue so the branch doesn't stare at an empty
-- dropdown on day one. Codes follow lowercase-snake convention.
INSERT INTO "expense_categories" ("code", "label", "kind", "sort_order")
VALUES
  ('venue',             'Venue rental',            'expense', 10),
  ('catering',          'Catering / refreshments', 'expense', 20),
  ('speaker_honorarium','Speaker honorarium',      'expense', 30),
  ('travel',            'Travel + accommodation',  'expense', 40),
  ('printing',          'Printing + stationery',   'expense', 50),
  ('av_rental',         'AV / equipment rental',   'expense', 60),
  ('utilities',         'Utilities (electricity / water / net)', 'expense', 70),
  ('professional_fees', 'Professional fees',       'expense', 80),
  ('staff_salary',      'Staff salary',            'expense', 90),
  ('bank_charges',      'Bank charges + gateway fees', 'expense', 100),
  ('miscellaneous',     'Miscellaneous',           'expense', 999)
ON CONFLICT ("code") DO NOTHING;
