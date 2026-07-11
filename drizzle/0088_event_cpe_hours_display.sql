-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0088 — Re-add cpe_hours to events (display-only)
--
-- The full CPE feature was removed in migration 0087 (no ICAI publish API
-- available, no internal ledger). The branch still wants to *label* each
-- event with the CPE hours it carries so members know what to expect —
-- purely informational, no crediting, no compliance calculation.
--
-- This is intentionally a plain numeric column with no FK, no history
-- table, no companion enum. If ICAI publishing returns, wire this column
-- into a fresh ledger; if not, it stays as a marketing/attribution field.
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "events"
  ADD COLUMN IF NOT EXISTS "cpe_hours" numeric(4, 1) NOT NULL DEFAULT 0;
