-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0036 — Notification templates for checklist lifecycle
--
-- The chairman / committee chairman / section assignees never knew a
-- checklist had been assigned to them. The POST /checklist-instances
-- endpoint created the row and auto-released it, but never fired a
-- notification — so the only way to discover a pending checklist was to
-- log in and check the dashboard. This migration adds the two missing
-- template keys; the dispatch wiring lives in routes/checklistInstances.ts.
--
-- Idempotent — uses INSERT … ON CONFLICT DO NOTHING.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. checklist_assigned — fires when admin creates an instance, releases a
--    draft, or adds a new section assignee. Sent to the user who has new
--    work to fill in.
INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('checklist_assigned',
   'Checklist assigned',
   'Fires when a checklist is assigned to a user — admin creates an instance, releases a draft, or adds a new section assignee. The recipient is whoever has new work to do.',
   ARRAY['inapp','email','webpush']::text[],
   'New checklist to fill: {{checklist_title}}',
   E'Hi {{first_name}},\n\n{{assigner_name}} has assigned you a checklist:\n\n  "{{checklist_title}}"{{section_clause}}\n\n{{event_clause}}Open the checklist: {{checklist_link}}\n\nIf this is unexpected, please reply to this email so the assigner can reassign.\n\n— Nagpur Branch of WIRC of ICAI',
   '{{checklist_title}}',
   '{{section_summary}}')
ON CONFLICT (key) DO NOTHING;

-- 2. checklist_submitted — fires when the filler hits Submit. Goes to the
--    reviewer so they know there's something waiting in the approvals queue.
INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('checklist_submitted',
   'Checklist submitted for review',
   'Fires when the filler submits a checklist. Recipient is the assigned reviewer (branch chairman for event-bound instances) so they can approve / send back.',
   ARRAY['inapp','email','webpush']::text[],
   'Checklist ready for your review: {{checklist_title}}',
   E'Hi {{first_name}},\n\n{{filler_name}} has submitted a checklist for your review:\n\n  "{{checklist_title}}"\n\n{{event_clause}}Open to approve or send back: {{checklist_link}}\n\n— Nagpur Branch of WIRC of ICAI',
   'Ready for review: {{checklist_title}}',
   'Submitted by {{filler_name}}')
ON CONFLICT (key) DO NOTHING;
