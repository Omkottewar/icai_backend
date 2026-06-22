-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0045 — Seed the four default ICAI link-out cards.
--
-- The Resources page top strip (Circulars / Standards / e-Journal / Web-Media)
-- used to be a hardcoded array in the React component. We're switching to a
-- dynamic load from icai_link_cards so the branch admin can update the
-- destination URLs from the admin UI without a code redeploy.
--
-- Seeded with the official ICAI portal as the URL placeholder. The admin
-- updates each row from /admin/resources → "Link cards" to point at the
-- correct deep link (announcements page, standards index, journal archive,
-- web-media policy PDF). Once those are filled in, the four tiles on the
-- public Resources page become real navigations.
--
-- Re-running the migration is safe — we guard on (category, title) so no
-- duplicates if the rows already exist.
-- ════════════════════════════════════════════════════════════════════════════

INSERT INTO icai_link_cards (id, category, title, description, url, icon_emoji, sort_order, active, created_at, updated_at)
SELECT gen_random_uuid(), 'circulars',     'Circulars',           'ICAI announcements, notifications and council decisions.', 'https://www.icai.org/', '📄', 0, true, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM icai_link_cards WHERE category = 'circulars' AND title = 'Circulars');

INSERT INTO icai_link_cards (id, category, title, description, url, icon_emoji, sort_order, active, created_at, updated_at)
SELECT gen_random_uuid(), 'standards',     'Standards (AS / SA)', 'Accounting Standards, Ind AS and Standards on Auditing.',  'https://www.icai.org/', '📘', 0, true, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM icai_link_cards WHERE category = 'standards' AND title = 'Standards (AS / SA)');

INSERT INTO icai_link_cards (id, category, title, description, url, icon_emoji, sort_order, active, created_at, updated_at)
SELECT gen_random_uuid(), 'knowledge_repo','e-Journal Archive',   'Browse The Chartered Accountant journal archives.',         'https://www.icai.org/', '🏆', 0, true, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM icai_link_cards WHERE category = 'knowledge_repo' AND title = 'e-Journal Archive');

INSERT INTO icai_link_cards (id, category, title, description, url, icon_emoji, sort_order, active, created_at, updated_at)
SELECT gen_random_uuid(), 'other',         'Web-Media Policy',    'ICAI guidelines for member online presence.',                'https://www.icai.org/', '🛡️', 0, true, now(), now()
WHERE NOT EXISTS (SELECT 1 FROM icai_link_cards WHERE category = 'other' AND title = 'Web-Media Policy');
