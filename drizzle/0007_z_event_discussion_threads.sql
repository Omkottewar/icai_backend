-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0007 — Auto-create a discussion thread when an event publishes
--
-- Behaviour:
--   • When events.status transitions to 'published' (whether by hand or via
--     the checklist auto-publish trigger from 0004), insert a default
--     forum_threads row scoped to that event.
--   • Idempotent: only creates a thread if one doesn't already exist for the
--     event (so re-publishing a previously-published event doesn't spawn
--     duplicates).
--   • The trigger uses events.created_by as the thread author. If created_by
--     is NULL (legacy/seed data), we skip — admins can manually open a thread.
--   • Backfill at the bottom creates threads for any already-published events.
--
-- Anyone signed in can still create additional threads via /community.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION "create_event_discussion_thread"() RETURNS trigger AS $$
BEGIN
  -- Only fire on transitions TO 'published' (INSERT with status='published',
  -- or UPDATE where the previous status was different).
  IF NEW.status = 'published'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'published') THEN

    IF NEW.created_by IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM "forum_threads"
         WHERE "event_id" = NEW.id AND "deleted_at" IS NULL
       ) THEN
      INSERT INTO "forum_threads" ("title", "body", "tag", "event_id", "created_by")
      VALUES (
        'Discussion: ' || NEW.title,
        E'Welcome to the discussion thread for **' || NEW.title || E'**.\n\n' ||
          E'Use this space to ask questions, share notes, or tag attendees with @name. Anyone signed in can post.',
        'discussion',
        NEW.id,
        NEW.created_by
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trg_create_event_discussion_thread" ON "events";
CREATE TRIGGER "trg_create_event_discussion_thread"
  AFTER INSERT OR UPDATE OF "status" ON "events"
  FOR EACH ROW EXECUTE FUNCTION "create_event_discussion_thread"();

-- ─── Backfill: thread for every already-published event ───────────────────
INSERT INTO "forum_threads" ("title", "body", "tag", "event_id", "created_by")
SELECT
  'Discussion: ' || e.title,
  E'Welcome to the discussion thread for **' || e.title || E'**.\n\n' ||
    E'Use this space to ask questions, share notes, or tag attendees with @name. Anyone signed in can post.',
  'discussion',
  e.id,
  e.created_by
FROM "events" e
WHERE e.status = 'published'
  AND e.deleted_at IS NULL
  AND e.created_by IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "forum_threads" ft
    WHERE ft.event_id = e.id AND ft.deleted_at IS NULL
  );
