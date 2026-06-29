-- ─── 0064 — Update check_response_question_matches_instance for F19 ──────
--
-- F19 introduced checklist_instance_questions: each instance now owns its
-- own copy of questions, and responses reference them via the new
-- `instance_question_id` column (not the legacy `question_id` that points
-- at checklist_template_questions).
--
-- The trigger from migration 0011 only knew about the legacy path. When a
-- response is inserted with instance_question_id set (and question_id NULL,
-- which is the new normal), the trigger SELECTs template_id from
-- checklist_template_questions WHERE id IS NULL → returns NULL → fails the
-- IS DISTINCT FROM check → raises:
--
--   Response question (template=<NULL>) does not belong to instance
--   template (<uuid>)
--
-- Fix: rewrite the trigger to handle BOTH paths. Prefers the new
-- instance_question_id when set; falls back to the legacy question_id.
--
-- For instance_question_id, the integrity check becomes "does this
-- instance_question belong to this instance?" (a 1:1 question — they share
-- a direct FK, no template indirection needed since instance_questions
-- are cloned per-instance).

CREATE OR REPLACE FUNCTION "check_response_question_matches_instance"() RETURNS trigger AS $$
DECLARE
  v_instance_template uuid;
  v_question_template uuid;
  v_question_instance uuid;
BEGIN
  -- Prefer the F19 path (instance_question_id) when set.
  IF NEW.instance_question_id IS NOT NULL THEN
    SELECT instance_id INTO v_question_instance
      FROM checklist_instance_questions WHERE id = NEW.instance_question_id;
    IF v_question_instance IS DISTINCT FROM NEW.instance_id THEN
      RAISE EXCEPTION 'Response instance_question (instance=%) does not match response instance (%)',
        v_question_instance, NEW.instance_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Legacy path (pre-F19 rows still get validated).
  IF NEW.question_id IS NOT NULL THEN
    SELECT template_id INTO v_instance_template FROM checklist_instances        WHERE id = NEW.instance_id;
    SELECT template_id INTO v_question_template FROM checklist_template_questions WHERE id = NEW.question_id;
    IF v_instance_template IS DISTINCT FROM v_question_template THEN
      RAISE EXCEPTION 'Response question (template=%) does not belong to instance template (%)',
        v_question_template, v_instance_template
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN NEW;
  END IF;

  -- Neither column set — let the column NOT NULL / FK constraints catch it.
  -- Returning NEW lets the row proceed to the standard constraint checks
  -- which will fail with a clearer message than this trigger could give.
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
