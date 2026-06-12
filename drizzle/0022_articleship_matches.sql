-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0022 — articleship_matches
--
-- Post-seminar matchmaking form responses. WICASA chairman reviews, the
-- recommendation engine pre-populates suggested firms, and the student
-- eventually confirms placement.
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "articleship_matches" (
  "id"                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "student_user_id"             uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "seminar_event_id"            uuid REFERENCES "events"("id") ON DELETE SET NULL,
  "preferred_specialisations"   text[],
  "preferred_location"          text,
  "preferred_firm_size"         text,
  "expected_stipend_paise"      integer,
  "cv_file_id"                  uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "status"                      text NOT NULL DEFAULT 'submitted',
  "recommended_firm_ids"        uuid[],
  "placed_firm_id"              uuid REFERENCES "firms"("id") ON DELETE SET NULL,
  "notes"                       text,
  "created_at"                  timestamptz NOT NULL DEFAULT now(),
  "updated_at"                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT articleship_matches_status_chk
    CHECK (status IN ('submitted','matched','placed','cancelled')),
  CONSTRAINT articleship_matches_firm_size_chk
    CHECK (preferred_firm_size IS NULL
           OR preferred_firm_size IN ('sole_practitioner','small','medium','large','big4'))
);

CREATE INDEX IF NOT EXISTS "articleship_matches_status_idx" ON "articleship_matches" ("status");
CREATE INDEX IF NOT EXISTS "articleship_matches_event_idx"  ON "articleship_matches" ("seminar_event_id");
