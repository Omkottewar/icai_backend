-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0072 — counselling_requests
--
-- Captures the "book a counselling session" intent before an admin schedules
-- the actual consultations row. See backend/schema/counsellingRequests.ts
-- for the lifecycle notes.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "counselling_requests" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "client_user_id"    uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "kind"              text NOT NULL DEFAULT 'career_counseling',
  "topic"             text NOT NULL,
  "preferred_window"  text,
  "preferred_medium"  text,
  "contact_phone"     text,
  "status"            text NOT NULL DEFAULT 'pending',
  "notes"             text,
  "consultation_id"   uuid,
  "scheduled_at"      timestamptz,
  "completed_at"      timestamptz,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "counselling_requests_status_idx"
  ON "counselling_requests" ("status");
CREATE INDEX IF NOT EXISTS "counselling_requests_client_idx"
  ON "counselling_requests" ("client_user_id");
