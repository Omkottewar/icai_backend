-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0032 — Web push subscriptions
--
-- Adds:
--   • push_subscriptions   one row per (user, device); stores the Web Push
--                          API endpoint + VAPID keypair returned by the
--                          browser's PushManager.subscribe() call.
--
-- Also extends notification_deliveries.channel CHECK to allow 'webpush'
-- so the audit trail can record push fan-outs alongside email / inapp.
--
-- Push delivery is logged-in-user-only — anonymous visitors never get a
-- subscription row because the subscribe endpoint requires a session.
--
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"      uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "endpoint"     text NOT NULL,
  "p256dh"       text NOT NULL,
  "auth"         text NOT NULL,
  "user_agent"   text,
  "created_at"   timestamptz NOT NULL DEFAULT now(),
  "last_seen_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "push_subscriptions_user_idx"
  ON "push_subscriptions" ("user_id");

-- The push service's endpoint URL is globally unique by construction —
-- treat it as the natural key so a re-subscribe from the same device
-- refreshes (UPSERT) instead of duplicating.
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_endpoint_uq"
  ON "push_subscriptions" ("endpoint");

-- Extend the channel CHECK to include 'webpush'. DROP/ADD is the standard
-- pattern since CHECK constraints aren't IF NOT EXISTS in Postgres.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'notification_deliveries_channel_chk'
       AND conrelid = 'notification_deliveries'::regclass
  ) THEN
    ALTER TABLE "notification_deliveries"
      DROP CONSTRAINT "notification_deliveries_channel_chk";
  END IF;
END$$;

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_channel_chk"
  CHECK (channel IN ('email','sms','whatsapp','inapp','webpush'));
