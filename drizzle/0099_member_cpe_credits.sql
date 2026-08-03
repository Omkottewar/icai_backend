-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0099 — Self-reported CPE credits on member_profiles
--
-- Members asked for a simple field where they can record their current
-- CPE credit total from the ICAI portal and see it on their dashboard.
-- This is a display-only value: the member types it in, we store it,
-- we show it back. There is no ledger, no per-event attribution, no
-- ICAI sync — that was all removed in migration 0087 and remains gone.
--
-- Numeric with 1 decimal place to match how ICAI reports CPE hours
-- (events.cpe_hours uses the same numeric(4,1)). Nullable so a member
-- who hasn't entered anything shows "—" instead of "0".
--
-- Safe to re-run: ADD COLUMN IF NOT EXISTS.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "member_profiles"
  ADD COLUMN IF NOT EXISTS "cpe_credits" numeric(5, 1);
