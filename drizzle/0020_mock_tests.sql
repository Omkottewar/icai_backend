-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0020 — mock_tests, mock_test_registrations
--
-- WICASA-owned mock-test schedule + per-student registrations. Separate from
-- `events` because mock tests have a different metadata shape (paper number,
-- group, level) and a stricter audience contract (students only).
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "mock_tests" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "branch_id"      uuid REFERENCES "branches"("id") ON DELETE CASCADE,
  "title"          text NOT NULL,
  "series_name"    text,
  "level"          student_level NOT NULL,
  "group_no"       integer,
  "paper_no"       integer,
  "scheduled_at"   timestamptz NOT NULL,
  "duration_mins"  integer NOT NULL DEFAULT 180,
  "venue"          text,
  "capacity"       integer,
  "fee_paise"      integer NOT NULL DEFAULT 0,
  "status"         text NOT NULL DEFAULT 'scheduled',
  "created_by"     uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now(),
  "deleted_at"     timestamptz,
  CONSTRAINT mock_tests_status_chk
    CHECK (status IN ('scheduled','open_for_registration','closed','completed','cancelled')),
  CONSTRAINT mock_tests_group_chk
    CHECK (group_no IS NULL OR group_no IN (1, 2)),
  CONSTRAINT mock_tests_paper_chk
    CHECK (paper_no IS NULL OR (paper_no >= 1 AND paper_no <= 8)),
  CONSTRAINT mock_tests_capacity_chk
    CHECK (capacity IS NULL OR capacity > 0),
  CONSTRAINT mock_tests_duration_chk
    CHECK (duration_mins > 0)
);

CREATE INDEX IF NOT EXISTS "mock_tests_scheduled_idx" ON "mock_tests" ("scheduled_at");
CREATE INDEX IF NOT EXISTS "mock_tests_status_idx"    ON "mock_tests" ("status");

CREATE TABLE IF NOT EXISTS "mock_test_registrations" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "mock_test_id"   uuid NOT NULL REFERENCES "mock_tests"("id") ON DELETE CASCADE,
  "user_id"        uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "status"         text NOT NULL DEFAULT 'registered',
  "score"          integer,
  "registered_at"  timestamptz NOT NULL DEFAULT now(),
  "attended_at"    timestamptz,
  CONSTRAINT mock_test_regs_status_chk
    CHECK (status IN ('registered','attended','absent','cancelled')),
  CONSTRAINT mock_test_regs_score_chk
    CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  CONSTRAINT mock_test_regs_unique_per_test UNIQUE (mock_test_id, user_id)
);

CREATE INDEX IF NOT EXISTS "mock_test_regs_test_idx" ON "mock_test_registrations" ("mock_test_id");
CREATE INDEX IF NOT EXISTS "mock_test_regs_user_idx" ON "mock_test_registrations" ("user_id");
