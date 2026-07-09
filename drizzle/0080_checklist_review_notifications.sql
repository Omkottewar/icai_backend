-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0080 — Notification templates for checklist approve / reject
--
-- 0036 added checklist_assigned + checklist_submitted, but the closing
-- transitions (approved / rejected) never notified the filler. So a
-- committee chairman who submitted a checklist had no idea whether the
-- branch chairman had approved it or sent it back until they logged in.
-- Adding both templates plus the dispatch wiring in the routes.
--
-- Idempotent — INSERT … ON CONFLICT DO NOTHING.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. checklist_approved — fires when the reviewer approves the whole
--    checklist (single-reviewer flow) OR when the last stage of a multi-
--    stage flow is approved. Recipient is the filler.
INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('checklist_approved',
   'Checklist approved',
   'Fires when a checklist is approved. Recipient is the filler (and any per-section fillers) so they know their submission cleared.',
   ARRAY['inapp','email','webpush']::text[],
   'Checklist approved: {{checklist_title}}',
   E'Hi {{first_name}},\n\n{{reviewer_name}} has approved your checklist:\n\n  "{{checklist_title}}"\n\n{{event_clause}}Open the checklist: {{checklist_link}}\n\n— ICAI Nagpur Branch (WIRC)',
   'Approved: {{checklist_title}}',
   'Approved by {{reviewer_name}}')
ON CONFLICT (key) DO NOTHING;

-- 2. checklist_rejected — fires when the reviewer sends the checklist
--    back. Recipient is the filler (and any per-section fillers) so they
--    know to fix and re-submit. Rejection note is included so the filler
--    doesn't have to open the app to know WHY.
INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('checklist_rejected',
   'Checklist sent back',
   'Fires when a checklist is rejected. Recipient is the filler (and any per-section fillers). The reviewer''s rejection note is embedded.',
   ARRAY['inapp','email','webpush']::text[],
   'Checklist sent back: {{checklist_title}}',
   E'Hi {{first_name}},\n\n{{reviewer_name}} has sent your checklist back for changes:\n\n  "{{checklist_title}}"\n\nReason:\n{{note}}\n\n{{event_clause}}Open to make changes and re-submit: {{checklist_link}}\n\n— ICAI Nagpur Branch (WIRC)',
   'Sent back: {{checklist_title}}',
   '{{reviewer_name}}: {{note}}')
ON CONFLICT (key) DO NOTHING;
