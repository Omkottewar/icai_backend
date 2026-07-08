-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0075 — enrich scholarship_applications for committee review
--
-- The MVP shape (why_applying / current_situation / contact_phone) is too
-- thin for a real scholarship committee to decide. Committees at the ICAI
-- Nagpur branch review applications offline (spreadsheet + paper packet)
-- and need academic + family + category + documents in one row.
--
-- Two new columns keep the shape flexible without another migration each
-- time we add a field:
--   • details          jsonb   — structured payload for all the new fields
--                                (academic / family / category / other-support)
--   • document_file_ids uuid[] — attached-doc file IDs (marksheet, income
--                                proof, other). Files are stored in the
--                                existing `files` table.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "scholarship_applications"
  ADD COLUMN IF NOT EXISTS "details" jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "scholarship_applications"
  ADD COLUMN IF NOT EXISTS "document_file_ids" uuid[] NOT NULL DEFAULT '{}'::uuid[];
