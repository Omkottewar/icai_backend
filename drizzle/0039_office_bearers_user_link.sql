-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0039 — Link office_bearers to user accounts for ACL sync
--
-- Background: `office_bearers` is the public-facing "who's on the MC this
-- year" listing (photo grid on the About page). `user_role_assignments` is
-- the ACL table that grants real privileges (branch_treasurer, etc.).
-- Until now these were independent, so an admin who removed a treasurer
-- from the office-bearers list expected the dashboard access to also be
-- revoked — but ACL stayed intact and the ex-treasurer kept landing on
-- the treasurer dashboard.
--
-- This migration adds an optional `linked_user_id` to office_bearers. When
-- set, the office-bearer admin endpoint syncs the matching user_role_
-- assignment automatically:
--
--   • Inserting an office_bearer (linked + role_code mapped to ACL) →
--     creates an active user_role_assignment.
--   • Hiding / deleting / un-linking the office_bearer → ends the
--     assignment (effective_to = yesterday).
--   • Changing the linked_user_id → ends old user's assignment, creates
--     new user's assignment.
--
-- The previous design — independent tables — is preserved when
-- linked_user_id is NULL (e.g. a historical office bearer whose user
-- account doesn't exist in our DB).
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE office_bearers
  ADD COLUMN IF NOT EXISTS linked_user_id uuid
    REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS office_bearers_linked_user_idx
  ON office_bearers (linked_user_id)
  WHERE linked_user_id IS NOT NULL;
