-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0095 — View counter on job postings
--
-- Adds a `view_count` column to job_postings so employers can see how many
-- members are actually reading a posting vs. applying. Increments happen on
-- the public detail-page fetch (GET /api/jobs/:id).
--
-- Stored as a plain integer with a defensive default — the counter is best-
-- effort telemetry, not something we transact against. A dropped increment
-- doesn't matter for the ratio the employer cares about.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE job_postings
  ADD COLUMN IF NOT EXISTS view_count INTEGER NOT NULL DEFAULT 0;
