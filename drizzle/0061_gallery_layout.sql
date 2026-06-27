-- ─── 0061 — Photo Gallery v2: admin-controlled layout + featured spots ────
--
-- Adds three columns to the gallery so admins can shape the public
-- /gallery page beyond a flat grid of albums:
--
--   gallery_albums.is_featured        — pin an album to the top hero row
--   gallery_albums.featured_position  — 1 = hero tile, 2-4 = side tiles
--   gallery_albums.layout             — 'grid' (default) | 'masonry' | 'story'
--                                       Drives how photos inside the album
--                                       render in the lightbox / detail view.
--   gallery_photos.is_featured        — bumps the photo to a 2× tile in the
--                                       masonry layout. No-op for grid/story.
--
-- All additive + IDEMPOTENT. No data migration needed: existing albums
-- default to is_featured=false / layout='grid', which matches today's
-- rendering exactly. New columns are NULL/false until an admin touches
-- them.

-- ── gallery_albums ───────────────────────────────────────────────────────
ALTER TABLE "gallery_albums"
  ADD COLUMN IF NOT EXISTS "is_featured" boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "featured_position" integer,
  ADD COLUMN IF NOT EXISTS "layout" text NOT NULL DEFAULT 'grid';

-- Constrain layout to known values so a typo can't break the public page.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gallery_albums_layout_ck'
  ) THEN
    ALTER TABLE "gallery_albums"
      ADD CONSTRAINT "gallery_albums_layout_ck"
      CHECK ("layout" IN ('grid', 'masonry', 'story'));
  END IF;
END$$;

-- featured_position is 1..4 (1 = hero, 2-4 = side tiles). NULL is OK
-- (album simply isn't placed; falls back to chronological).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gallery_albums_featured_pos_ck'
  ) THEN
    ALTER TABLE "gallery_albums"
      ADD CONSTRAINT "gallery_albums_featured_pos_ck"
      CHECK ("featured_position" IS NULL OR ("featured_position" BETWEEN 1 AND 4));
  END IF;
END$$;

-- Partial index — only the handful of featured albums ever live here, so
-- the index stays tiny and the public-page hero query becomes a direct
-- index scan instead of "scan all albums, filter, sort".
CREATE INDEX IF NOT EXISTS "gallery_albums_featured_idx"
  ON "gallery_albums" ("featured_position")
  WHERE "is_featured" = true AND "hidden" = false;

-- ── gallery_photos ───────────────────────────────────────────────────────
ALTER TABLE "gallery_photos"
  ADD COLUMN IF NOT EXISTS "is_featured" boolean NOT NULL DEFAULT false;
-- No new index — existing (album_id, sort_order) is enough; is_featured
-- is read as part of the row, not used as a filter predicate.
