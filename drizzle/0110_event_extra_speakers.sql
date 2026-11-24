-- Extra speakers per event (first speaker stays in events.speaker_*).
-- Also created on first use by server/lib/eventSpeakers.ts.
CREATE TABLE IF NOT EXISTS "event_extra_speakers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id" uuid NOT NULL REFERENCES "events"("id") ON DELETE CASCADE,
  "position" integer NOT NULL,
  "name" text NOT NULL,
  "bio" text,
  "photo_id" uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "event_extra_speakers_event_idx" ON "event_extra_speakers" ("event_id", "position");
