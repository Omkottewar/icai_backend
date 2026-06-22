-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0043 — forum_posts.client_id for idempotent optimistic sends
--
-- The chat client now picks a uuid (`client_id`) BEFORE the POST and
-- attaches it to the request. The server uses that key to make sends
-- idempotent — a retry over a flaky network won't double-post.
--
-- Index is partial (`WHERE client_id IS NOT NULL`) so legacy chat rows
-- and rows posted from server-internal paths (which don't supply a
-- client_id) aren't constrained by the uniqueness check.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE forum_posts
  ADD COLUMN IF NOT EXISTS client_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS forum_posts_channel_client_id_idx
  ON forum_posts (channel_id, client_id)
  WHERE client_id IS NOT NULL;
