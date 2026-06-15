-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0030 — branch-level content tables
--
-- Six tables that back the Resources page, About page, and Photo Gallery.
-- These were all hard-coded in frontend/src/data/constants.js until now —
-- this migration moves them under admin control.
--
--   paper_presentations  — PDFs from past Nagpur seminars (with disclaimer)
--   gallery_albums       — One album per event/occasion
--   gallery_photos       — Photos inside an album
--   branch_newsletters   — Monthly newsletter PDFs
--   office_bearers       — Current Managing Committee + all historical office
--                          bearers (Past Chairmen is just a filter on this)
--   annual_reports       — Yearly branch report PDFs
--
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── paper_presentations ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "paper_presentations" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "title"          text NOT NULL,
  "speaker_name"   text NOT NULL,
  "committee_tag"  text,
  "event_id"       uuid REFERENCES "events"("id") ON DELETE SET NULL,
  "presented_on"   date,
  "pdf_file_id"    uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "description"    text,
  "hidden"         boolean NOT NULL DEFAULT false,
  "sort_order"     integer NOT NULL DEFAULT 0,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "paper_presentations_committee_idx"
  ON "paper_presentations" ("committee_tag");
CREATE INDEX IF NOT EXISTS "paper_presentations_presented_idx"
  ON "paper_presentations" ("presented_on" DESC NULLS LAST);

-- ─── gallery_albums ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "gallery_albums" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "title"          text NOT NULL,
  "event_id"       uuid REFERENCES "events"("id") ON DELETE SET NULL,
  "committee_tag"  text,
  "occurred_on"    date,
  "description"    text,
  "cover_file_id"  uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "hidden"         boolean NOT NULL DEFAULT false,
  "sort_order"     integer NOT NULL DEFAULT 0,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "gallery_albums_committee_idx"
  ON "gallery_albums" ("committee_tag");
CREATE INDEX IF NOT EXISTS "gallery_albums_occurred_idx"
  ON "gallery_albums" ("occurred_on" DESC NULLS LAST);

-- ─── gallery_photos ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "gallery_photos" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "album_id"    uuid NOT NULL REFERENCES "gallery_albums"("id") ON DELETE CASCADE,
  "file_id"     uuid NOT NULL REFERENCES "files"("id") ON DELETE CASCADE,
  "caption"     text,
  "sort_order"  integer NOT NULL DEFAULT 0,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "gallery_photos_album_idx"
  ON "gallery_photos" ("album_id", "sort_order");

-- ─── branch_newsletters ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "branch_newsletters" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "title"          text NOT NULL,
  "issue_month"    integer NOT NULL,
  "issue_year"     integer NOT NULL,
  "pdf_file_id"    uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "cover_file_id"  uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "editor_note"    text,
  "published_at"   timestamptz,
  "hidden"         boolean NOT NULL DEFAULT false,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT branch_newsletters_month_chk CHECK (issue_month BETWEEN 1 AND 12),
  CONSTRAINT branch_newsletters_year_chk  CHECK (issue_year  BETWEEN 1950 AND 2100)
);

-- One newsletter per (year, month). Treat this as the canonical key for upsert.
CREATE UNIQUE INDEX IF NOT EXISTS "branch_newsletters_issue_uq"
  ON "branch_newsletters" ("issue_year", "issue_month");

-- ─── office_bearers ──────────────────────────────────────────────────────────
-- One table for the entire history. "Past Chairmen" is just a filter on
-- role_code='chairman' ORDER BY term_label DESC.
CREATE TABLE IF NOT EXISTS "office_bearers" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "term_label"     text NOT NULL,                 -- "2025-26"
  "role_label"     text NOT NULL,                 -- "Chairman", "Vice-Chairman", "Secretary", ...
  "role_code"      text,                          -- 'chairman' | 'vice_chairman' | 'secretary' | 'treasurer' | 'wicasa_chairman' | 'member' | ...
  "person_name"    text NOT NULL,
  "photo_file_id"  uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "bio"            text,
  "email"          text,
  "phone"          text,
  "is_current"     boolean NOT NULL DEFAULT false,
  "tenure_start"   date,
  "tenure_end"     date,
  "sort_order"     integer NOT NULL DEFAULT 0,
  "hidden"         boolean NOT NULL DEFAULT false,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "office_bearers_term_idx"     ON "office_bearers" ("term_label" DESC);
CREATE INDEX IF NOT EXISTS "office_bearers_current_idx"  ON "office_bearers" ("is_current") WHERE "is_current" = true;
CREATE INDEX IF NOT EXISTS "office_bearers_role_idx"     ON "office_bearers" ("role_code");

-- ─── annual_reports ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "annual_reports" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "fy_label"       text NOT NULL,
  "title"          text,
  "pdf_file_id"    uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "cover_file_id"  uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "summary"        text,
  "published_at"   timestamptz,
  "hidden"         boolean NOT NULL DEFAULT false,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "annual_reports_fy_uq"
  ON "annual_reports" ("fy_label");
