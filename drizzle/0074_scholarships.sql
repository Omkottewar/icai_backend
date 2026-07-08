-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0074 — scholarships + scholarship_applications
--
-- Section N.6 of the requirements. Two-table shape kept deliberately
-- lightweight: the offer catalogue + the application row. Rubric/jury/
-- disbursement can layer in later without breaking the row shape.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "scholarships" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"               text NOT NULL,
  "title"              text NOT NULL,
  "summary"            text,
  "description"        text NOT NULL,
  "eligibility"        text,
  "award_amount_paise" integer,
  "deadline_at"        timestamptz,
  "applications_open"  boolean NOT NULL DEFAULT true,
  "external_url"       text,
  "cover_file_id"      uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "active"             boolean NOT NULL DEFAULT true,
  "sort_order"         integer NOT NULL DEFAULT 0,
  "created_by"         uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "updated_at"         timestamptz NOT NULL DEFAULT now(),
  "deleted_at"         timestamptz,
  CONSTRAINT "scholarships_slug_uq" UNIQUE ("slug")
);

CREATE INDEX IF NOT EXISTS "scholarships_active_idx"
  ON "scholarships" ("active", "sort_order");

CREATE TABLE IF NOT EXISTS "scholarship_applications" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "scholarship_id"     uuid NOT NULL REFERENCES "scholarships"("id") ON DELETE CASCADE,
  "student_user_id"    uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "why_applying"       text NOT NULL,
  "current_situation"  text,
  "contact_phone"      text,
  "status"             text NOT NULL DEFAULT 'submitted',
  "reviewer_user_id"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewer_note"      text,
  "decided_at"         timestamptz,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "updated_at"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "scholarship_applications_uniq" UNIQUE ("scholarship_id", "student_user_id")
);

CREATE INDEX IF NOT EXISTS "scholarship_applications_scholarship_idx"
  ON "scholarship_applications" ("scholarship_id");
CREATE INDEX IF NOT EXISTS "scholarship_applications_student_idx"
  ON "scholarship_applications" ("student_user_id");
