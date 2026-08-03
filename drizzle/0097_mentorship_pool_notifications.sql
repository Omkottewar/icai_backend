-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0097 — Mentorship pool + assignment notifications
--
-- Two changes:
--   • users.willing_to_mentor — a single boolean flag that turns a member
--     into a discoverable mentor. WICASA's mentor picker filters on this.
--     Members toggle it from their dashboard "Mentor availability" card.
--   • Two notification templates:
--       - mentorship_assigned_to_student  → student when WICASA matches them
--       - mentorship_assigned_as_mentor   → mentor when they're picked
--     Both fire from POST /api/admin/mentorship/:id/assign-mentor.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS willing_to_mentor BOOLEAN NOT NULL DEFAULT FALSE;

-- Partial index only over willing mentors — this is what the picker's
-- search-by-name query touches, and it's typically <10% of the user base
-- so a partial index is much smaller than a full one.
CREATE INDEX IF NOT EXISTS idx_users_willing_to_mentor
  ON users (name)
  WHERE willing_to_mentor = TRUE AND deleted_at IS NULL;

-- ─── Notification templates ────────────────────────────────────────────────
-- Body uses only plain {{var}} substitution — our notify() renderer doesn't
-- support Handlebars conditionals. Pluralisation and optional fields are
-- pre-composed by the caller (see routes/admin/mentorship.ts).

INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('mentorship_assigned_to_student',
   'Mentorship — mentor assigned',
   'Fires to the student when WICASA assigns a mentor to their pending request.',
   ARRAY['inapp','email','webpush']::text[],
   'WICASA has assigned {{mentor_name}} as your mentor',
   E'Hi {{first_name}},\n\nGood news — WICASA has reviewed your mentorship request on "{{topic}}" and paired you with:\n\n  {{mentor_name}}\n  {{mentor_contact_line}}\n\nReach out to introduce yourself and set up a first session. WICASA will follow up if scheduling stalls.\n\nSee status on your dashboard: {{link_url}}\n\n— ICAI Nagpur Branch (WIRC), WICASA',
   'Mentor assigned: {{mentor_name}}',
   '{{topic}}')
ON CONFLICT (key) DO NOTHING;

INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('mentorship_assigned_as_mentor',
   'Mentorship — assigned as mentor',
   'Fires to the member when WICASA picks them as a mentee''s mentor.',
   ARRAY['inapp','email','webpush']::text[],
   'You''ve been paired with a mentee — {{student_name}}',
   E'Hi {{first_name}},\n\nWICASA has paired you as mentor for {{student_name}}. Details:\n\n  Topic: {{topic}}\n  Preferred session window: {{preferred_window_line}}\n  Student contact: {{student_contact_line}}\n\n{{admin_notes_line}}Please reach out to schedule a first session. Update the WICASA team once you''ve met.\n\nSee your mentee list: {{link_url}}\n\nThank you for volunteering — the branch appreciates it.\n\n— ICAI Nagpur Branch (WIRC), WICASA',
   'New mentee: {{student_name}}',
   'Topic: {{topic}}')
ON CONFLICT (key) DO NOTHING;
