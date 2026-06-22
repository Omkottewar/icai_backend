-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0042 — Event chat production hardening
--
-- Builds on 0041 (Discord-style channels + reactions + reads). Adds the
-- moderation, audit, and safety primitives a real production chat needs:
--
--   • event_chat_channels.frozen, .archived           — read-only modes
--   • event_chat_mutes                                 — per-user mutes by
--     a moderator (timed)
--   • event_chat_message_reports                       — abuse reports
--   • event_chat_audit                                 — append-only audit
--     log of moderator actions
--   • event_chat_uploads.bytes_used  (column on users) — storage quota
--     accounting per uploader
--
-- We keep all of these on dedicated tables (no dropping into forum_posts)
-- so the chat surface can evolve without touching the legacy forum.
-- ════════════════════════════════════════════════════════════════════════════

-- 1) Channel state ───────────────────────────────────────────────────────
ALTER TABLE event_chat_channels
  ADD COLUMN IF NOT EXISTS frozen boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS event_chat_channels_active_idx
  ON event_chat_channels (event_id)
  WHERE deleted_at IS NULL AND archived_at IS NULL;

-- 2) Per-user mutes (a chairman can mute someone for N minutes) ──────────
CREATE TABLE IF NOT EXISTS event_chat_mutes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id    uuid REFERENCES event_chat_channels(id) ON DELETE CASCADE,
    -- NULL channel_id = muted across all channels in the event
  reason        text,
  muted_until   timestamptz,   -- NULL = indefinite until lifted
  muted_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT NOW()
);

-- Note: Postgres requires partial-index predicates to use only IMMUTABLE
-- functions, so we can't use `WHERE muted_until IS NULL OR muted_until >
-- NOW()` (NOW() is STABLE). Put `muted_until` in the index columns
-- instead — the lookup still seeks on (event_id, user_id) and Postgres
-- filters the time comparison after the index scan.
CREATE INDEX IF NOT EXISTS event_chat_mutes_user_idx
  ON event_chat_mutes (event_id, user_id, muted_until);

-- 3) Abuse reports ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_chat_message_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      uuid NOT NULL REFERENCES forum_posts(id) ON DELETE CASCADE,
  reported_by     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason          text NOT NULL,
  resolved_at     timestamptz,
  resolved_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  resolution_note text,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (message_id, reported_by)  -- one report per (msg, user)
);

CREATE INDEX IF NOT EXISTS event_chat_message_reports_open_idx
  ON event_chat_message_reports (created_at)
  WHERE resolved_at IS NULL;

-- 4) Audit log ───────────────────────────────────────────────────────────
-- Append-only log of every moderator action + every message edit/delete.
-- Lets the chairman answer "who deleted what" without forensics on the
-- application logs.
CREATE TABLE IF NOT EXISTS event_chat_audit (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  actor_id    uuid REFERENCES users(id) ON DELETE SET NULL,
  action      text NOT NULL,
    -- 'message_edited' | 'message_deleted' | 'message_pinned' |
    -- 'message_unpinned' | 'user_muted' | 'user_unmuted' |
    -- 'channel_frozen' | 'channel_unfrozen' | 'channel_archived' |
    -- 'report_resolved'
  target_message_id uuid,
  target_user_id    uuid,
  target_channel_id uuid,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS event_chat_audit_event_idx
  ON event_chat_audit (event_id, created_at DESC);

-- 5) Storage quota tracking ──────────────────────────────────────────────
-- Total bytes a user has uploaded into chat. Cheap aggregate so quota
-- checks are O(1) instead of summing `files` rows on every upload.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS chat_bytes_used bigint NOT NULL DEFAULT 0;

-- 6) Notification template for @mention pushes ───────────────────────────
INSERT INTO notification_templates (key, name, description, channels, inapp_title, inapp_body, email_subject, email_body, enabled)
VALUES (
  'chat_mention',
  'Event chat mention',
  'Fired when a registered attendee @-mentions another attendee in an event channel.',
  ARRAY['inapp', 'webpush'],
  '{{actor_name}} mentioned you',
  'in #{{channel_name}} — {{event_title}}',
  '{{actor_name}} mentioned you in {{event_title}}',
  'Hi {{recipient_name}},\n\n{{actor_name}} mentioned you in the {{event_title}} chat (#{{channel_name}}):\n\n"{{snippet}}"\n\nOpen the chat to reply.',
  true
)
ON CONFLICT (key) DO NOTHING;
