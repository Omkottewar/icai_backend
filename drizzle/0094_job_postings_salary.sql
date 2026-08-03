-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0094 — Salary/CTC on job postings
--
-- Adds an optional salary range to job_postings so employers can list what
-- they're paying (or the branch can list the stipend on an articleship
-- seat). Money stays in paise, matching every other money column in the
-- schema. Both ends of the range are nullable so an employer can post
-- "up to ₹8L", "from ₹12L", or omit the range entirely.
--
-- salary_period distinguishes monthly stipends (articleship) from annual
-- CTC (jobs) from per-engagement fees (assignments). Kept as a text column
-- with a CHECK — a Postgres enum here would add ceremony without value.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE job_postings
  ADD COLUMN IF NOT EXISTS salary_paise_min BIGINT,
  ADD COLUMN IF NOT EXISTS salary_paise_max BIGINT,
  ADD COLUMN IF NOT EXISTS salary_period    TEXT NOT NULL DEFAULT 'monthly';

-- Sanity checks so a bad payload can't slip past — non-negative and
-- min ≤ max when both are set.
ALTER TABLE job_postings
  DROP CONSTRAINT IF EXISTS job_postings_salary_period_ck,
  ADD CONSTRAINT job_postings_salary_period_ck
    CHECK (salary_period IN ('monthly', 'annual', 'per_engagement'));

ALTER TABLE job_postings
  DROP CONSTRAINT IF EXISTS job_postings_salary_nonneg_ck,
  ADD CONSTRAINT job_postings_salary_nonneg_ck
    CHECK (
      (salary_paise_min IS NULL OR salary_paise_min >= 0) AND
      (salary_paise_max IS NULL OR salary_paise_max >= 0)
    );

ALTER TABLE job_postings
  DROP CONSTRAINT IF EXISTS job_postings_salary_range_ck,
  ADD CONSTRAINT job_postings_salary_range_ck
    CHECK (
      salary_paise_min IS NULL OR
      salary_paise_max IS NULL OR
      salary_paise_min <= salary_paise_max
    );
