-- ─── 0062 — Gallery event-type tag + Video Gallery ────────────────────────
--
-- Two additive changes, both inspired by the legacy nagpuricai.org gallery:
--
--   1. gallery_albums.event_type — orthogonal to committee_tag. Lets us
--      tag an album as Technical / Cultural / Sports / Press / Social /
--      Visit / Other, so members can filter "show me only Sports albums"
--      or "show me Press coverage". committee_tag still drives committee
--      colouring; event_type drives the second filter row.
--
--   2. gallery_videos — separate table for video-gallery entries. Each
--      row stores a video provider (youtube/vimeo/external) + an ID/URL,
--      title, description, occurred date, optional poster image, and
--      committee/event-type tags consistent with gallery_albums. The
--      public page embeds them inline; admins paste a YouTube URL and
--      the public side derives the embed.
--
-- All additive + IDEMPOTENT. Existing albums get event_type=NULL which
-- the public page treats as "Other" / unfiltered.

-- ── gallery_albums.event_type ──────────────────────────────────────────
ALTER TABLE "gallery_albums"
  ADD COLUMN IF NOT EXISTS "event_type" text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gallery_albums_event_type_ck'
  ) THEN
    ALTER TABLE "gallery_albums"
      ADD CONSTRAINT "gallery_albums_event_type_ck"
      CHECK ("event_type" IS NULL OR "event_type" IN (
        'Technical', 'Cultural', 'Sports', 'Press', 'Social', 'Visit', 'Other'
      ));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "gallery_albums_event_type_idx"
  ON "gallery_albums" ("event_type")
  WHERE "hidden" = false;

-- ── gallery_videos ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "gallery_videos" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "title"          text NOT NULL,
  "description"    text,
  "provider"       text NOT NULL DEFAULT 'youtube',
  "video_id"       text NOT NULL,
  "video_url"      text,
  "poster_file_id" uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "event_id"       uuid REFERENCES "events"("id") ON DELETE SET NULL,
  "committee_tag"  text,
  "event_type"     text,
  "occurred_on"    date,
  "duration_secs"  integer,
  "visibility"     text NOT NULL DEFAULT 'public',
  "hidden"         boolean NOT NULL DEFAULT false,
  "is_featured"    boolean NOT NULL DEFAULT false,
  "sort_order"     integer NOT NULL DEFAULT 0,
  "created_at"     timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at"     timestamp with time zone NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gallery_videos_provider_ck'
  ) THEN
    ALTER TABLE "gallery_videos"
      ADD CONSTRAINT "gallery_videos_provider_ck"
      CHECK ("provider" IN ('youtube', 'vimeo', 'external'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gallery_videos_visibility_ck'
  ) THEN
    ALTER TABLE "gallery_videos"
      ADD CONSTRAINT "gallery_videos_visibility_ck"
      CHECK ("visibility" IN ('public', 'members', 'private'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gallery_videos_event_type_ck'
  ) THEN
    ALTER TABLE "gallery_videos"
      ADD CONSTRAINT "gallery_videos_event_type_ck"
      CHECK ("event_type" IS NULL OR "event_type" IN (
        'Technical', 'Cultural', 'Sports', 'Press', 'Social', 'Visit', 'Other'
      ));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "gallery_videos_occurred_idx"
  ON "gallery_videos" ("occurred_on" DESC)
  WHERE "hidden" = false;

CREATE INDEX IF NOT EXISTS "gallery_videos_committee_idx"
  ON "gallery_videos" ("committee_tag")
  WHERE "hidden" = false;

CREATE INDEX IF NOT EXISTS "gallery_videos_event_type_idx"
  ON "gallery_videos" ("event_type")
  WHERE "hidden" = false;

CREATE INDEX IF NOT EXISTS "gallery_videos_featured_idx"
  ON "gallery_videos" ("is_featured", "sort_order")
  WHERE "is_featured" = true AND "hidden" = false;
