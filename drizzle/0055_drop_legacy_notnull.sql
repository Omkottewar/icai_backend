-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0055 — Drop NOT NULL on legacy template-question columns
--
-- After F19 (migration 0053) the canonical reference is the new
-- *_question_id column that points at checklist_instance_questions. The
-- corresponding legacy columns (pointing at checklist_template_questions)
-- are still in the schema for backward compatibility, BUT they were
-- created NOT NULL in migrations 0006 / 0035 — which means new INSERTs
-- from F19-era code paths now fail with 23502 because they only populate
-- the new column.
--
-- Two callers regularly hit this:
--   • POST /api/checklist-instances             — creating section_assignments
--     during initial event-checklist creation
--   • PUT  /api/checklist-instances/:id/section-assignments
--                                                — admin reassignment
--
-- This migration relaxes both legacy NOT NULL constraints. The data they
-- still hold (backfilled by 0053) remains intact; new rows can leave them
-- NULL and use the new instance_*_question_id column instead.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE checklist_instance_section_assignments
  ALTER COLUMN section_question_id DROP NOT NULL;

ALTER TABLE checklist_instance_responses
  ALTER COLUMN question_id DROP NOT NULL;
