-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0035 — Per-section filler assignments on checklist instances
--
-- Today's model: each checklist_instances row has ONE assigned_fill_user_id
-- and the committee chairman fills the entire checklist. This works for small
-- events but breaks down when (a) the chairman wants to delegate the budget
-- section to the treasurer, (b) the convener handles speakers while the
-- chairman handles event basics, or (c) a committee member fills a small
-- piece without needing chairman access to everything.
--
-- New model: an OPTIONAL per-section_heading assignment overlay. When the
-- admin attaches a checklist to an event they can assign a specific user to
-- each section. That user gains fill rights for questions inside that
-- section. The chairman (assigned_fill_user_id) remains the fallback filler
-- and can still edit every section — section assignments are additive, not
-- restrictive.
--
-- section_question_id points at the template_questions row WHERE type =
-- 'section_heading'. We don't store the role here — that lives on the
-- template and drives review routing; section_assignments are about FILL,
-- not REVIEW.
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "checklist_instance_section_assignments" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "instance_id"          uuid NOT NULL REFERENCES "checklist_instances"("id") ON DELETE CASCADE,
  "section_question_id"  uuid NOT NULL REFERENCES "checklist_template_questions"("id") ON DELETE CASCADE,
  "assignee_id"          uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "ux_checklist_section_assignments_instance_section"
    UNIQUE ("instance_id", "section_question_id")
);

-- One index per FK we filter on. The assignee lookup is what powers the
-- "show me checklists where I have anything to fill" listing.
CREATE INDEX IF NOT EXISTS "idx_checklist_section_assignments_instance"
  ON "checklist_instance_section_assignments" ("instance_id");
CREATE INDEX IF NOT EXISTS "idx_checklist_section_assignments_assignee"
  ON "checklist_instance_section_assignments" ("assignee_id")
  WHERE assignee_id IS NOT NULL;
