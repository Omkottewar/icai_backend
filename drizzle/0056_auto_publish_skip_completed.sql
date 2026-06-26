-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0056 — Don't auto-publish a 'completed' event
--
-- The auto_publish_event_on_instance_approval trigger (added in 0012) fires
-- whenever a checklist instance flips to 'approved' and resets the linked
-- event's status to 'published'. Its guard only excluded 'cancelled' events.
--
-- The gap: post-event paperwork (bills, attendance) often gets approved
-- AFTER the event has already auto-marked itself 'completed'. The trigger
-- would silently regress that event back to 'published', which polluted
-- upcoming-event lists, double-counted reports, and confused members.
--
-- This migration replaces the function with a stricter guard that also
-- excludes 'completed' events. Idempotent — safe to re-run.
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
        AND "status" NOT IN ('cancelled', 'completed');
    NEW.reviewed_at := COALESCE(NEW.reviewed_at, now());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
