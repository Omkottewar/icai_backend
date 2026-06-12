-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0028 — time_range question type
--
-- Adds 'time_range' to the checklist_question_type enum. Stores a value
-- shaped { start: 'HH:MM', end: 'HH:MM' } — used for "Event time" style
-- questions that span a range (e.g. 5:00 PM – 8:00 PM).
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  ALTER TYPE "checklist_question_type" ADD VALUE IF NOT EXISTS 'time_range';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
