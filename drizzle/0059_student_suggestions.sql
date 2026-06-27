-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0059 — Student suggestions (with upvote-only voting)
--
-- The home page WICASA card needs a real "students propose ideas, others
-- upvote" feature instead of the hardcoded list. Three tables:
--
--   student_suggestion_topics  — admin-managed buckets ("Curriculum",
--                                 "Events", "Facilities", "Mentorship",
--                                 "Other"). Topics are branch-scoped so
--                                 each branch can curate its own.
--
--   student_suggestions        — one row per student-submitted idea.
--                                 Status workflow: pending → approved |
--                                 rejected. Body capped at 280 chars
--                                 (Twitter-length on purpose: encourages
--                                 sharp, scannable suggestions).
--
--   student_suggestion_votes   — (suggestion_id, user_id) composite PK
--                                 means a user can vote at most once per
--                                 suggestion. Net vote count = row count.
--                                 Tapping again deletes the row (toggle).
--
-- Seed: the 5 default topics under the Nagpur branch (id matched via
-- code = 'NGP'). If the branch row doesn't exist yet (fresh install),
-- the seed is skipped silently — admin can add topics later via the
-- admin UI.
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- ── Topics ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "student_suggestion_topics" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "branch_id"    uuid REFERENCES "branches"("id") ON DELETE CASCADE,
  "code"         text NOT NULL,
  "name"         text NOT NULL,
  "description"  text,
  "active"       boolean NOT NULL DEFAULT true,
  "sort_order"   integer NOT NULL DEFAULT 0,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT student_suggestion_topics_branch_code_unique UNIQUE (branch_id, code)
);
CREATE INDEX IF NOT EXISTS student_suggestion_topics_branch_idx
  ON student_suggestion_topics (branch_id);

-- ── Suggestions ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "student_suggestions" (
  "id"             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "topic_id"       uuid REFERENCES "student_suggestion_topics"("id") ON DELETE SET NULL,
  "user_id"        uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "body"           text NOT NULL,
  "status"         text NOT NULL DEFAULT 'pending',
  "reject_reason"  text,
  "reviewed_by"    uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "reviewed_at"    timestamptz,
  "created_at"     timestamptz NOT NULL DEFAULT now(),
  "updated_at"     timestamptz NOT NULL DEFAULT now(),
  "deleted_at"     timestamptz,
  CONSTRAINT student_suggestions_body_length_ck
    CHECK (char_length(body) > 0 AND char_length(body) <= 280),
  CONSTRAINT student_suggestions_status_ck
    CHECK (status IN ('pending', 'approved', 'rejected', 'archived'))
);
CREATE INDEX IF NOT EXISTS student_suggestions_status_idx ON student_suggestions (status);
CREATE INDEX IF NOT EXISTS student_suggestions_topic_idx  ON student_suggestions (topic_id);
CREATE INDEX IF NOT EXISTS student_suggestions_user_idx   ON student_suggestions (user_id);
CREATE INDEX IF NOT EXISTS student_suggestions_created_idx
  ON student_suggestions (created_at DESC);

-- ── Votes ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "student_suggestion_votes" (
  "suggestion_id" uuid NOT NULL REFERENCES "student_suggestions"("id") ON DELETE CASCADE,
  "user_id"       uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (suggestion_id, user_id)
);
CREATE INDEX IF NOT EXISTS student_suggestion_votes_user_idx
  ON student_suggestion_votes (user_id);

-- ── Seed default topics for the Nagpur branch ──────────────────────────────
-- The DO block lets us guard on the branch row's existence; on a fresh
-- DB without the NGP branch yet, the seed silently no-ops.
DO $$
DECLARE
  v_branch_id uuid;
BEGIN
  SELECT id INTO v_branch_id FROM branches WHERE code = 'NGP' LIMIT 1;
  IF v_branch_id IS NULL THEN
    RAISE NOTICE 'Branch NGP not found — skipping topic seed';
    RETURN;
  END IF;

  INSERT INTO student_suggestion_topics (branch_id, code, name, description, sort_order)
  VALUES
    (v_branch_id, 'curriculum',  'Curriculum',                      'Coaching, revision classes, exam strategy', 10),
    (v_branch_id, 'events',      'Events & Workshops',              'CPE programmes, seminars, networking events', 20),
    (v_branch_id, 'facilities',  'Facilities',                      'Library, reading room, premises', 30),
    (v_branch_id, 'mentorship',  'Mentorship',                      'Career counselling, articleship guidance', 40),
    (v_branch_id, 'other',       'Other',                           'Anything else', 90)
  ON CONFLICT (branch_id, code) DO NOTHING;
END $$;
