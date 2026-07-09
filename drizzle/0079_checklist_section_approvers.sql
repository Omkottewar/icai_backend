-- Per-section approvers.
--
-- Extends checklist_instance_section_assignments with an optional approver_id
-- column so each section of a checklist can have its own reviewer. The
-- assignee_id (filler) column is unchanged.
--
-- Semantics:
--   * If approver_id IS NULL on a section, the checklist-level
--     assigned_review_user_id continues to sign off that section (old behaviour).
--   * If approver_id IS NOT NULL, that user takes over sign-off for THAT
--     section only. The checklist-level reviewer still owns any section that
--     doesn't have its own approver.

ALTER TABLE "checklist_instance_section_assignments"
  ADD COLUMN IF NOT EXISTS "approver_id" uuid
  REFERENCES "users" ("id") ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS "idx_checklist_section_assignments_approver"
  ON "checklist_instance_section_assignments" ("approver_id");
