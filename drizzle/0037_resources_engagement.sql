-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0037 — Resources & Publications (Section L)
--
-- Extends the existing branch-content tables (paper_presentations,
-- branch_newsletters) with submission workflow + engagement features, and
-- introduces new tables for:
--   • Closed topic taxonomy (resource_topics)
--   • E-journal archive (ejournal_issues)
--   • Curated link-out cards for icai.org content (icai_link_cards)
--   • Per-user bookmarks (resource_bookmarks)
--   • Topic following with notification dispatch (resource_topic_subscriptions)
--   • Comments / Q&A (resource_comments, post-moderation model)
--   • CPE-eligible quizzes (resource_quizzes + questions + options + attempts)
--
-- One migration covers Phase 1-3 of the Resources build so we don't have
-- the schema drift across N versions. Routes wire in over the next few days.
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Closed topic taxonomy ────────────────────────────────────────────
-- Admin-curated subject-matter tags (GST, Direct Tax, Audit, etc.).
-- Members subscribe to topics → get push when new resources in that topic
-- are published. Distinct from `committee_tag` on paper_presentations,
-- which records who organised the event (CPE committee, GST study group)
-- not what the paper is about.

CREATE TABLE IF NOT EXISTS "resource_topics" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"        text NOT NULL UNIQUE,                -- 'gst', 'direct_tax'
  "name"        text NOT NULL,                       -- 'Goods & Services Tax'
  "description" text,
  "sort_order"  integer NOT NULL DEFAULT 0,
  "active"      boolean NOT NULL DEFAULT true,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

-- Seed the initial 13 topics. ON CONFLICT keeps re-runs safe.
INSERT INTO "resource_topics" (code, name, description, sort_order) VALUES
  ('gst',           'Goods & Services Tax',                    'GST law, returns, notifications, case law',           10),
  ('direct_tax',    'Direct Taxation',                          'Income tax, TDS, transfer pricing, search & seizure', 20),
  ('audit',         'Audit & Assurance',                        'Statutory, tax, internal audit; ICAI auditing standards', 30),
  ('companies_act', 'Companies Act / Corporate Law',            'Companies Act 2013, SEBI, secretarial compliance',    40),
  ('insolvency',    'Insolvency & Bankruptcy',                  'IBC code, NCLT/NCLAT cases, resolution professionals', 50),
  ('rera',          'RERA',                                     'Real Estate (Regulation) Act, developer compliance',  60),
  ('fema',          'FEMA / International Tax',                 'Foreign exchange, transfer pricing, DTAA',            70),
  ('bfsi',          'Banking, Financial Services, Insurance',   'Bank audit, IRDA, NBFC compliance',                   80),
  ('ifrs',          'IFRS & Indian Accounting Standards',       'Ind AS, IFRS, schedule III compliance',               90),
  ('ethics',        'Professional Ethics & Conduct',            'ICAI code of ethics, CA Act, peer review',           100),
  ('it_practice',   'IT for CAs',                               'Excel, AI/ML for practice, automation, cybersecurity', 110),
  ('forensic',      'Forensic Accounting & Fraud',              'Fraud detection, anti-money-laundering, due diligence', 120),
  ('general',       'General / Practice Management',            'Firm management, billing, client onboarding, soft skills', 130)
ON CONFLICT (code) DO NOTHING;

-- ─── 2. Extend paper_presentations with submission workflow + slug + abstract ─
-- Members can submit their own papers (status starts at 'pending_review'),
-- admins moderate. Existing rows default to 'published' so the migration
-- doesn't hide previously-uploaded content.

