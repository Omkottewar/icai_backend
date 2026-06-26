-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0054 — Add 'edited' audit action for the checklist question
-- editor endpoint (PUT /:id/questions). Sits in its own file because
-- Postgres rejects ALTER TYPE ADD VALUE inside an explicit transaction
-- (which migration 0053 uses for its data changes).
-- ════════════════════════════════════════════════════════════════════════════

ALTER TYPE checklist_instance_action ADD VALUE IF NOT EXISTS 'edited';
