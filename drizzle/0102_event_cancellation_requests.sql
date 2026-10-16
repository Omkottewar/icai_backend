-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0102 — Event cancellation becomes a request-approval flow
--
-- Members and students no longer have the power to cancel their own event
-- registration directly. Instead, the dashboard button submits a cancellation
-- REQUEST (with a reason) that an admin / branch_chairman reviews and either
-- approves (which performs the actual cancellation + decrements seat count +
-- promotes waitlist + flags the payment for treasurer refund if paid) or
-- rejects (which clears the request and leaves the registration intact).
--
-- Design choice: store the request state as new columns on event_registrations
-- rather than a sibling `event_cancellation_requests` table. One pending
-- request at a time per registration row is the only valid state — a table
-- adds no value and splits the audit trail across two places.
--
-- Columns:
--   cancellation_requested_at   — set when user clicks "Request cancellation".
--                                  NULL means no pending request.
--   cancellation_reason         — user-supplied text explaining why.
--   cancellation_decided_at     — admin's approve/reject timestamp. NULL
--                                  while request is pending.
--   cancellation_decided_by     — the admin user_id who approved/rejected.
--   cancellation_decision       — 'approved' | 'rejected'. NULL while pending.
--   cancellation_reject_reason  — admin's note shown to the user if rejected.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "event_registrations"
  ADD COLUMN IF NOT EXISTS "cancellation_requested_at"  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "cancellation_reason"        TEXT,
  ADD COLUMN IF NOT EXISTS "cancellation_decided_at"    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS "cancellation_decided_by"    UUID REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "cancellation_decision"      TEXT,
  ADD COLUMN IF NOT EXISTS "cancellation_reject_reason" TEXT;

-- Partial index — the admin queue query will constantly filter for pending
-- requests (requested_at IS NOT NULL AND decided_at IS NULL). A partial index
-- over just those rows stays tiny.
CREATE INDEX IF NOT EXISTS "idx_event_registrations_pending_cancellation"
  ON "event_registrations" ("cancellation_requested_at")
  WHERE "cancellation_requested_at" IS NOT NULL
    AND "cancellation_decided_at"   IS NULL
    AND "deleted_at"                IS NULL;


-- ─── Notification templates ────────────────────────────────────────────────
-- Three new templates covering the full approval loop.
--
-- cancellation_requested_admin  → each active branch_chairman + admin when a
--                                  user files a cancellation request.
-- cancellation_approved_payer   → user when admin approves (includes refund
--                                  note if the payment was paid).
-- cancellation_rejected_payer   → user when admin rejects (includes the
--                                  admin's rejection reason).
--
-- All use plain {{var}} substitution — notify.ts does no conditional logic.

INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('cancellation_requested_admin',
   'Cancellation request — admin review needed',
   'Fires to every active branch chairman + admin when a member files a cancellation request for an event registration.',
   ARRAY['inapp','email']::text[],
   'Cancellation request — {{event_title}}',
   E'Hi {{first_name}},\n\n{{member_name}} ({{member_email}}) has requested cancellation of their registration for "{{event_title}}" on {{event_date}}.\n\nReason given:\n  {{cancellation_reason}}\n\nReview this request from the admin console:\n{{review_link}}\n\n— ICAI Nagpur Portal',
   'Cancellation request: {{event_title}}',
   '{{member_name}} — {{cancellation_reason_short}}')
ON CONFLICT (key) DO NOTHING;

INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('cancellation_approved_payer',
   'Cancellation approved',
   'Fires to the member when the admin approves their event registration cancellation request. Includes refund note if the registration was paid.',
   ARRAY['inapp','email']::text[],
   'Your cancellation for {{event_title}} is approved',
   E'Hi {{first_name}},\n\nYour cancellation request for "{{event_title}}" on {{event_date}} has been approved. Your seat has been released.\n\n{{refund_line}}\n\nIf you change your mind, you can register again from the events page (as long as seats are still available).\n\n— ICAI Nagpur Branch (WIRC)',
   'Cancellation approved: {{event_title}}',
   'Seat released. {{refund_line_short}}')
ON CONFLICT (key) DO NOTHING;

INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('cancellation_rejected_payer',
   'Cancellation request declined',
   'Fires to the member when the admin rejects their event registration cancellation request. Includes the admin''s rejection reason.',
   ARRAY['inapp','email']::text[],
   'Your cancellation request for {{event_title}} was declined',
   E'Hi {{first_name}},\n\nYour cancellation request for "{{event_title}}" on {{event_date}} has been declined.\n\nReason from the branch:\n  {{reject_reason}}\n\nYour registration is still active. If you have questions, reply to this email or contact nagpur@icai.org.\n\n— ICAI Nagpur Branch (WIRC)',
   'Cancellation declined: {{event_title}}',
   'Reason: {{reject_reason_short}}')
ON CONFLICT (key) DO NOTHING;
