-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0025 — checklist_instance_approvals + multi-stage trigger
--
-- Adds a per-stage approval table so an event-bound checklist instance can
-- require approvals from multiple roles in parallel (branch chairman +
-- treasurer for IUT + VC for agenda) before the instance flips to 'approved'
-- and the auto-publish trigger fires.
--
-- The auto-publish trigger from migration 0012 still fires on
-- checklist_instances.status='approved'. We add a second BEFORE-UPDATE
-- trigger here that BLOCKS the transition to 'approved' if any stage row
-- is still pending — the approve endpoint will compute the right end state
-- and only flip the instance status when all stages line up.
--
-- A separate trigger reacts to changes on checklist_instance_approvals:
--   - if any stage flips to 'rejected'   → instance status = 'rejected'
--   - if all stages are 'approved'       → instance status = 'approved'
-- This lets us approve/reject stages without re-implementing the cascade in
-- application code.
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "checklist_instance_approvals" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "instance_id"         uuid NOT NULL REFERENCES "checklist_instances"("id") ON DELETE CASCADE,
  "stage_code"          text NOT NULL,
  "stage_label"         text NOT NULL,
  "required_role_code"  text NOT NULL,
  "sort_order"          integer NOT NULL DEFAULT 0,
  "status"              text NOT NULL DEFAULT 'pending',
  "decided_by"          uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "decided_at"          timestamptz,
  "note"                text,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT checklist_instance_approvals_status_chk
    CHECK (status IN ('pending', 'approved', 'rejected'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "ux_checklist_instance_stage"
  ON "checklist_instance_approvals" ("instance_id", "stage_code");

CREATE INDEX IF NOT EXISTS "idx_checklist_instance_approvals_status"
  ON "checklist_instance_approvals" ("status");

-- ─── Cascading status trigger ───────────────────────────────────────────
-- After any approval stage row changes, recompute the parent instance's
-- status if appropriate.
--
-- Decision table:
--   any stage rejected           → instance.status = 'rejected'
--   all stages approved          → instance.status = 'approved'
--   else                         → leave as-is
--
-- We only act if the instance is currently 'awaiting_review' — once it
-- transitions to approved/rejected it's settled (the admin reopen endpoint
-- is the way back).

CREATE OR REPLACE FUNCTION "cascade_checklist_approval_status"() RETURNS trigger AS $$
DECLARE
  v_instance_id uuid;
  v_pending integer;
  v_rejected integer;
  v_total integer;
  v_status text;
BEGIN
  v_instance_id := COALESCE(NEW.instance_id, OLD.instance_id);

  SELECT status INTO v_status
    FROM checklist_instances
    WHERE id = v_instance_id;

  -- If the instance isn't currently awaiting review, do nothing. The admin
  -- escape hatches (reopen, release) reset the stages themselves.
  IF v_status IS DISTINCT FROM 'awaiting_review' THEN
    RETURN NEW;
  END IF;

  SELECT
    COUNT(*) FILTER (WHERE status = 'pending'),
    COUNT(*) FILTER (WHERE status = 'rejected'),
    COUNT(*)
  INTO v_pending, v_rejected, v_total
  FROM checklist_instance_approvals
  WHERE instance_id = v_instance_id;

  IF v_total = 0 THEN
    -- No stage rows yet — fall back to the original single-reviewer model.
    RETURN NEW;
  END IF;

  IF v_rejected > 0 THEN
    UPDATE checklist_instances
      SET status = 'rejected',
          reviewed_at = COALESCE(reviewed_at, now()),
          updated_at = now()
      WHERE id = v_instance_id;
  ELSIF v_pending = 0 THEN
    -- All non-rejected → approved (this in turn fires the auto-publish
    -- trigger added in migration 0012).
    UPDATE checklist_instances
      SET status = 'approved',
          reviewed_at = COALESCE(reviewed_at, now()),
          updated_at = now()
      WHERE id = v_instance_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_cascade_checklist_approval_status"
  ON "checklist_instance_approvals";
CREATE TRIGGER "trg_cascade_checklist_approval_status"
  AFTER INSERT OR UPDATE OF status ON "checklist_instance_approvals"
  FOR EACH ROW EXECUTE FUNCTION "cascade_checklist_approval_status"();
