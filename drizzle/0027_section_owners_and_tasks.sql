-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0027 — Section-owned questions + Task list question type
--
-- Adds the building blocks for "long composite checklists" — one checklist
-- where the committee chairman fills the event-basics section, the treasurer
-- fills the budget section, the VC fills the agenda, and the chairman also
-- assigns tasks to other people (e.g. "Sanju, design the banner by 15 June").
--
-- Three changes packaged together:
--
--   1. checklist_template_questions.section_owner_role — only meaningful on
--      'section_heading' questions. Says "everything between this heading
--      and the next is owned by users holding this role". NULL = no
--      restriction (anyone with fill rights on the instance can edit).
--
--   2. checklist_question_type enum gains 'task_list' — a special question
--      whose stored value is a list of {description, assignee_id, due_date,
--      status} rows. Each row is mirrored in the new table below for query
--      and notification purposes.
--
--   3. checklist_task_assignments table — one row per task. We store the
--      tasks in this dedicated table (in addition to inside the response
--      JSON) so we can:
--        a. notify assignees efficiently
--        b. let assignees mark their task done without owning the parent
--           checklist
--        c. surface tasks in dashboards / filters down the line
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- 1. Section owner role on the template question rows.
ALTER TABLE "checklist_template_questions"
  ADD COLUMN IF NOT EXISTS "section_owner_role" text;

-- 2. Extend the question type enum. Wrapped in DO $$ for idempotency on PG.
DO $$ BEGIN
  ALTER TYPE "checklist_question_type" ADD VALUE IF NOT EXISTS 'task_list';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 3. Tasks table. Each row is one task within ONE response of a
--    task_list question. response_id is the linking key; on cascade delete
--    so a removed checklist instance also clears its tasks.
CREATE TABLE IF NOT EXISTS "checklist_task_assignments" (
  "id"            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "response_id"   uuid NOT NULL REFERENCES "checklist_instance_responses"("id") ON DELETE CASCADE,
  "description"   text NOT NULL,
  "assignee_id"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "due_date"      date,
  "status"        text NOT NULL DEFAULT 'pending',
  "done_at"       timestamptz,
  "done_by"       uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "notes"         text,
  "sort_order"    integer NOT NULL DEFAULT 0,
  "created_at"    timestamptz NOT NULL DEFAULT now(),
  "updated_at"    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checklist_task_assignments_status_chk
    CHECK (status IN ('pending', 'done', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS "checklist_task_assignments_response_idx"
  ON "checklist_task_assignments" ("response_id");
CREATE INDEX IF NOT EXISTS "checklist_task_assignments_assignee_idx"
  ON "checklist_task_assignments" ("assignee_id");
CREATE INDEX IF NOT EXISTS "checklist_task_assignments_status_idx"
  ON "checklist_task_assignments" ("status");

-- 4. New notification template for task assignments. The dispatch happens
--    in the responses save endpoint when a task is newly assigned.
INSERT INTO "notification_templates"
  (key, name, description, channels, email_subject, email_body, inapp_title, inapp_body)
VALUES
  ('task_assigned',
   'Task assigned',
   'Fires when someone is assigned a task on a checklist (e.g. banner design).',
   ARRAY['inapp','email']::text[],
   'You''ve been assigned a task — {{event_title}}',
   E'Hi {{first_name}},\n\n{{assigner_name}} has assigned you a task on the "{{event_title}}" checklist:\n\n  {{task_description}}\n\nDue: {{due_date}}\n\nOpen the checklist: {{checklist_link}}\n\nIf this isn''t for you, please reply to this email so the assigner can reassign.\n\n— ICAI Nagpur Branch (WIRC)',
   '{{task_description}}',
   '{{event_title}} · due {{due_date}}')
ON CONFLICT (key) DO NOTHING;
