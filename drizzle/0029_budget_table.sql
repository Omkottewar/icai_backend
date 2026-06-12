-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0029 — budget_table question type
--
-- Adds 'budget_table' to checklist_question_type. Represents a structured
-- event budget table matching the branch's existing Excel format
-- (Revenue side + per-faculty / addable / single-amount expense categories
-- + auto-totals + deficit/surplus). Stored as one JSON blob; see
-- backend/server/lib/checklistQuestions.ts validator for the shape.
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  ALTER TYPE "checklist_question_type" ADD VALUE IF NOT EXISTS 'budget_table';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
