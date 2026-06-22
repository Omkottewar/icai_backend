-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0040 — Hybrid mock-test engine
--
-- Extends the existing mock_tests schema (0000 / 0003) into a "hybrid"
-- engine: admin schedules the test, optionally uploads a practice paper
-- PDF in advance, takes the test on paper at the branch venue, then
-- uploads an answer key + enters marks per registration.
--
-- Columns added to mock_tests:
--   • description              — long-form notes / instructions
--   • practice_paper_file_id   — PDF posted before the test, optional
--   • answer_key_file_id       — PDF posted after the test, optional
--   • max_score                — total marks (defaults to 100)
--   • result_published_at      — when WICASA released the marks; null
--                                until then. Drives the student-side
--                                "score" visibility — students see their
--                                own score only after publish.
--   • registration_close_at    — registration cutoff, optional. When
--                                null we fall back to scheduled_at.
--
-- No changes to mock_test_registrations.score — already a percentage
-- integer; the new max_score on the parent test gives us the absolute
-- denominator for display when we want absolute numbers.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE mock_tests
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS practice_paper_file_id uuid
    REFERENCES files(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS answer_key_file_id uuid
    REFERENCES files(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS max_score integer NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS result_published_at timestamptz,
  ADD COLUMN IF NOT EXISTS registration_close_at timestamptz;

-- Partial index for the "open for registration" student listing — picks
-- up any test that's scheduled in the future and currently open.
CREATE INDEX IF NOT EXISTS mock_tests_open_for_reg_idx
  ON mock_tests (scheduled_at)
  WHERE status = 'open_for_registration' AND deleted_at IS NULL;