DO $$ BEGIN
  CREATE TYPE "resource_status" AS ENUM ('draft', 'pending_review', 'published', 'rejected', 'archived');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE "paper_presentations"
  ADD COLUMN IF NOT EXISTS "slug"             text,
  ADD COLUMN IF NOT EXISTS "abstract"         text,
  ADD COLUMN IF NOT EXISTS "author_user_id"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "author_designation" text,
  ADD COLUMN IF NOT EXISTS "cover_file_id"    uuid REFERENCES "files"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "committee_id"     uuid REFERENCES "committees"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "status"           "resource_status" NOT NULL DEFAULT 'published',
  ADD COLUMN IF NOT EXISTS "submitted_by"     uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "reviewed_by"      uuid REFERENCES "users"("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "reviewed_at"      timestamptz,
  ADD COLUMN IF NOT EXISTS "review_note"      text,
  ADD COLUMN IF NOT EXISTS "published_at"     timestamptz,
  ADD COLUMN IF NOT EXISTS "view_count"       integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "disclaimer_text"  text NOT NULL DEFAULT 'Views expressed are personal';

-- Backfill `published_at` for rows that were already in the table (their
-- status defaulted to 'published' above). Use updated_at as a reasonable
-- proxy for when they went live.
UPDATE "paper_presentations"
  SET "published_at" = COALESCE(updated_at, created_at)
  WHERE "published_at" IS NULL AND "status" = 'published';

-- Slugs are required for URL routing. Backfill from title for any existing
-- rows. Uniqueness enforced once backfill is done.
UPDATE "paper_presentations" SET slug = LOWER(
  REGEXP_REPLACE(
    REGEXP_REPLACE(title, '[^a-zA-Z0-9\s-]', '', 'g'),
    '\s+', '-', 'g'
  )
) WHERE slug IS NULL;
-- Make slug NOT NULL + UNIQUE once it's backfilled.
DO $$ BEGIN
  ALTER TABLE "paper_presentations" ALTER COLUMN "slug" SET NOT NULL;
EXCEPTION WHEN others THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "paper_presentations_slug_uq" ON "paper_presentations" ("slug");
CREATE INDEX        IF NOT EXISTS "paper_presentations_status_idx" ON "paper_presentations" ("status");
CREATE INDEX        IF NOT EXISTS "paper_presentations_author_idx" ON "paper_presentations" ("author_user_id");

-- ─── 3. Paper ↔ topic many-to-many ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "paper_topics" (
  "paper_id" uuid NOT NULL REFERENCES "paper_presentations"("id") ON DELETE CASCADE,
  "topic_id" uuid NOT NULL REFERENCES "resource_topics"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("paper_id", "topic_id")
);
CREATE INDEX IF NOT EXISTS "paper_topics_topic_idx" ON "paper_topics" ("topic_id");

-- ─── 4. E-journal issues ──────────────────────────────────────────────────
-- L.5 — branch's own e-journal. Distinct from branch_newsletters (L.2)
-- which is the monthly branch newsletter; e-journal is a quarterly /
-- semi-annual publication aggregating long-form articles.

CREATE TABLE IF NOT EXISTS "ejournal_issues" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "slug"             text NOT NULL UNIQUE,
  "title"            text NOT NULL,
  "issue_label"      text NOT NULL,                        -- 'Vol III, Issue 2 — Apr-Jun 2026'
  "issue_year"       integer NOT NULL,
  "issue_quarter"    integer,                              -- 1-4, nullable for annual
  "cover_file_id"    uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "pdf_file_id"      uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "editorial_summary" text,
  "status"           "resource_status" NOT NULL DEFAULT 'published',
  "published_at"     timestamptz,
  "created_by"       uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "view_count"       integer NOT NULL DEFAULT 0,
  "hidden"           boolean NOT NULL DEFAULT false,
  "created_at"       timestamptz NOT NULL DEFAULT now(),
  "updated_at"       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "ejournal_issues_year_idx"   ON "ejournal_issues" ("issue_year", "issue_quarter");
CREATE INDEX IF NOT EXISTS "ejournal_issues_status_idx" ON "ejournal_issues" ("status");

CREATE TABLE IF NOT EXISTS "ejournal_topics" (
  "issue_id" uuid NOT NULL REFERENCES "ejournal_issues"("id") ON DELETE CASCADE,
  "topic_id" uuid NOT NULL REFERENCES "resource_topics"("id") ON DELETE CASCADE,
  PRIMARY KEY ("issue_id", "topic_id")
);

-- ─── 5. Curated link-out cards for icai.org content ──────────────────────
-- L.1 Circulars, L.3 Standards, L.6 Knowledge Repo all live on icai.org.
-- Instead of dumping a raw link list, admin curates these as pretty cards
-- with a description so the portal feels like a guide to the master corpus.

CREATE TABLE IF NOT EXISTS "icai_link_cards" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "category"    text NOT NULL,                             -- 'circulars' | 'standards' | 'knowledge_repo' | 'other'
  "title"       text NOT NULL,
  "description" text,
  "url"         text NOT NULL,
  "icon_emoji"  text,                                      -- '📜' / '📊' / '📚'
  "sort_order"  integer NOT NULL DEFAULT 0,
  "active"      boolean NOT NULL DEFAULT true,
  "created_by"  uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "icai_link_cards_category_idx" ON "icai_link_cards" ("category", "sort_order") WHERE "active" = true;

-- Seed with the most-needed link-outs. Admin can edit later.
INSERT INTO "icai_link_cards" (category, title, description, url, icon_emoji, sort_order) VALUES
  ('circulars',     'ICAI Notifications & Announcements', 'Official notifications, circulars, and press releases from ICAI HQ.', 'https://www.icai.org/category/notifications-announcements', '📜', 10),
  ('circulars',     'WIRC Communiqué',                    'Western India Regional Council updates and circulars.',                'https://www.wirc-icai.org/communique',                      '📰', 20),
  ('standards',     'Accounting Standards (AS / Ind AS)',  'ICAI master list of Accounting Standards and Indian Accounting Standards.', 'https://www.icai.org/post/list-of-accounting-standards',  '📊', 10),
  ('standards',     'Standards on Auditing (SA)',          'ICAI master list of Standards on Auditing.',                          'https://www.icai.org/category/standards-on-auditing',        '🔍', 20),
  ('standards',     'Code of Ethics',                      'ICAI Code of Ethics for CAs in practice and employment.',             'https://www.icai.org/post/code-of-ethics',                   '⚖️',  30),
  ('knowledge_repo','ICAI Knowledge Bank',                 'Technical guides, FAQs, and educational resources from ICAI.',         'https://www.icai.org/category/knowledge-bank',               '📚', 10),
  ('knowledge_repo','ICAI e-Library',                      'Searchable archive of ICAI publications and journals.',                'https://resource.cdn.icai.org/elibrary/index.htm',           '📖', 20)
ON CONFLICT DO NOTHING;

-- ─── 6. Bookmarks (Phase 2) ───────────────────────────────────────────────
-- A single table covers both papers and e-journal issues. resource_type is
-- a tagged-union discriminator; resource_id references whichever table the
-- type points at. We don't FK from here (postgres can't FK to one of two
-- tables); cleanup happens via the optional cleanup cron / application code.

