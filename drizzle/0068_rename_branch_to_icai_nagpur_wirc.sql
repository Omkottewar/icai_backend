-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0068 — Rename branch everywhere to "ICAI Nagpur Branch (WIRC)".
--
-- Earlier seeds + migrations used the form "Nagpur Branch of WIRC of ICAI"
-- (and a few used "Nagpur Branch of ICAI"). The client has standardised on
-- "ICAI Nagpur Branch (WIRC)" — this migration rewrites every DB-stored
-- occurrence so the public site, admin UI, and outbound emails all match.
--
-- Scope:
--   1. branches.name (single row keyed by code='NGP')
--   2. notification_templates.email_subject + email_body — every template
--      with the old sign-off line is updated regardless of updated_by, so
--      admin-edited templates also get the rename. The substring replace
--      preserves any other admin edits.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. branches.name ─────────────────────────────────────────────────────
UPDATE branches
   SET name = 'ICAI Nagpur Branch (WIRC)'
 WHERE code = 'NGP'
   AND name IN ('Nagpur Branch of WIRC of ICAI', 'Nagpur Branch of ICAI');

-- ─── 2. notification_templates ────────────────────────────────────────────
-- Substring replace on both subject + body so admin-customised templates
-- keep their changes but still get the rename applied.
UPDATE notification_templates
   SET email_subject = REPLACE(email_subject, 'Nagpur Branch of WIRC of ICAI', 'ICAI Nagpur Branch (WIRC)')
 WHERE email_subject LIKE '%Nagpur Branch of WIRC of ICAI%';

UPDATE notification_templates
   SET email_body = REPLACE(email_body, 'Nagpur Branch of WIRC of ICAI', 'ICAI Nagpur Branch (WIRC)')
 WHERE email_body LIKE '%Nagpur Branch of WIRC of ICAI%';

UPDATE notification_templates
   SET email_subject = REPLACE(email_subject, 'Nagpur Branch of ICAI', 'ICAI Nagpur Branch (WIRC)')
 WHERE email_subject LIKE '%Nagpur Branch of ICAI%'
   AND email_subject NOT LIKE '%ICAI Nagpur Branch (WIRC)%';

UPDATE notification_templates
   SET email_body = REPLACE(email_body, 'Nagpur Branch of ICAI', 'ICAI Nagpur Branch (WIRC)')
 WHERE email_body LIKE '%Nagpur Branch of ICAI%'
   AND email_body NOT LIKE '%ICAI Nagpur Branch (WIRC)%';

-- ─── 3. inapp_title / inapp_body (rarely use the branch name, but check) ──
UPDATE notification_templates
   SET inapp_title = REPLACE(inapp_title, 'Nagpur Branch of WIRC of ICAI', 'ICAI Nagpur Branch (WIRC)')
 WHERE inapp_title LIKE '%Nagpur Branch of WIRC of ICAI%';

UPDATE notification_templates
   SET inapp_body = REPLACE(inapp_body, 'Nagpur Branch of WIRC of ICAI', 'ICAI Nagpur Branch (WIRC)')
 WHERE inapp_body LIKE '%Nagpur Branch of WIRC of ICAI%';
