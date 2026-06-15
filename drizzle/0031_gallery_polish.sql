-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0031 — gallery polish (image variants, alt text, album visibility)
--
-- Bumps the gallery to industry-standard hygiene:
--   * `files` gets image-variant paths so we can serve a 240px thumb in the
--     grid and an 800px medium in the lightbox, instead of shipping a 4 MB
--     original every time. Original stays in `storage_path` for the download
--     button. Variants are NULL for non-image files.
--   * `files.alt_text` — required for accessibility on the gallery.
--   * `gallery_albums.visibility` — three-tier access (public / members /
--     private) instead of the binary `hidden` flag, which is a non-tier
--     editorial state.
--
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── files: image variants + alt text ────────────────────────────────────────
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "thumb_path"    text;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "medium_path"   text;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "width"         integer;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "height"        integer;
ALTER TABLE "files" ADD COLUMN IF NOT EXISTS "alt_text"      text;

-- ─── gallery_albums: three-tier visibility ───────────────────────────────────
-- 'public'  = anyone (current default)
-- 'members' = logged-in members only (gated at the API)
-- 'private' = admin-only (effectively hidden from everyone else)
ALTER TABLE "gallery_albums"
  ADD COLUMN IF NOT EXISTS "visibility" text NOT NULL DEFAULT 'public';

DO $$ BEGIN
  ALTER TABLE "gallery_albums"
    ADD CONSTRAINT gallery_albums_visibility_chk
    CHECK (visibility IN ('public', 'members', 'private'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Backfill: anything hidden=true gets visibility='private'. Keeps the old
-- single-toggle behaviour working for already-uploaded albums.
UPDATE "gallery_albums"
  SET visibility = 'private'
  WHERE hidden = true
    AND visibility = 'public';   -- only touch rows that haven't been migrated already
