-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0096 — Articleship matching: finalisation flow
--
-- Two additions to the articleship_matches table:
--   • student_confirmed_at  — student clicked "I've accepted a firm's offer"
--   • student_declined_at   — student clicked "None of the shortlist worked"
--
-- Both are timestamps so the same row can also record why a match closed.
-- The existing placed_firm_id already tracks which firm they landed at,
-- so we don't duplicate that; these two columns record the STUDENT's
-- side of the loop rather than WICASA's unilateral placement.
--
-- Also seeds two notification templates:
--   • articleship_match_recommended — sent when WICASA hits "Recommend"
--   • articleship_match_placement_confirmed — sent when student confirms
-- Both are admin-editable at /admin/notification-templates.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE articleship_matches
  ADD COLUMN IF NOT EXISTS student_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS student_declined_at  TIMESTAMPTZ;

-- Sanity check: a match can't be both confirmed and declined by the same
-- student. Enforced by CHECK so a bad UI can't put the row in a weird state.
ALTER TABLE articleship_matches
  DROP CONSTRAINT IF EXISTS articleship_matches_finalise_ck,
  ADD CONSTRAINT articleship_matches_finalise_ck
    CHECK (student_confirmed_at IS NULL OR student_declined_at IS NULL);

-- ─── Notification templates ────────────────────────────────────────────────

INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('articleship_match_recommended',
   'Articleship — WICASA has recommended firms',
   'Sent to the student when WICASA moves their submission to status=matched.',
   ARRAY['inapp','email','webpush']::text[],
   'WICASA has shortlisted {{firm_count_label}} for your articleship',
   E'Hi {{first_name}},\n\nGood news — WICASA has reviewed your articleship preferences and shortlisted the following {{firm_count_label}} for you:\n\n{{firm_lines}}\n\nNotes from WICASA: {{notes_line}}\n\nReach out to any of them directly to discuss the seat. Once you''ve accepted a firm''s offer, mark it on your dashboard so WICASA can track placement — the link is below.\n\nView the shortlist and update your status: {{link_url}}\n\n— ICAI Nagpur Branch (WIRC), WICASA',
   'WICASA shortlisted {{firm_count_label}}',
   '{{firm_names_csv}}')
ON CONFLICT (key) DO NOTHING;

INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('articleship_match_placement_confirmed',
   'Articleship — student confirmed placement',
   'Fires to the admin queue when a student marks themselves as placed at a recommended firm.',
   ARRAY['inapp']::text[],
   'Placement confirmed — {{student_name}}',
   E'{{student_name}} has confirmed placement at {{firm_name}}.\n\nUpdate your WICASA records accordingly.',
   'Placement confirmed',
   '{{student_name}} → {{firm_name}}')
ON CONFLICT (key) DO NOTHING;
