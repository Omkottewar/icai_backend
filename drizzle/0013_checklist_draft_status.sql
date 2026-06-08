-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0013 — Add 'draft' status + 'released' action
--
-- Introduces an admin confirm gate. Newly created instances start in 'draft'
-- and are invisible to fillers/reviewers. Admin reviews the auto-assigned
-- filler/reviewer and clicks "Release", flipping the instance to
-- 'awaiting_fill' and making it visible to the assigned chairman.
--
-- Postgres enum values must be added one at a time; adding 'before/after'
-- here keeps the existing rows compatible (their values stay valid).
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

DO $$ BEGIN
  ALTER TYPE "checklist_instance_status" ADD VALUE IF NOT EXISTS 'draft' BEFORE 'awaiting_fill';
EXCEPTION WHEN others THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE "checklist_instance_action" ADD VALUE IF NOT EXISTS 'released' AFTER 'created';
EXCEPTION WHEN others THEN NULL; END $$;
