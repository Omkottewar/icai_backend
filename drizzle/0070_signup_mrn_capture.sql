-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0070 — Capture the MRN declared at signup on the users row.
--
-- Members type their MRN on /signup, but until now the value was only used
-- for the live directory check on that page and then discarded. Branch
-- admins reviewing pending signup approvals had no way to see the MRN or
-- whether it matched the imported ICAI directory — so they were approving
-- blind.
--
-- We now stash both pieces on the users row:
--   • signup_mrn                — the raw MRN string the user typed (nullable
--                                 because non-member signups leave it empty).
--   • signup_mrn_in_directory   — boolean lookup against icai_member_master
--                                 at signup time. TRUE = found, FALSE = user
--                                 typed something we can't match, NULL = no
--                                 MRN was provided.
--
-- No unique constraint on signup_mrn — the confirmed MRN still lives in
-- member_profiles (with its own uniqueness). This column is the "declared,
-- unverified" version specifically for admin review.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS signup_mrn              text,
  ADD COLUMN IF NOT EXISTS signup_mrn_in_directory boolean;
