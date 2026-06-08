-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0011 — Generic checklist engine
--
-- Adds a reusable template/instance model alongside the existing
-- event_checklists pipeline (which stays unchanged).
--
--   • checklist_templates / checklist_template_questions
--       Reusable, versioned form definitions. Editing a published template
--       forks a new version with the same family_id; in-flight instances stay
--       pinned to the version they started on.
--
--   • checklist_instances / checklist_instance_responses
--                           / checklist_instance_reviews
--       Filled copies, optionally bound to an event. JSONB value column so
--       a single shape stores text / numbers / dates / arrays.
--
-- Triggers:
--   • touch updated_at on templates + instances + responses
--   • lock a published template's questions against in-place edits
--   • enforce that a response's question belongs to its instance's template
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. Enums ──────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE "checklist_question_type" AS ENUM (
    'short_text', 'long_text', 'number', 'money', 'date', 'datetime',
    'radio', 'dropdown', 'yes_no', 'checkbox', 'rating', 'file', 'section_heading'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "checklist_instance_status" AS ENUM (
    'awaiting_fill', 'awaiting_review', 'approved', 'rejected'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "checklist_instance_action" AS ENUM (
    'created', 'assigned', 'submitted', 'approved', 'rejected', 'reopened'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 2. Tables ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "checklist_templates" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "family_id"    uuid NOT NULL,
  "version"      integer NOT NULL DEFAULT 1,
  "name"         text NOT NULL,
  "description"  text,
  "category"     text,
  "is_published" boolean NOT NULL DEFAULT false,
  "fill_role"    text,
  "review_role"  text,
  "created_by"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "updated_at"   timestamptz NOT NULL DEFAULT now(),
  "published_at" timestamptz,
  "deleted_at"   timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS "ux_checklist_templates_family_version"
  ON "checklist_templates"("family_id", "version");
CREATE INDEX IF NOT EXISTS "idx_checklist_templates_published"
  ON "checklist_templates"("is_published");

CREATE TABLE IF NOT EXISTS "checklist_template_questions" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "template_id" uuid NOT NULL REFERENCES "checklist_templates"("id") ON DELETE CASCADE,
  "sort_order"  integer NOT NULL DEFAULT 0,
  "type"        checklist_question_type NOT NULL,
  "label"       text NOT NULL,
  "help_text"   text,
  "required"    boolean NOT NULL DEFAULT true,
  "config"      jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_checklist_template_questions_template_sort"
  ON "checklist_template_questions"("template_id", "sort_order");

CREATE TABLE IF NOT EXISTS "checklist_instances" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "template_id"              uuid NOT NULL REFERENCES "checklist_templates"("id") ON DELETE RESTRICT,
  "title"                    text NOT NULL,
  "event_id"                 uuid REFERENCES "events"("id") ON DELETE SET NULL,
  "status"                   checklist_instance_status NOT NULL DEFAULT 'awaiting_fill',
  "assigned_fill_user_id"    uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "assigned_review_user_id"  uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "notes"                    text,
  "created_by"               uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  "updated_at"               timestamptz NOT NULL DEFAULT now(),
  "submitted_at"             timestamptz,
  "reviewed_at"              timestamptz,
  "deleted_at"               timestamptz
);

CREATE INDEX IF NOT EXISTS "idx_checklist_instances_template"
  ON "checklist_instances"("template_id");
CREATE INDEX IF NOT EXISTS "idx_checklist_instances_event"
  ON "checklist_instances"("event_id");
CREATE INDEX IF NOT EXISTS "idx_checklist_instances_status"
  ON "checklist_instances"("status");
CREATE INDEX IF NOT EXISTS "idx_checklist_instances_fill_user"
  ON "checklist_instances"("assigned_fill_user_id");

CREATE TABLE IF NOT EXISTS "checklist_instance_responses" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "instance_id" uuid NOT NULL REFERENCES "checklist_instances"("id") ON DELETE CASCADE,
  "question_id" uuid NOT NULL REFERENCES "checklist_template_questions"("id") ON DELETE CASCADE,
  "value"       jsonb,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "ux_checklist_responses_instance_question"
  ON "checklist_instance_responses"("instance_id", "question_id");

CREATE TABLE IF NOT EXISTS "checklist_instance_reviews" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "instance_id" uuid NOT NULL REFERENCES "checklist_instances"("id") ON DELETE CASCADE,
  "actor_id"    uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "action"      checklist_instance_action NOT NULL,
  "note"        text,
  "created_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_checklist_instance_reviews_instance_created"
  ON "checklist_instance_reviews"("instance_id", "created_at");

-- ─── 3. Triggers ───────────────────────────────────────────────────────────

-- 3a. Touch updated_at
CREATE OR REPLACE FUNCTION "touch_checklist_updated_at"() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_touch_checklist_templates_updated_at" ON "checklist_templates";
CREATE TRIGGER "trg_touch_checklist_templates_updated_at"
  BEFORE UPDATE ON "checklist_templates"
  FOR EACH ROW EXECUTE FUNCTION "touch_checklist_updated_at"();

DROP TRIGGER IF EXISTS "trg_touch_checklist_instances_updated_at" ON "checklist_instances";
CREATE TRIGGER "trg_touch_checklist_instances_updated_at"
  BEFORE UPDATE ON "checklist_instances"
  FOR EACH ROW EXECUTE FUNCTION "touch_checklist_updated_at"();

DROP TRIGGER IF EXISTS "trg_touch_checklist_responses_updated_at" ON "checklist_instance_responses";
CREATE TRIGGER "trg_touch_checklist_responses_updated_at"
  BEFORE UPDATE ON "checklist_instance_responses"
  FOR EACH ROW EXECUTE FUNCTION "touch_checklist_updated_at"();

-- 3b. Lock published-template questions against structural edits.
-- Once is_published flips true, the question set is frozen for that version.
-- Editing the form requires creating a new version via the API (clone path).
CREATE OR REPLACE FUNCTION "lock_published_template_questions"() RETURNS trigger AS $$
DECLARE
  v_published boolean;
  v_template_id uuid;
BEGIN
  v_template_id := COALESCE(NEW.template_id, OLD.template_id);
  SELECT is_published INTO v_published FROM checklist_templates WHERE id = v_template_id;
  IF v_published THEN
    RAISE EXCEPTION 'Cannot modify questions on a published template (template_id=%). Create a new version.', v_template_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_lock_published_template_questions" ON "checklist_template_questions";
CREATE TRIGGER "trg_lock_published_template_questions"
  BEFORE INSERT OR UPDATE OR DELETE ON "checklist_template_questions"
  FOR EACH ROW EXECUTE FUNCTION "lock_published_template_questions"();

-- 3c. Enforce that a response's question belongs to its instance's template.
-- Without this, the API could (by accident) post a response keyed to a
-- question from a different template/version.
CREATE OR REPLACE FUNCTION "check_response_question_matches_instance"() RETURNS trigger AS $$
DECLARE
  v_instance_template uuid;
  v_question_template uuid;
BEGIN
  SELECT template_id INTO v_instance_template FROM checklist_instances WHERE id = NEW.instance_id;
  SELECT template_id INTO v_question_template FROM checklist_template_questions WHERE id = NEW.question_id;
  IF v_instance_template IS DISTINCT FROM v_question_template THEN
    RAISE EXCEPTION 'Response question (template=%) does not belong to instance template (%)', v_question_template, v_instance_template
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_check_response_question_matches_instance" ON "checklist_instance_responses";
CREATE TRIGGER "trg_check_response_question_matches_instance"
  BEFORE INSERT OR UPDATE ON "checklist_instance_responses"
  FOR EACH ROW EXECUTE FUNCTION "check_response_question_matches_instance"();
