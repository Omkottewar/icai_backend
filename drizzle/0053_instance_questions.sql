-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0053 — Per-instance checklist questions
--
-- Before this migration, every checklist instance shared its question list
-- with its parent template (via the template_id FK). That meant editing the
-- questions on a specific event required editing the template — which then
-- affected every other event using the same template. Branch staff legitimately
-- need to add event-specific items (e.g. "Speaker travel booking confirmed?")
-- without polluting the master template.
--
-- New shape:
--   • Every instance gets its OWN copy of its questions in
--     `checklist_instance_questions`. Templates remain the starting point
--     (the clone happens at instance-creation time, per F19 backend changes).
--   • `checklist_instance_responses.instance_question_id` and
--     `checklist_instance_section_assignments.instance_section_question_id`
--     point at the instance's private question rows.
--   • The legacy template-question FKs stay in the schema for backward
--     compatibility during a transition period; new code paths write only
--     the new columns. A later migration can drop the legacy columns once
--     every code path is on the new shape.
--
-- Backfill plan (run in a single transaction):
--   1. Create the new table.
--   2. For every existing instance, clone its template's questions into
--      `checklist_instance_questions`. Each clone gets a fresh UUID;
--      `source_template_question_id` preserves the lineage so the response /
--      section-assignment backfill below can map old rows correctly.
--   3. Add the two new FK columns on responses + section_assignments.
--   4. Backfill them by joining (instance_id, question_id from legacy) →
--      the new instance_question.id via `source_template_question_id`.
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- 1) New table — same shape as checklist_template_questions but scoped to an instance.
CREATE TABLE IF NOT EXISTS checklist_instance_questions (
  id                            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id                   uuid NOT NULL REFERENCES checklist_instances(id) ON DELETE CASCADE,
  sort_order                    integer NOT NULL DEFAULT 0,
  type                          checklist_question_type NOT NULL,
  label                         text NOT NULL,
  help_text                     text,
  required                      boolean NOT NULL DEFAULT true,
  config                        jsonb NOT NULL DEFAULT '{}'::jsonb,
  section_owner_role            text,
  -- Lineage marker — when the row was cloned from a template question, this
  -- holds the source id. Lets the backfill remap existing responses, and
  -- lets the UI flag which items are "from the template" vs "added for
  -- this event only". NULL = added directly on the instance (no template
  -- source).
  source_template_question_id   uuid REFERENCES checklist_template_questions(id) ON DELETE SET NULL,
  created_at                    timestamptz NOT NULL DEFAULT NOW(),
  updated_at                    timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_checklist_instance_questions_instance_sort
  ON checklist_instance_questions (instance_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_checklist_instance_questions_source
  ON checklist_instance_questions (source_template_question_id)
  WHERE source_template_question_id IS NOT NULL;

-- 2) Backfill — clone each existing instance's template questions into
-- the new table. Existing instances continue to behave identically because
-- the cloned questions carry the same labels / types / config / sort_order.
INSERT INTO checklist_instance_questions (
  instance_id, sort_order, type, label, help_text, required, config,
  section_owner_role, source_template_question_id, created_at, updated_at
)
SELECT
  i.id                                AS instance_id,
  tq.sort_order,
  tq.type,
  tq.label,
  tq.help_text,
  tq.required,
  tq.config,
  tq.section_owner_role,
  tq.id                               AS source_template_question_id,
  NOW(), NOW()
FROM checklist_instances i
JOIN checklist_template_questions tq
  ON tq.template_id = i.template_id
WHERE i.deleted_at IS NULL;

-- 3) New FK columns on responses + section_assignments.
ALTER TABLE checklist_instance_responses
  ADD COLUMN IF NOT EXISTS instance_question_id uuid
    REFERENCES checklist_instance_questions(id) ON DELETE CASCADE;

ALTER TABLE checklist_instance_section_assignments
  ADD COLUMN IF NOT EXISTS instance_section_question_id uuid
    REFERENCES checklist_instance_questions(id) ON DELETE CASCADE;

-- 4) Backfill the new columns from the legacy question_id columns by walking
-- the (instance_id, source_template_question_id) lineage.
UPDATE checklist_instance_responses r
SET instance_question_id = iq.id
FROM checklist_instance_questions iq
WHERE iq.instance_id = r.instance_id
  AND iq.source_template_question_id = r.question_id
  AND r.instance_question_id IS NULL;

UPDATE checklist_instance_section_assignments sa
SET instance_section_question_id = iq.id
FROM checklist_instance_questions iq
WHERE iq.instance_id = sa.instance_id
  AND iq.source_template_question_id = sa.section_question_id
  AND sa.instance_section_question_id IS NULL;

-- 5) Unique index — (instance, instance_question) pair must be unique on
-- responses (mirrors the original (instance, question_id) uniqueness).
CREATE UNIQUE INDEX IF NOT EXISTS ux_checklist_responses_instance_iquestion
  ON checklist_instance_responses (instance_id, instance_question_id)
  WHERE instance_question_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS ux_checklist_section_assignments_instance_isection
  ON checklist_instance_section_assignments (instance_id, instance_section_question_id)
  WHERE instance_section_question_id IS NOT NULL;

COMMIT;
