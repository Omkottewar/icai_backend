-- Enable webpush delivery for every existing notification template.
--
-- The original schema default for notification_templates.channels was
-- ['inapp', 'email'] which meant the webpush fan-out in notify.ts was a
-- dead branch — subscriptions were stored, the service worker was wired,
-- but nothing ever called sendNotification(). On installed PWAs this
-- looked like "push notifications just don't work."
--
-- This migration:
--   1. Updates the column DEFAULT so new templates get webpush automatically.
--   2. Appends 'webpush' to every existing template that doesn't already
--      have it. Idempotent — re-running the migration is a no-op.

ALTER TABLE notification_templates
  ALTER COLUMN channels SET DEFAULT ARRAY['inapp', 'email', 'webpush']::text[];

UPDATE notification_templates
SET channels = array_append(channels, 'webpush')
WHERE 'webpush' <> ALL(channels);
