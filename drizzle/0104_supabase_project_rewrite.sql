-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0104 — Rewrite stored Supabase project ref
--
-- The branch portal was migrated from Supabase project `ohpjavugvpqjbloxzluf`
-- (paused / over-quota, now unrecoverable) onto `mbejqncvxqascdjqacag`.
-- Env vars (SUPABASE_URL + keys) and 18 hardcoded URLs in code have been
-- updated in the same change. This migration rewrites the one remaining
-- stored surface: `site_content.data` JSON blobs, which admins seed with
-- fully-qualified image URLs (photo_url, image_url, slide_N_url, etc.).
--
-- Any row whose JSON contains the old project host is rewritten to point at
-- the new host; rows without a match are untouched. updated_at is bumped so
-- the admin UI reflects the edit.
--
-- The files table is NOT affected — it stores (bucket, storage_path) and
-- builds URLs at runtime from SUPABASE_URL, so changing env alone fixes
-- everything that goes through the files pipeline.
--
-- NOTE: the actual bytes on the OLD project are unrecoverable. After this
-- migration runs, every rewritten URL will 404 (new bucket is empty)
-- until admin re-uploads replacement files via /admin/site-content.
-- ════════════════════════════════════════════════════════════════════════════

UPDATE site_content
SET
  data       = REPLACE(data::text, 'ohpjavugvpqjbloxzluf', 'mbejqncvxqascdjqacag')::jsonb,
  updated_at = now()
WHERE
  data::text LIKE '%ohpjavugvpqjbloxzluf%';
