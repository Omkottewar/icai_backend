-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0051 — Q&A "answered" marker
--
-- Phase 1 of the per-event Q&A forum (catalogue §1.2 "Just like quora"):
-- moderators / speakers can mark a top-level Q&A question as answered, which
-- visually pins the resolution and lets the UI sort open questions ahead of
-- resolved ones. Reuses the existing `event_chat_channels.kind = 'qa'`
-- channel kind and the existing `forum_posts` table — no new tables.
--
-- The marker lives on the top-level question post (parent_post_id IS NULL).
-- A nullable timestamptz captures both the boolean state ("is this answered?")
-- and the audit ("when was it marked").
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE forum_posts
  ADD COLUMN IF NOT EXISTS answered_at timestamptz,
  ADD COLUMN IF NOT EXISTS answered_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Partial index for the common "show me open Q&A questions" lookup.
-- Only top-level posts in a channel can be "answered" — replies inherit
-- their parent's state — so the index excludes replies via the partial.
CREATE INDEX IF NOT EXISTS forum_posts_qa_open_idx
  ON forum_posts (channel_id, created_at DESC)
  WHERE answered_at IS NULL
    AND parent_post_id IS NULL
    AND deleted_at IS NULL;
