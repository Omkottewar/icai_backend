-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0041 — Event chat Discord-like revamp
--
-- Before this migration the event chat was one sentinel `forum_threads`
-- row per event with all messages dumped into it. That was fine for the
-- WhatsApp-style v1 but precluded the features the client asked for:
-- per-event channels, reactions, replies, mentions, edits, pins,
-- attachments, search, read state.
--
-- New shape:
--   event_chat_channels    — N channels per event (general / Q&A / etc.)
--   forum_posts.channel_id — points at the channel; replaces thread_id for chat
--   forum_posts.parent_post_id — used for replies (column already exists,
--                                schema didn't index it before)
--   forum_posts.pinned_at, edited_at, attachments (jsonb), mention_user_ids
--   forum_post_reactions   — one row per (post, user, emoji)
--   event_chat_channel_reads — per-user last_read_at per channel for
--                              unread badges
--
-- Backfill: every existing sentinel chat thread becomes a "general"
-- channel for its event; the orphaned forum_posts get channel_id set so
-- the live chat keeps working on reload.
-- ════════════════════════════════════════════════════════════════════════════

-- 1) Channels per event ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_chat_channels (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id     uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name         text NOT NULL,
  description  text,
  kind         text NOT NULL DEFAULT 'general',
    -- 'general' | 'qa' | 'announcements' | 'speaker'
  sort_order   integer NOT NULL DEFAULT 0,
  -- Posting can be restricted by role. NULL = anyone registered for the
  -- event can post. Otherwise we check the user's role codes.
  post_role_required text,
  created_at   timestamptz NOT NULL DEFAULT NOW(),
  updated_at   timestamptz NOT NULL DEFAULT NOW(),
  deleted_at   timestamptz
);

CREATE INDEX IF NOT EXISTS event_chat_channels_event_idx
  ON event_chat_channels (event_id, sort_order)
  WHERE deleted_at IS NULL;

-- 2) Chat-friendly columns on forum_posts ────────────────────────────────
ALTER TABLE forum_posts
  ADD COLUMN IF NOT EXISTS channel_id uuid
    REFERENCES event_chat_channels(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS pinned_at timestamptz,
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS mention_user_ids uuid[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS forum_posts_channel_created_idx
  ON forum_posts (channel_id, created_at)
  WHERE channel_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS forum_posts_channel_pinned_idx
  ON forum_posts (channel_id, pinned_at DESC)
  WHERE pinned_at IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS forum_posts_parent_idx
  ON forum_posts (parent_post_id)
  WHERE parent_post_id IS NOT NULL;

-- 3) Reactions ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS forum_post_reactions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     uuid NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (post_id, user_id, emoji)
);

CREATE INDEX IF NOT EXISTS forum_post_reactions_post_idx
  ON forum_post_reactions (post_id);

-- 4) Channel read state ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_chat_channel_reads (
  channel_id   uuid NOT NULL REFERENCES event_chat_channels(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel_id, user_id)
);

-- 5) Backfill: every existing sentinel chat thread becomes a 'general'
--    channel on its event; the forum_posts that lived in that thread get
--    channel_id set so the live UI keeps showing history on reload.
-- ────────────────────────────────────────────────────────────────────────
INSERT INTO event_chat_channels (event_id, name, kind, sort_order)
SELECT t.event_id, 'general', 'general', 0
FROM forum_threads t
WHERE t.title = '__event_chat__'
  AND t.event_id IS NOT NULL
  AND t.deleted_at IS NULL
ON CONFLICT DO NOTHING;

UPDATE forum_posts p
SET channel_id = c.id
FROM forum_threads t
JOIN event_chat_channels c
  ON c.event_id = t.event_id AND c.kind = 'general'
WHERE p.thread_id = t.id
  AND p.channel_id IS NULL
  AND t.title = '__event_chat__';

-- Make forum_posts.thread_id nullable — going forward chat posts have
-- channel_id but no thread_id (replies inside a channel still use
-- parent_post_id, not a sub-thread).
ALTER TABLE forum_posts
  ALTER COLUMN thread_id DROP NOT NULL;
