-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0047 — Mock test engine: questions, options, attempts, answers.
--
-- Turns mock_tests from "an event with a PDF" into a real test platform.
-- Adds:
--   • mock_test_questions    — question bank per test (mcq / numerical / text)
--   • mock_test_options      — choices for MCQ questions
--   • mock_test_attempts     — one row per student per attempt; carries
--                              timer state + auto-grade results
--   • mock_test_answers      — one row per (attempt, question); stores the
--                              student's response + per-question marks
--
-- Also adds `supports_online` to `mock_tests` so admins can opt a test
-- into the online-attempt mode (existing paper-at-venue tests keep
-- working with this flag false; nothing else changes for them).
--
-- Grading model:
--   • mcq        — exact match against `is_correct` options; negative
--                  marks apply on wrong answer if `negative_marks > 0`
--                  on the parent question.
--   • numerical  — student's numeric value within ±tolerance of
--                  `numerical_answer` scores full marks; else 0 (or
--                  -negative_marks if set).
--   • short/long — subjective; auto-grade leaves marks_awarded NULL,
--                  admin fills via the marks-entry endpoint.
--
-- Attempt token: `attempt_token` is a random opaque string the client
-- echoes on every save/submit. Lets us bind an attempt to a single
-- browser session so a parallel tab can't double-submit, and gives
-- us a one-tap "resume my attempt" without leaking other attempts.
-- ════════════════════════════════════════════════════════════════════════════

-- 1) Opt-in flag on mock_tests so admins can enable online-attempt mode
ALTER TABLE mock_tests
  ADD COLUMN IF NOT EXISTS supports_online boolean NOT NULL DEFAULT false;

-- 2) Questions table
CREATE TABLE IF NOT EXISTS mock_test_questions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mock_test_id        uuid NOT NULL REFERENCES mock_tests(id) ON DELETE CASCADE,
  question_no         integer NOT NULL,
  question_type       text NOT NULL,            -- 'mcq' | 'numerical' | 'short' | 'long'
  body                text NOT NULL,            -- markdown
  marks               integer NOT NULL DEFAULT 1,
  negative_marks      numeric(4,2) NOT NULL DEFAULT 0,
  topic_tag           text,                     -- 'gst' / 'direct_tax' / etc.
  difficulty          text,                     -- 'easy' / 'medium' / 'hard'
  -- For 'numerical' type:
  numerical_answer    numeric,
  numerical_tolerance numeric NOT NULL DEFAULT 0,
  -- Shown in review mode after results are published
  explanation         text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz,
  CONSTRAINT mock_test_questions_type_chk
    CHECK (question_type IN ('mcq','numerical','short','long'))
);

CREATE INDEX IF NOT EXISTS mock_test_questions_test_idx
  ON mock_test_questions (mock_test_id, question_no)
  WHERE deleted_at IS NULL;

-- 3) Options table (MCQ only)
CREATE TABLE IF NOT EXISTS mock_test_options (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES mock_test_questions(id) ON DELETE CASCADE,
  option_label text NOT NULL,                   -- 'A' | 'B' | 'C' | 'D'
  body         text NOT NULL,
  is_correct   boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS mock_test_options_question_idx
  ON mock_test_options (question_id, sort_order);

-- 4) Attempts table
CREATE TABLE IF NOT EXISTS mock_test_attempts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mock_test_id    uuid NOT NULL REFERENCES mock_tests(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  registration_id uuid REFERENCES mock_test_registrations(id) ON DELETE SET NULL,
  attempt_token   text NOT NULL UNIQUE,
  started_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  submitted_at    timestamptz,
  status          text NOT NULL DEFAULT 'in_progress',
  -- in_progress | submitted | auto_submitted | abandoned
  score_auto      numeric,                       -- objective questions
  score_manual    numeric,                       -- subjective marks (admin)
  score_total     numeric,                       -- summed / overridden
  graded_at       timestamptz,
  graded_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Weak anti-cheat signal — incremented when the student leaves the tab.
  tab_blur_count  integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mock_test_attempts_status_chk
    CHECK (status IN ('in_progress','submitted','auto_submitted','abandoned'))
);

-- Lookup by user (My Mocks) and by test (admin attempts list).
CREATE INDEX IF NOT EXISTS mock_test_attempts_user_idx ON mock_test_attempts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS mock_test_attempts_test_idx ON mock_test_attempts (mock_test_id, status);
-- One in-flight attempt per (test, user). When a student abandons, they
-- can start fresh — but they can't have two "in_progress" rows at once.
CREATE UNIQUE INDEX IF NOT EXISTS mock_test_attempts_one_open
  ON mock_test_attempts (mock_test_id, user_id)
  WHERE status = 'in_progress';

-- 5) Answers table
CREATE TABLE IF NOT EXISTS mock_test_answers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id          uuid NOT NULL REFERENCES mock_test_attempts(id) ON DELETE CASCADE,
  question_id         uuid NOT NULL REFERENCES mock_test_questions(id) ON DELETE CASCADE,
  -- Multi-select MCQ support — single-select still uses an array of length 1.
  selected_option_ids uuid[],
  numerical_value     numeric,
  text_answer         text,
  marks_awarded       numeric,                  -- NULL until graded
  time_spent_ms       integer NOT NULL DEFAULT 0,
  marked_for_review   boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, question_id)
);

CREATE INDEX IF NOT EXISTS mock_test_answers_attempt_idx ON mock_test_answers (attempt_id);
