-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0093 — Notification templates for the job board
--
-- Seeds five new notification_templates rows so the jobAlerts / applications
-- code can call notify({ template_key: 'job_alert_new_posting', ... }) and
-- have the copy resolve through the standard notify() pipeline.
-- All template bodies are editable at /admin/notification-templates.
--
-- Idempotent — uses INSERT … ON CONFLICT DO NOTHING (mirrors 0036).
-- ════════════════════════════════════════════════════════════════════════════

-- 1. job_alert_new_posting — fires the moment a posting becomes 'active',
--    to every matching subscriber whose frequency='instant' and whose
--    optional location / experience filters pass. This is the headline
--    feature: subscribers hear about new openings without polling.
INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('job_alert_new_posting',
   'Job alert — new posting',
   'Sent to subscribers with frequency=instant when a matching posting is activated.',
   ARRAY['inapp','email','webpush']::text[],
   'New {{posting_type}} opening: {{posting_title}}',
   E'Hi {{first_name}},\n\nA new {{posting_type}} opening in "{{category_name}}" has just been posted:\n\n  {{posting_title}}\n  {{org_name}}{{location_line}}{{experience_line}}\n\nView & apply: {{posting_url}}\n\nYou are receiving this because you subscribed to {{category_name}} alerts. Manage your preferences: {{manage_url}}\n\n— ICAI Nagpur Branch (WIRC)',
   'New {{posting_type}}: {{posting_title}}',
   '{{org_name}} · {{category_name}}')
ON CONFLICT (key) DO NOTHING;

-- 2. job_alert_daily_digest — batched 07:00 IST send with everything posted
--    in the last 24h that matched the subscriber.
INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('job_alert_daily_digest',
   'Job alert — daily digest',
   'Batched digest of new openings sent to subscribers with frequency=daily_digest.',
   ARRAY['inapp','email']::text[],
   '{{count}} new job opening{{plural}} for you today',
   E'Hi {{first_name}},\n\nHere''s what was posted in the last 24 hours matching your job alerts:\n\n{{digest_body}}\n\nBrowse all openings: {{listing_url}}\nManage your preferences: {{manage_url}}\n\n— ICAI Nagpur Branch (WIRC)',
   '{{count}} new opening{{plural}}',
   '{{digest_summary}}')
ON CONFLICT (key) DO NOTHING;

-- 3. job_alert_weekly_digest — same shape, Monday 07:00 IST.
INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('job_alert_weekly_digest',
   'Job alert — weekly digest',
   'Weekly (Monday) digest of new openings sent to subscribers with frequency=weekly_digest.',
   ARRAY['inapp','email']::text[],
   'This week''s new openings — {{count}} match{{plural}}',
   E'Hi {{first_name}},\n\nHere are the openings posted over the past week that matched your alerts:\n\n{{digest_body}}\n\nBrowse all openings: {{listing_url}}\nManage your preferences: {{manage_url}}\n\n— ICAI Nagpur Branch (WIRC)',
   '{{count}} new opening{{plural}} this week',
   '{{digest_summary}}')
ON CONFLICT (key) DO NOTHING;

-- 4. job_alert_confirm — double opt-in email sent on first subscription per
--    email address. Sent as a stand-alone template so its copy can be edited
--    without affecting the new-posting alert.
INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('job_alert_confirm',
   'Job alert — confirm subscription',
   'Sent once per email address on first subscription — the recipient must click the link to activate future alerts.',
   ARRAY['inapp','email']::text[],
   'Confirm your job alert subscription',
   E'Hi {{first_name}},\n\nYou just subscribed to job alerts for {{category_list}}. Click the link below to confirm and start receiving new-opening emails:\n\n{{confirm_url}}\n\nIf you didn''t sign up for this, you can safely ignore this email — no alerts will be sent.\n\n— ICAI Nagpur Branch (WIRC)',
   'Confirm your job alerts',
   'Click the confirmation link in the email we just sent.')
ON CONFLICT (key) DO NOTHING;

-- 5. job_application_received — sent to the employer / firm poster the
--    moment an applicant hits Apply. Loud-and-clear: the whole point of
--    the jobs board is that the poster hears about interest fast.
INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('job_application_received',
   'Job application received',
   'Sent to the posting''s employer/poster whenever a member/student applies.',
   ARRAY['inapp','email']::text[],
   'New application: {{posting_title}}',
   E'Hi {{first_name}},\n\n{{applicant_name}} just applied to your opening:\n\n  {{posting_title}}\n  {{org_name}}\n\nContact: {{applicant_email}}{{applicant_phone_line}}\n\nReview the application and download the resume: {{applicants_url}}\n\n— ICAI Nagpur Branch (WIRC)',
   'New application: {{posting_title}}',
   '{{applicant_name}} applied')
ON CONFLICT (key) DO NOTHING;

-- 6. job_application_status_changed — sent to the applicant whenever the
--    employer moves the status forward (shortlisted, interview, offered,
--    hired, rejected). The template body picks up {{status_label}} at
--    dispatch time so a single template covers every transition.
INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('job_application_status_changed',
   'Job application status changed',
   'Sent to the applicant on every status update from the employer.',
   ARRAY['inapp','email']::text[],
   'Your application for {{posting_title}} — {{status_label}}',
   E'Hi {{first_name}},\n\n{{org_name}} has updated your application:\n\n  Posting: {{posting_title}}\n  Status: {{status_label}}\n\n{{status_note_block}}View your application: {{application_url}}\n\n— ICAI Nagpur Branch (WIRC)',
   'Application update: {{status_label}}',
   '{{posting_title}} · {{org_name}}')
ON CONFLICT (key) DO NOTHING;
