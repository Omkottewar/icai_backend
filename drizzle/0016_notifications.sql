-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0016 — Notifications (in-app + email)
--
-- Adds three tables:
--   • notification_templates   editable copy per S.* template key
--   • notifications            per-user inbox rows
--   • notification_deliveries  per-channel send audit trail
--
-- Seeds the 15 standard templates from requirements §S so the system is
-- usable immediately. Templates are editable from the admin console.
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "notification_templates" (
  "key"           text PRIMARY KEY,
  "name"          text NOT NULL,
  "description"   text,
  "channels"      text[] NOT NULL DEFAULT ARRAY['inapp','email']::text[],
  "email_subject" text,
  "email_body"    text,
  "inapp_title"   text,
  "inapp_body"    text,
  "enabled"       boolean NOT NULL DEFAULT true,
  "updated_by"    uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at"    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "notifications" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "template_key" text REFERENCES "notification_templates"("key") ON DELETE SET NULL,
  "title"        text NOT NULL,
  "body"         text,
  "link_url"     text,
  "metadata"     jsonb NOT NULL DEFAULT '{}'::jsonb,
  "read_at"      timestamptz,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "notifications_user_idx"
  ON "notifications" ("user_id", "created_at" DESC);

-- Partial index — only unread rows are stored, so the bell-badge query
-- (COUNT(*) WHERE user_id = $1 AND read_at IS NULL) is essentially free.
CREATE INDEX IF NOT EXISTS "notifications_user_unread_idx"
  ON "notifications" ("user_id")
  WHERE "read_at" IS NULL;

CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "notification_id" uuid NOT NULL REFERENCES "notifications"("id") ON DELETE CASCADE,
  "channel"         text NOT NULL,
  "recipient"       text NOT NULL,
  "status"          text NOT NULL DEFAULT 'queued',
  "error"           text,
  "attempted_at"    timestamptz NOT NULL DEFAULT now(),
  "sent_at"         timestamptz,
  CONSTRAINT notification_deliveries_channel_chk
    CHECK (channel IN ('email','sms','whatsapp','inapp')),
  CONSTRAINT notification_deliveries_status_chk
    CHECK (status IN ('queued','sent','failed','skipped'))
);

CREATE INDEX IF NOT EXISTS "notification_deliveries_notification_idx"
  ON "notification_deliveries" ("notification_id");

-- ─── Seed templates (Requirements §S.1–S.15) ────────────────────────────────
-- ON CONFLICT (key) DO NOTHING keeps existing edits intact on re-run.

INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('event_registered',
   'Event registration confirmation',
   'Sent immediately after a member registers for an event (free or paid).',
   ARRAY['inapp','email']::text[],
   'You''re registered — {{event_title}}',
   E'Hi {{first_name}},\n\nYour spot for {{event_title}} on {{event_date}} at {{event_time}} ({{event_venue}}) is confirmed.\n\n{{cpe_hours}} CPE hours.\n\nAdd to calendar: {{calendar_link}}\n\nQuestions? Reply to this email.\n\n— Nagpur Branch of WIRC of ICAI',
   'Registered for {{event_title}}',
   '{{event_date}} · {{event_venue}}'),

  ('event_reminder',
   'Event reminder (24h before)',
   'Sent 24 hours before the event starts.',
   ARRAY['inapp','email']::text[],
   'Reminder — {{event_title}} is tomorrow',
   E'Hi {{first_name}},\n\nThis is a reminder that {{event_title}} starts tomorrow, {{event_date}} at {{event_time}} ({{event_venue}}).\n\n{{joining_link_or_directions}}\n\nWe look forward to seeing you.\n\n— Nagpur Branch of WIRC of ICAI',
   'Tomorrow: {{event_title}}',
   '{{event_time}} · {{event_venue}}'),

  ('event_waitlist_promoted',
   'Event waitlist promoted',
   'Sent when a seat opens up and a waitlisted member is moved off the waitlist.',
   ARRAY['inapp','email']::text[],
   'A seat just opened — you''re in for {{event_title}}',
   E'Hi {{first_name}},\n\nGood news — a seat has opened up and you''ve been moved off the waitlist for {{event_title}} on {{event_date}} at {{event_time}}.\n\nYour registration is now confirmed.\n\n{{joining_link_or_directions}}\n\n— Nagpur Branch of WIRC of ICAI',
   'You''re off the waitlist — {{event_title}}',
   'Confirmed for {{event_date}}'),

  ('event_cancelled',
   'Event cancelled',
   'Sent to every registered attendee when an event is cancelled.',
   ARRAY['inapp','email']::text[],
   'Cancelled — {{event_title}} on {{event_date}}',
   E'Hi {{first_name}},\n\nWe regret to inform you that {{event_title}} scheduled for {{event_date}} has been cancelled. Any fee paid will be refunded within {{refund_days}} working days.\n\nWe apologise for the inconvenience.\n\n— Nagpur Branch of WIRC of ICAI',
   'Cancelled: {{event_title}}',
   'Scheduled for {{event_date}}'),

  ('cpe_credit_awarded',
   'CPE credit awarded',
   'Sent when CPE hours are credited to a member.',
   ARRAY['inapp','email']::text[],
   '{{cpe_hours}} CPE hours credited — {{event_title}}',
   E'Hi {{first_name}},\n\n{{cpe_hours}} CPE hours for attending {{event_title}} on {{event_date}} have been credited to your account.\n\nView your CPE record: {{cpe_link}}\n\n— Nagpur Branch of WIRC of ICAI',
   '{{cpe_hours}} CPE hours credited',
   '{{event_title}}'),

  ('certificate_ready',
   'Certificate ready for download',
   'Sent when a participation certificate is generated and available.',
   ARRAY['inapp','email']::text[],
   'Your certificate is ready — {{event_title}}',
   E'Hi {{first_name}},\n\nYour participation certificate for {{event_title}} is ready.\n\nDownload it here: {{certificate_link}}\n\n— Nagpur Branch of WIRC of ICAI',
   'Certificate ready',
   '{{event_title}}'),

  ('directory_access_granted',
   'Membership directory access granted',
   'Sent when a member is approved to view the members'' directory.',
   ARRAY['inapp','email']::text[],
   'Members'' Directory access granted',
   E'Hi {{first_name}},\n\nYour access to the Members'' Directory has been approved.\n\nBrowse the directory here: {{directory_link}}\n\nPlease use member contact details responsibly.\n\n— Nagpur Branch of WIRC of ICAI',
   'Directory access granted',
   'You can now browse the members'' directory.'),

  ('password_reset',
   'Password reset',
   'Sent when a user requests a password reset.',
   ARRAY['email']::text[],
   'Reset your password',
   E'Hi {{first_name}},\n\nWe received a request to reset your password.\n\nClick here to set a new one: {{reset_link}} (valid for {{expiry}}).\n\nIf you didn''t request this, please ignore this email.\n\n— Nagpur Branch of WIRC of ICAI',
   NULL,
   NULL),

  ('jobs_digest',
   'New job postings matching your profile',
   'Weekly digest of new job / articleship postings matching the member''s profile.',
   ARRAY['inapp','email']::text[],
   'New opportunities matching your profile',
   E'Hi {{first_name}},\n\n{{count}} new job/articleship postings match your profile this week.\n\nView them here: {{jobs_link}}\n\nTo stop these digests, update your preferences: {{preferences_link}}\n\n— Nagpur Branch of WIRC of ICAI',
   '{{count}} new job postings',
   'Tap to view'),

  ('newsletter_published',
   'Monthly newsletter',
   'Sent on the day each monthly newsletter is published.',
   ARRAY['inapp','email']::text[],
   '{{month}} Newsletter — Nagpur Branch of WIRC of ICAI',
   E'Hi {{first_name}},\n\nThe {{month}} {{year}} edition of our branch newsletter is out.\n\nRead it here: {{newsletter_link}}\n\nHighlights: {{highlights}}\n\n— Nagpur Branch of WIRC of ICAI',
   '{{month}} newsletter is out',
   'Tap to read'),

  ('checklist_pending_approval',
   'Checklist awaiting your approval',
   'Sent to the approver when an event checklist reaches their stage.',
   ARRAY['inapp','email']::text[],
   'Approval needed — {{event_title}} checklist',
   E'Hi {{approver_name}},\n\nThe event checklist for {{event_title}} ({{event_date}}) is awaiting your approval.\n\nReview and action it here: {{checklist_link}}\n\nPending items auto-escalate after {{sla_days}} days.\n\n— Nagpur Branch of WIRC of ICAI',
   'Checklist needs your review',
   '{{event_title}}'),

  ('room_booking_confirmed',
   'Room booking confirmed',
   'Sent when a room/reading-room booking is confirmed.',
   ARRAY['inapp','email']::text[],
   'Booking confirmed — {{room_name}} on {{booking_date}}',
   E'Hi {{first_name}},\n\nYour booking of {{room_name}} for {{booking_date}}, {{slot}} is confirmed. Deposit of ₹{{deposit}} received.\n\nPlease note the cancellation policy: {{policy_link}}\n\n— Nagpur Branch of WIRC of ICAI',
   'Booking confirmed: {{room_name}}',
   '{{booking_date}} · {{slot}}'),

  ('room_booking_cancelled',
   'Room booking cancelled',
   'Sent when a room booking is cancelled (by member or admin).',
   ARRAY['inapp','email']::text[],
   'Booking cancelled — {{room_name}} on {{booking_date}}',
   E'Hi {{first_name}},\n\nYour booking of {{room_name}} for {{booking_date}}, {{slot}} has been cancelled. Your deposit of ₹{{deposit}} will be refunded as per policy ({{refund_method}}).\n\n— Nagpur Branch of WIRC of ICAI',
   'Booking cancelled',
   '{{room_name}} · {{booking_date}}'),

  ('cabf_receipt',
   'CABF contribution receipt',
   'Sent on receipt of a CA Benevolent Fund contribution. 80G receipt is mailed separately by ICAI HO.',
   ARRAY['inapp','email']::text[],
   'Thank you for your CABF contribution',
   E'Hi {{first_name}},\n\nWe gratefully acknowledge your CA Benevolent Fund contribution of ₹{{amount}} on {{contribution_date}} (Ref: {{receipt_no}}).\n\nYour 80G receipt will be mailed by ICAI HO.\n\n— Nagpur Branch of WIRC of ICAI',
   'CABF contribution received',
   '₹{{amount}} · Ref {{receipt_no}}'),

  ('grievance_ack',
   'Grievance acknowledgement',
   'Sent immediately on grievance submission. Aim: respond within 48 hours.',
   ARRAY['inapp','email']::text[],
   'We''ve received your grievance ({{ticket_no}})',
   E'Hi {{first_name}},\n\nYour grievance has been logged (Ref: {{ticket_no}}) and routed to the concerned team. We aim to respond within 48 hours.\n\nTrack status here: {{status_link}}\n\n— Nagpur Branch of WIRC of ICAI',
   'Grievance logged ({{ticket_no}})',
   'We''ll respond within 48 hours.')
ON CONFLICT (key) DO NOTHING;
