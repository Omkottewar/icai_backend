-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0052 — Mock-test discussion threads
--
-- Phase 1.2 of the forum surface (F18). The "Student Forum" public card
-- now points at per-test discussion threads — one thread per mock_test, lazy
-- created on first comment, naturally seeded by the cohort of students
-- registered for that test.
--
-- Why reuse forum_threads instead of a new table:
--   • The same shape, soft-delete, audit and admin-moderation paths the
--     event chat uses (forum_posts) — no duplicate plumbing.
--   • Migration 0041 already nullable-ised forum_posts.thread_id, so the
--     same posts table can mix event-chat posts (channel_id set, thread_id
--     null) with mock-test posts (thread_id set, channel_id null).
--
-- Why an explicit mock_test_id column rather than a polymorphic
-- subject_type/subject_id pair:
--   • Single new FK preserves CASCADE-DELETE semantics — when a mock test
--     is hard-deleted (rare; soft-delete is the default), threads and
--     posts come with it via the existing post→thread CASCADE.
--   • A polymorphic pair would force a CHECK constraint plus a partial
--     index per subject type, more code for one extra scope.
-- ════════════════════════════════════════════════════════════════════════════

-- 1) New nullable scope column ───────────────────────────────────────────
ALTER TABLE forum_threads
  ADD COLUMN IF NOT EXISTS mock_test_id uuid
    REFERENCES mock_tests(id) ON DELETE CASCADE;

-- 2) Extend the scope CHECK to accept the new dimension ──────────────────
-- A thread must still be scoped to *something*. We drop the old constraint
-- and re-create it to include mock_test_id as a valid scope.
ALTER TABLE forum_threads
  DROP CONSTRAINT IF EXISTS forum_threads_scope_check;

ALTER TABLE forum_threads
  ADD CONSTRAINT forum_threads_scope_check CHECK (
    event_id IS NOT NULL
    OR committee_id IS NOT NULL
    OR mock_test_id IS NOT NULL
  );

-- 3) One thread per mock test (partial unique index — soft-deleted threads
-- ignored so a deleted thread can be replaced rather than blocking forever)
CREATE UNIQUE INDEX IF NOT EXISTS forum_threads_mock_test_uniq
  ON forum_threads (mock_test_id)
  WHERE mock_test_id IS NOT NULL AND deleted_at IS NULL;

-- 4) Lookup index for the common "load thread for this test" query
CREATE INDEX IF NOT EXISTS idx_forum_threads_mock_test
  ON forum_threads (mock_test_id)
  WHERE deleted_at IS NULL;
