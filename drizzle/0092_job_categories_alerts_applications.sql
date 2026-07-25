-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0092 — Job categories, subscriptions, applications, saved jobs
--
-- Wraps the job vacancies section into a real job board:
--   • job_categories             — branch-editable taxonomy
--   • job_alert_subscriptions    — per-user category + posting-type alerts
--   • job_applications           — one row per (posting, user), with a
--                                   resume snapshot at apply time
--   • saved_jobs                 — user bookmarks
-- Also adds two columns:
--   • users.resume_file_id       — user-uploaded profile resume
--   • job_postings.category_id   — links a posting to a category
--
-- Idempotent: uses IF NOT EXISTS on tables, columns, and indexes so re-runs
-- against a partially-migrated DB are safe.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. job_categories ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "job_categories" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"        text NOT NULL,
  "name"        text NOT NULL,
  "description" text,
  "active"      boolean NOT NULL DEFAULT true,
  "sort_order"  integer NOT NULL DEFAULT 0,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "job_categories_code_uq"
  ON "job_categories" ("code");
CREATE INDEX IF NOT EXISTS "job_categories_active_idx"
  ON "job_categories" ("active", "sort_order");

-- ─── 2. job_postings.category_id ─────────────────────────────────────────
ALTER TABLE "job_postings"
  ADD COLUMN IF NOT EXISTS "category_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'job_postings_category_id_fk'
      AND table_name = 'job_postings'
  ) THEN
    ALTER TABLE "job_postings"
      ADD CONSTRAINT "job_postings_category_id_fk"
      FOREIGN KEY ("category_id") REFERENCES "job_categories"("id")
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "job_postings_category_idx"
  ON "job_postings" ("category_id");

-- ─── 3. users.resume_file_id ─────────────────────────────────────────────
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "resume_file_id" uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'users_resume_file_id_fk'
      AND table_name = 'users'
  ) THEN
    ALTER TABLE "users"
      ADD CONSTRAINT "users_resume_file_id_fk"
      FOREIGN KEY ("resume_file_id") REFERENCES "files"("id")
      ON DELETE SET NULL;
  END IF;
END $$;

-- ─── 4. job_alert_subscriptions ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "job_alert_subscriptions" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"            uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "category_id"        uuid NOT NULL REFERENCES "job_categories"("id") ON DELETE CASCADE,
  "posting_type"       posting_type NOT NULL,
  "frequency"          text NOT NULL DEFAULT 'instant',
  "filter_location"    text,
  "filter_experience"  text,
  "confirmed_at"       timestamptz,
  "unsubscribed_at"    timestamptz,
  "last_notified_at"   timestamptz,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "updated_at"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "job_alert_subs_frequency_ck"
    CHECK ("frequency" IN ('instant', 'daily_digest', 'weekly_digest'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "job_alert_subs_user_cat_type_uq"
  ON "job_alert_subscriptions" ("user_id", "category_id", "posting_type");
CREATE INDEX IF NOT EXISTS "job_alert_subs_category_idx"
  ON "job_alert_subscriptions" ("category_id", "posting_type");

-- ─── 5. job_applications ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "job_applications" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "posting_id"         uuid NOT NULL REFERENCES "job_postings"("id") ON DELETE CASCADE,
  "user_id"            uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "resume_file_id"     uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "cover_message"      text,
  "applicant_snapshot" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status"             application_status NOT NULL DEFAULT 'applied',
  "status_note"        text,
  "reviewed_by"        uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_at"        timestamptz,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "updated_at"         timestamptz NOT NULL DEFAULT now(),
  "withdrawn_at"       timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS "job_applications_posting_user_uq"
  ON "job_applications" ("posting_id", "user_id");
CREATE INDEX IF NOT EXISTS "job_applications_posting_idx"
  ON "job_applications" ("posting_id", "status");
CREATE INDEX IF NOT EXISTS "job_applications_user_idx"
  ON "job_applications" ("user_id", "created_at");

-- ─── 6. saved_jobs ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "saved_jobs" (
  "user_id"    uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "posting_id" uuid NOT NULL REFERENCES "job_postings"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "posting_id")
);
CREATE INDEX IF NOT EXISTS "saved_jobs_user_idx"
  ON "saved_jobs" ("user_id", "created_at");

-- ─── 7. Seed default categories ──────────────────────────────────────────
-- Names picked to match CA-industry vocabulary. Admin can rename or hide any
-- of these via /admin/job-categories.
INSERT INTO "job_categories" ("code", "name", "description", "sort_order")
VALUES
  ('audit',            'Audit & Assurance',                  'Statutory audit, external audit, assurance engagements.',                          10),
  ('taxation',         'Direct & Indirect Tax',              'Corporate tax, personal tax, litigation, transfer pricing.',                      20),
  ('gst',              'GST',                                'GST compliance, advisory, returns, audits and litigation.',                       30),
  ('internal_audit',   'Internal Audit',                     'Internal audit, risk & controls, SOX, IFC.',                                       40),
  ('advisory',         'Advisory / Consulting',              'Transaction advisory, valuation, due diligence, consulting.',                     50),
  ('industry_finance', 'Industry — Finance & Accounts',      'CA / semi-qualified roles in corporate finance, controllership, FP&A.',           60),
  ('industry_banking', 'Industry — Banking & NBFC',          'Credit, treasury, compliance and audit in banks & NBFCs.',                        70),
  ('corporate_law',    'Corporate Law / Secretarial',        'Corporate secretarial, compliance, ROC filings, board matters.',                   80),
  ('treasury',         'Treasury & Forex',                    'Cash-flow management, forex, hedging.',                                            90),
  ('articleship',      'Articleship',                         'Practical training seats with member firms.',                                    100),
  ('paid_assistant',   'Paid Assistant / Semi-qualified',     'Paid assistant roles for IPCC / Inter / semi-qualified candidates.',            110),
  ('part_time',        'Part-time / Retired professional',    'Part-time or retirement-friendly engagements.',                                  120),
  ('other',            'Other',                               'Anything that doesn''t fit a named category.',                                    900)
ON CONFLICT ("code") DO NOTHING;
