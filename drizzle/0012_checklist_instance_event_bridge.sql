-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0012 — Bridge checklist_instances to event auto-publish
--
-- The new generic checklist engine replaces event_checklists for new events.
-- Mirrors the existing trigger on event_checklists: when an event-bound
-- instance transitions to 'approved', publish the event.
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION "auto_publish_event_on_instance_approval"() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'approved'
     AND (OLD.status IS DISTINCT FROM 'approved')
     AND NEW.event_id IS NOT NULL
  THEN
    UPDATE "events"
      SET "status" = 'published', "updated_at" = now()
      WHERE "id" = NEW.event_id
        AND "status" <> 'cancelled';
    NEW.reviewed_at := COALESCE(NEW.reviewed_at, now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_auto_publish_event_on_instance_approval" ON "checklist_instances";
CREATE TRIGGER "trg_auto_publish_event_on_instance_approval"
  BEFORE UPDATE ON "checklist_instances"
  FOR EACH ROW EXECUTE FUNCTION "auto_publish_event_on_instance_approval"();
