-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0081 — Per-section approval state
--
-- The prior model let ANY per-section approver approve the whole checklist
-- in a single click. That defeats "multiple approvers per checklist" — one
-- approver could unilaterally finalise sections that were assigned to
-- someone else.
--
-- This migration adds per-section approval STATE to the existing
-- checklist_instance_section_assignments table:
--   • approval_status   : 'pending' | 'approved' | 'rejected'
--   • decided_by / _at  : who decided and when
--   • note              : optional reason (mandatory for rejections)
--
-- On submit, the app now ensures one row per section_heading exists (even
-- if no per-section approver was picked — approver_id stays NULL and the
-- checklist-level assigned_review_user_id / template review_role holder
-- can act on that section). On every approve/reject, we recompute the
-- whole instance's status:
--     • any rejected → instance = rejected
--     • all approved → instance = approved
--     • else         → instance stays in awaiting_review
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "checklist_instance_section_assignments"
  ADD COLUMN IF NOT EXISTS "approval_status" text NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "decided_by"      uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "decided_at"      timestamptz,
  ADD COLUMN IF NOT EXISTS "note"            text;

-- Enum guard — Postgres has no proper CHECK helper via drizzle, so we add
-- a lightweight text check to catch typos in code paths that write directly.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'checklist_section_approval_status_valid'
  ) THEN
    ALTER TABLE "checklist_instance_section_assignments"
      ADD CONSTRAINT "checklist_section_approval_status_valid"
      CHECK ("approval_status" IN ('pending','approved','rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "idx_checklist_section_assignments_status"
  ON "checklist_instance_section_assignments" ("instance_id", "approval_status");
