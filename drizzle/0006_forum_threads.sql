-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0006 — Forum (community threads)
--
-- Two tables: forum_threads (the top post) and forum_posts (replies).
-- Threads MUST attach to either an event or a committee (CHECK constraint) —
-- there's no orphan / global bucket by design.
--
-- Idempotent: all CREATE statements guard against re-runs.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Tag enum ───────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "public"."forum_thread_tag" AS ENUM (
    'doubt', 'suggestion', 'announcement', 'discussion', 'resource_request'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 2. forum_threads ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "forum_threads" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "title"         text NOT NULL,
  "body"          text NOT NULL,
  "tag"           "forum_thread_tag" NOT NULL DEFAULT 'discussion',
  "event_id"      uuid REFERENCES "events"("id") ON DELETE SET NULL,
  "committee_id"  uuid REFERENCES "committees"("id") ON DELETE SET NULL,
  "created_by"    uuid NOT NULL REFERENCES "users"("id"),
  "created_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"    timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at"    timestamp with time zone,
  CONSTRAINT "forum_threads_scope_check"
    CHECK ("event_id" IS NOT NULL OR "committee_id" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS "idx_forum_threads_event"     ON "forum_threads"("event_id")     WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_forum_threads_committee" ON "forum_threads"("committee_id") WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_forum_threads_tag"       ON "forum_threads"("tag")          WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_forum_threads_updated"   ON "forum_threads"("updated_at" DESC) WHERE "deleted_at" IS NULL;

-- ─── 3. forum_posts ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "forum_posts" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "thread_id"       uuid NOT NULL REFERENCES "forum_threads"("id") ON DELETE CASCADE,
  "parent_post_id"  uuid REFERENCES "forum_posts"("id") ON DELETE CASCADE,
  "body"            text NOT NULL,
  "created_by"      uuid NOT NULL REFERENCES "users"("id"),
  "created_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"      timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at"      timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "idx_forum_posts_thread"      ON "forum_posts"("thread_id")      WHERE "deleted_at" IS NULL;
CREATE INDEX IF NOT EXISTS "idx_forum_posts_author"      ON "forum_posts"("created_by");

-- ─── 4. Bump thread.updated_at on new post (drives "recent activity" sort) ─
CREATE OR REPLACE FUNCTION "bump_forum_thread_updated_at"() RETURNS trigger AS $$
BEGIN
  UPDATE "forum_threads" SET "updated_at" = now() WHERE "id" = NEW."thread_id";
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_bump_forum_thread_updated_at" ON "forum_posts";
CREATE TRIGGER "trg_bump_forum_thread_updated_at"
  AFTER INSERT ON "forum_posts"
  FOR EACH ROW EXECUTE FUNCTION "bump_forum_thread_updated_at"();
