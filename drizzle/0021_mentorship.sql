-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0021 — mentorship_requests
--
-- Free, student-initiated mentorship pairings managed by WICASA. Separate
-- from `consultations` (those are paid 1-on-1 career-counselling slots with
-- their own payment/medium contract).
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "mentorship_requests" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "student_user_id"   uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "mentor_user_id"    uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "topic"             text NOT NULL,
  "preferred_window"  text,
  "status"            text NOT NULL DEFAULT 'pending',
  "notes"             text,
  "matched_at"        timestamptz,
  "scheduled_at"      timestamptz,
  "completed_at"      timestamptz,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mentorship_status_chk
    CHECK (status IN ('pending','matched','scheduled','completed','cancelled'))
);

CREATE INDEX IF NOT EXISTS "mentorship_status_idx"  ON "mentorship_requests" ("status");
CREATE INDEX IF NOT EXISTS "mentorship_mentor_idx"  ON "mentorship_requests" ("mentor_user_id");
CREATE INDEX IF NOT EXISTS "mentorship_student_idx" ON "mentorship_requests" ("student_user_id");
