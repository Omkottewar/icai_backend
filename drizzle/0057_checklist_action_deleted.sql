-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0057 — Add 'deleted' to checklist_instance_action enum
--
-- Previously, soft-deleting a checklist instance only set deleted_at and left
-- no audit row identifying WHO deleted it. With the new guard that blocks
-- delete on published/completed events, we want a proper audit trail for the
-- deletes that DO go through.
--
-- Idempotent — Postgres ignores ADD VALUE if the value already exists when
-- IF NOT EXISTS is used.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TYPE "checklist_instance_action" ADD VALUE IF NOT EXISTS 'deleted';
