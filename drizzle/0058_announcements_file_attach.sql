-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0058 — Attach an optional PDF (or any uploaded file) to an
-- announcement.
--
-- Existing announcements have a `link_url` (external URL) field. That stays
-- as the catch-all for any external destination. The new `file_id` references
-- a row in `files` (the same table used by paper presentations, gallery,
-- circulars, etc.) so admins can upload a PDF directly from the admin form
-- instead of having to host it somewhere and paste a URL.
--
-- Resolution rule on the frontend: prefer the file URL when both file_id
-- and link_url are set. (Most uploads will be PDFs; nothing in the schema
-- restricts the mime type.)
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "announcements"
  ADD COLUMN IF NOT EXISTS "file_id" uuid
    REFERENCES "files"("id") ON DELETE SET NULL;