CREATE TABLE IF NOT EXISTS "resource_bookmarks" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"       uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "resource_type" text NOT NULL,                           -- 'paper' | 'ejournal'
  "resource_id"   uuid NOT NULL,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "resource_bookmarks_user_resource_uq" UNIQUE ("user_id", "resource_type", "resource_id"),
  CONSTRAINT "resource_bookmarks_type_chk"         CHECK ("resource_type" IN ('paper', 'ejournal'))
);
CREATE INDEX IF NOT EXISTS "resource_bookmarks_user_idx" ON "resource_bookmarks" ("user_id", "created_at" DESC);

-- ─── 7. Topic subscriptions (Phase 2) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS "resource_topic_subscriptions" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"     uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "topic_id"    uuid NOT NULL REFERENCES "resource_topics"("id") ON DELETE CASCADE,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "resource_topic_subs_user_topic_uq" UNIQUE ("user_id", "topic_id")
);
CREATE INDEX IF NOT EXISTS "resource_topic_subs_topic_idx" ON "resource_topic_subscriptions" ("topic_id");

-- ─── 8. Comments / Q&A (Phase 3) ──────────────────────────────────────────
-- Post-moderation: comments appear instantly, admin can hide/delete later.
-- parent_comment_id supports one level of replies (author → asker thread).
-- We don't enforce a depth limit at the DB layer; the UI flattens anything
-- past depth 1.

CREATE TABLE IF NOT EXISTS "resource_comments" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "resource_type"     text NOT NULL,                       -- 'paper' | 'ejournal'
  "resource_id"       uuid NOT NULL,
  "user_id"           uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "body"              text NOT NULL,
  "parent_comment_id" uuid REFERENCES "resource_comments"("id") ON DELETE CASCADE,
  "status"            text NOT NULL DEFAULT 'visible',     -- 'visible' | 'hidden' | 'deleted'
  "hidden_by"         uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "hidden_at"         timestamptz,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "resource_comments_type_chk"   CHECK ("resource_type" IN ('paper', 'ejournal')),
  CONSTRAINT "resource_comments_status_chk" CHECK ("status" IN ('visible', 'hidden', 'deleted'))
);
CREATE INDEX IF NOT EXISTS "resource_comments_resource_idx" ON "resource_comments" ("resource_type", "resource_id", "created_at");
CREATE INDEX IF NOT EXISTS "resource_comments_user_idx"     ON "resource_comments" ("user_id");

-- ─── 9. CPE quizzes (Phase 3) ─────────────────────────────────────────────
-- One quiz per paper. ICAI-compliance posture: 5 questions, pass at 4/5,
-- 24h retake cooldown, 30 min unstructured CPE credit per pass.

