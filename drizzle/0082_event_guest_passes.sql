-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0082 — Event guest passes (temporary speaker access to chat)
--
-- Speakers at ICAI events are external people who don't (and shouldn't) have
-- a permanent branch-portal user account. But they DO need to address
-- participants in the event chat — post announcements, answer questions in
-- the Q&A channel, share slide links, etc.
--
-- This migration adds:
--
--   1. event_guest_passes    — a magic-link record scoped to ONE event.
--      Admin creates a pass, backend generates a plaintext token (returned
--      once, never stored), token_hash goes in the table, admin shares the
--      URL with the speaker.
--
--   2. forum_posts.guest_pass_id column — so chat messages can identify a
--      guest author without a users row. Existing created_by keeps working
--      for authenticated users; guests set guest_pass_id and leave
--      created_by NULL (constraint below enforces XOR).
--
-- Cleanup: expires_at is populated at pass creation time as
-- (event.ends_at + 24 hours). A daily cron OR a check-on-use flow (see
-- routes/eventGuestPasses.ts) rejects expired tokens.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "event_guest_passes" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"      uuid NOT NULL REFERENCES "events" ("id") ON DELETE CASCADE,
  "speaker_name"  text NOT NULL,
  "token_hash"    text NOT NULL,
  "created_by"    uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "expires_at"    timestamptz NOT NULL,
  "revoked_at"    timestamptz,
  "last_used_at"  timestamptz,
  "ip_last_used"  text
);

CREATE INDEX IF NOT EXISTS "idx_event_guest_passes_event"
  ON "event_guest_passes" ("event_id");
CREATE UNIQUE INDEX IF NOT EXISTS "ux_event_guest_passes_token_hash"
  ON "event_guest_passes" ("token_hash");

-- ─── forum_posts: allow guest authorship ────────────────────────────────
-- Drop the NOT NULL on created_by so a guest's post can leave it null,
-- and add guest_pass_id. A CHECK ensures exactly one of the two author
-- fields is populated per row so we never lose provenance.

ALTER TABLE "forum_posts"
  ALTER COLUMN "created_by" DROP NOT NULL;

ALTER TABLE "forum_posts"
  ADD COLUMN IF NOT EXISTS "guest_pass_id" uuid
  REFERENCES "event_guest_passes" ("id") ON DELETE SET NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'forum_posts_author_exactly_one'
  ) THEN
    ALTER TABLE "forum_posts"
      ADD CONSTRAINT "forum_posts_author_exactly_one"
      CHECK (
        (created_by IS NOT NULL AND guest_pass_id IS NULL)
        OR (created_by IS NULL AND guest_pass_id IS NOT NULL)
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_forum_posts_guest_pass"
  ON "forum_posts" ("guest_pass_id");
