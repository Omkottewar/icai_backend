-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0067 — Polish notification template copy.
--
-- Pairs with the new branded HTML envelope in server/lib/emailTemplate.ts.
-- The envelope auto-derives a CTA button label from the text immediately
-- before the action URL. This migration tweaks weak/awkward action labels
-- so the rendered button reads naturally ("View policy" instead of "policy",
-- "Read newsletter" instead of "Read it", etc.).
--
-- Safety: only updates rows that haven't been touched by an admin yet
-- (updated_by IS NULL). Admin edits via /admin/notification-templates are
-- preserved verbatim.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── room_booking_confirmed: "policy: link" → "View policy: link" ─────────
UPDATE notification_templates
   SET email_body = 'Hi {{first_name}},

Your booking of {{room_name}} for {{booking_date}}, {{slot}} is confirmed. Deposit of ₹{{deposit}} received.

View policy: {{policy_link}}

— ICAI Nagpur Branch (WIRC)'
 WHERE key = 'room_booking_confirmed'
   AND updated_by IS NULL;

-- ─── newsletter_published: "Read it" → "Read newsletter" ──────────────────
UPDATE notification_templates
   SET email_body = 'Hi {{first_name}},

The {{month}} {{year}} edition of our branch newsletter is out.

Highlights: {{highlights}}

Read newsletter: {{newsletter_link}}

— ICAI Nagpur Branch (WIRC)'
 WHERE key = 'newsletter_published'
   AND updated_by IS NULL;

-- ─── jobs_digest: "View them" → "View postings" ───────────────────────────
UPDATE notification_templates
   SET email_body = 'Hi {{first_name}},

{{count}} new job/articleship postings match your profile this week.

View postings: {{jobs_link}}

To stop these digests, update your notification preferences in your dashboard.

— ICAI Nagpur Branch (WIRC)'
 WHERE key = 'jobs_digest'
   AND updated_by IS NULL;

-- ─── checklist_pending_approval: tighten action label ─────────────────────
UPDATE notification_templates
   SET email_body = 'Hi {{approver_name}},

The event checklist for {{event_title}} ({{event_date}}) is awaiting your approval. Pending items auto-escalate after {{sla_days}} days.

Review checklist: {{checklist_link}}

— ICAI Nagpur Branch (WIRC)'
 WHERE key = 'checklist_pending_approval'
   AND updated_by IS NULL;

-- ─── checklist_submitted: tighten action label ────────────────────────────
UPDATE notification_templates
   SET email_body = 'Hi {{first_name}},

{{filler_name}} has submitted a checklist for your review:

  "{{checklist_title}}"

{{event_clause}}Review checklist: {{checklist_link}}

— ICAI Nagpur Branch (WIRC)'
 WHERE key = 'checklist_submitted'
   AND updated_by IS NULL;

-- ─── grievance_ack: clearer status-tracking phrasing + 48h SLA highlight ──
UPDATE notification_templates
   SET email_subject = 'Grievance received — {{ticket_no}}',
       email_body = 'Hi {{first_name}},

Thank you for reaching out. Your grievance has been logged with reference number {{ticket_no}} and routed to the concerned team.

We aim to respond within 48 hours.

Track status: {{status_link}}

— ICAI Nagpur Branch (WIRC)'
 WHERE key = 'grievance_ack'
   AND updated_by IS NULL;

-- ─── event_registered: add a clear "View event" CTA ───────────────────────
-- The original only links to a calendar download — useful, but the
-- button-derivation lands on "Add to calendar" which is the secondary
-- action. Promote "View event" first so the button reads naturally.
UPDATE notification_templates
   SET email_body = 'Hi {{first_name}},

Your spot for {{event_title}} on {{event_date}} at {{event_time}} ({{event_venue}}) is confirmed. {{cpe_hours}} CPE hours will be credited on attendance.

View event: {{event_link}}

Add to calendar: {{calendar_link}}

Questions? Just reply to this email.

— ICAI Nagpur Branch (WIRC)'
 WHERE key = 'event_registered'
   AND updated_by IS NULL;

-- ─── event_reminder: clearer body, button derivation works ────────────────
UPDATE notification_templates
   SET email_body = 'Hi {{first_name}},

This is a reminder that {{event_title}} starts tomorrow, {{event_date}} at {{event_time}}.

Venue: {{event_venue}}

{{joining_link_or_directions}}

View event: {{event_link}}

We look forward to seeing you.

— ICAI Nagpur Branch (WIRC)'
 WHERE key = 'event_reminder'
   AND updated_by IS NULL;

-- ─── event_waitlist_promoted: parallel structure to event_registered ──────
UPDATE notification_templates
   SET email_subject = 'A seat opened — you''re in for {{event_title}}',
       email_body = 'Hi {{first_name}},

Good news — a seat has opened up and your waitlist spot for {{event_title}} ({{event_date}} at {{event_time}}) is now confirmed.

View event: {{event_link}}

Add to calendar: {{calendar_link}}

— ICAI Nagpur Branch (WIRC)'
 WHERE key = 'event_waitlist_promoted'
   AND updated_by IS NULL;

-- ─── certificate_ready: cleaner CTA wording ───────────────────────────────
UPDATE notification_templates
   SET email_body = 'Hi {{first_name}},

Your participation certificate for {{event_title}} is ready.

Download certificate: {{certificate_link}}

— ICAI Nagpur Branch (WIRC)'
 WHERE key = 'certificate_ready'
   AND updated_by IS NULL;

-- ─── password_reset: explicit "Reset password" CTA ────────────────────────
UPDATE notification_templates
   SET email_body = 'Hi {{first_name}},

We received a request to reset your password. The link below is valid for {{expiry}}.

Reset password: {{reset_link}}

If you didn''t request this, you can safely ignore this email — your password stays the same.

— ICAI Nagpur Branch (WIRC)'
 WHERE key = 'password_reset'
   AND updated_by IS NULL;

-- ─── directory_access_granted: cleaner CTA + brief usage note ─────────────
UPDATE notification_templates
   SET email_body = 'Hi {{first_name}},

Your access to the Members'' Directory has been approved. You can now look up other members and their firms.

Open directory: {{directory_link}}

Please use member contact details responsibly and only for legitimate professional reasons.

— ICAI Nagpur Branch (WIRC)'
 WHERE key = 'directory_access_granted'
   AND updated_by IS NULL;

-- ─── cpe_credit_awarded: clearer phrasing ─────────────────────────────────
UPDATE notification_templates
   SET email_body = 'Hi {{first_name}},

{{cpe_hours}} CPE hours have been credited to your account for attending {{event_title}} on {{event_date}}.

View CPE record: {{cpe_link}}

— ICAI Nagpur Branch (WIRC)'
 WHERE key = 'cpe_credit_awarded'
   AND updated_by IS NULL;