CREATE TABLE IF NOT EXISTS "resource_quizzes" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "paper_id"            uuid NOT NULL UNIQUE REFERENCES "paper_presentations"("id") ON DELETE CASCADE,
  "pass_threshold"      integer NOT NULL DEFAULT 4,
  "question_count"      integer NOT NULL DEFAULT 5,
  "cpe_credit_minutes"  integer NOT NULL DEFAULT 30,
  "cooldown_hours"      integer NOT NULL DEFAULT 24,
  "is_published"        boolean NOT NULL DEFAULT false,
  "created_by"          uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "resource_quiz_questions" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "quiz_id"     uuid NOT NULL REFERENCES "resource_quizzes"("id") ON DELETE CASCADE,
  "sort_order"  integer NOT NULL DEFAULT 0,
  "text"        text NOT NULL,
  "explanation" text,                                      -- shown after answering
  "created_at"  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "resource_quiz_questions_quiz_idx" ON "resource_quiz_questions" ("quiz_id", "sort_order");

CREATE TABLE IF NOT EXISTS "resource_quiz_options" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "question_id" uuid NOT NULL REFERENCES "resource_quiz_questions"("id") ON DELETE CASCADE,
  "sort_order"  integer NOT NULL DEFAULT 0,
  "text"        text NOT NULL,
  "is_correct"  boolean NOT NULL DEFAULT false,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "resource_quiz_options_q_idx" ON "resource_quiz_options" ("question_id", "sort_order");

-- One row per attempt. Even failed attempts are recorded for audit and
-- for enforcing the cooldown. CPE credit is awarded only when passed=true.

CREATE TABLE IF NOT EXISTS "resource_quiz_attempts" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "quiz_id"       uuid NOT NULL REFERENCES "resource_quizzes"("id") ON DELETE CASCADE,
  "user_id"       uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "score"         integer NOT NULL,
  "passed"        boolean NOT NULL,
  "answers"       jsonb NOT NULL DEFAULT '{}'::jsonb,      -- { [question_id]: option_id }
  "started_at"    timestamptz NOT NULL DEFAULT now(),
  "completed_at"  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "resource_quiz_attempts_user_idx"      ON "resource_quiz_attempts" ("user_id", "completed_at" DESC);
CREATE INDEX IF NOT EXISTS "resource_quiz_attempts_quiz_user_idx" ON "resource_quiz_attempts" ("quiz_id", "user_id", "completed_at" DESC);

-- ─── 10. Notification templates for resources ────────────────────────────
-- Three lifecycle keys: new resource in subscribed topic, paper submission
-- approved, paper submission rejected. Dispatch wiring lives in the routes.

INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('resource_new_in_topic',
   'New resource in topic you follow',
   'Fires when a resource (paper or e-journal) is published in a topic the user subscribed to.',
   ARRAY['inapp','email','webpush']::text[],
   'New in {{topic_name}}: {{resource_title}}',
   E'Hi {{first_name}},\n\nA new {{resource_type_label}} is available in {{topic_name}}:\n\n  "{{resource_title}}"\n  by {{author_name}}\n\nOpen it: {{resource_link}}\n\nYou''re receiving this because you follow {{topic_name}}. Unfollow any time from your dashboard.\n\n— ICAI Nagpur Branch (WIRC)',
   '{{resource_title}}',
   '{{topic_name}} · by {{author_name}}'),
  ('paper_submission_approved',
   'Paper submission approved',
   'Sent to the submitter when admin publishes their paper submission.',
   ARRAY['inapp','email','webpush']::text[],
   'Your paper is now live: {{paper_title}}',
   E'Hi {{first_name}},\n\nGreat news — your paper "{{paper_title}}" is now published on the Nagpur Branch portal.\n\nView it: {{paper_link}}\n\nThanks for contributing.\n\n— ICAI Nagpur Branch (WIRC)',
   'Paper approved: {{paper_title}}',
   'Your submission is now live on the portal.'),
  ('paper_submission_rejected',
   'Paper submission needs changes',
   'Sent to the submitter when admin rejects their paper submission (with a reason).',
   ARRAY['inapp','email']::text[],
   'Paper needs changes: {{paper_title}}',
   E'Hi {{first_name}},\n\nYour paper "{{paper_title}}" needs some changes before we can publish it:\n\n  {{review_note}}\n\nYou can update and resubmit from your dashboard.\n\n— ICAI Nagpur Branch (WIRC)',
   'Paper needs changes',
   '{{review_note}}'),
  ('paper_new_comment',
   'New comment on your paper',
   'Sent to the paper author/uploader when a member posts a question or comment on it.',
   ARRAY['inapp','email','webpush']::text[],
   'New comment on "{{paper_title}}"',
   E'Hi {{first_name}},\n\n{{commenter_name}} commented on your paper "{{paper_title}}":\n\n  "{{comment_preview}}"\n\nReply: {{paper_link}}\n\n— ICAI Nagpur Branch (WIRC)',
   'New comment on {{paper_title}}',
   '{{commenter_name}}: {{comment_preview}}')
ON CONFLICT (key) DO NOTHING;
