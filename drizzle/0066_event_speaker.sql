-- 0066_event_speaker.sql
-- Adds speaker metadata (name, bio, photo) to events. Previously the public
-- modal had a Speaker block but no data path — the admin form had no inputs
-- and the table had no columns. This migration closes that loop.
--
-- speaker_photo_id reuses the shared files table (same upload pipeline as
-- the event banner). ON DELETE SET NULL so removing the photo from the
-- files table doesn't take the event with it.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS speaker_name     text,
  ADD COLUMN IF NOT EXISTS speaker_bio      text,
  ADD COLUMN IF NOT EXISTS speaker_photo_id uuid REFERENCES files(id) ON DELETE SET NULL;
