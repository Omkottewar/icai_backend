-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0083 — Event speakers (real user accounts replace magic-link)
--
-- We built the magic-link `event_guest_passes` approach (migration 0082)
-- but the branch decided one-off cookie-only sessions don't cover their
-- needs: they want speakers to receive email + in-app notifications, log
-- in from any device, and be reusable across events. Real user accounts
-- with `primary_role='guest'` deliver all of that.
--
-- This migration:
--   1. Drops `forum_posts.guest_pass_id` and the XOR constraint added in
--      0082. `created_by` becomes NOT NULL again — every chat message
--      author is now a real users row.
--   2. Drops the `event_guest_passes` table and its indexes.
--   3. Creates `event_speakers` — many-to-many (event_id, user_id). A
--      user_role_assignments record with scope wouldn't fit the shape
--      well because we need per-event associations, not per-branch or
--      per-committee.
--
-- Safe to re-run. Any rows in forum_posts with created_by=null (from
-- guest-authored posts on the magic-link flow) are hard-deleted before
-- the NOT NULL constraint is restored; those messages have no user id
-- to migrate to, so preserving them isn't feasible.
-- ════════════════════════════════════════════════════════════════════════════

-- Step 1: purge any guest-authored forum posts left behind by 0082.
DELETE FROM "forum_posts" WHERE "created_by" IS NULL;

-- Step 2: drop the XOR constraint + guest_pass_id column.
ALTER TABLE "forum_posts"
  DROP CONSTRAINT IF EXISTS "forum_posts_author_exactly_one";

DROP INDEX IF EXISTS "idx_forum_posts_guest_pass";

ALTER TABLE "forum_posts"
  DROP COLUMN IF EXISTS "guest_pass_id";

-- Step 3: restore NOT NULL on created_by.
ALTER TABLE "forum_posts"
  ALTER COLUMN "created_by" SET NOT NULL;

-- Step 4: drop the magic-link table.
DROP TABLE IF EXISTS "event_guest_passes";

-- Step 5: add 'guest' primary_role value used by speaker accounts. Guests
-- have no branch/committee scope — they exist only to author messages in
-- events they're added to. Wrapped in a DO block so re-runs after the
-- value already exists are silent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'user_role' AND e.enumlabel = 'guest'
  ) THEN
    ALTER TYPE "user_role" ADD VALUE 'guest';
  END IF;
END $$;

-- Step 6: new event_speakers table.
CREATE TABLE IF NOT EXISTS "event_speakers" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"    uuid NOT NULL REFERENCES "events" ("id") ON DELETE CASCADE,
  "user_id"     uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "added_by"    uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  "added_at"    timestamptz NOT NULL DEFAULT now()
);

-- One user can only be added to an event once. Duplicates would create
-- ambiguity for permission checks + waste rows.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_event_speakers_event_user"
  ON "event_speakers" ("event_id", "user_id");

CREATE INDEX IF NOT EXISTS "idx_event_speakers_event"
  ON "event_speakers" ("event_id");
CREATE INDEX IF NOT EXISTS "idx_event_speakers_user"
  ON "event_speakers" ("user_id");
