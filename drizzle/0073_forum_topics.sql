-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0073 — forum_threads.topic (scope-less discussion threads)
--
-- Phase 3 of the student surface. Adds a `topic` slug so threads no longer
-- have to attach to an event/committee/mock-test row — enabling a general
-- student peer forum, a members peer forum, and any future
-- non-scope-bound discussion.
--
-- The CHECK constraint is broadened to accept `topic IS NOT NULL` as a
-- valid scope alongside the existing event/committee/mock-test dimensions.
-- A partial unique-index scheme isn't needed — many threads can share the
-- same topic (unlike mock_test_id where one thread per test is enforced).
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE forum_threads
  ADD COLUMN IF NOT EXISTS topic text;

ALTER TABLE forum_threads
  DROP CONSTRAINT IF EXISTS forum_threads_scope_check;

ALTER TABLE forum_threads
  ADD CONSTRAINT forum_threads_scope_check CHECK (
    event_id IS NOT NULL
    OR committee_id IS NOT NULL
    OR mock_test_id IS NOT NULL
    OR topic IS NOT NULL
  );

CREATE INDEX IF NOT EXISTS idx_forum_threads_topic
  ON forum_threads (topic)
  WHERE topic IS NOT NULL AND deleted_at IS NULL;
