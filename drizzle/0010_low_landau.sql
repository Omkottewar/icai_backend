-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0010_low_landau — Notifications (drizzle-generated)
--
-- DUPLICATE of 0016_notifications.sql. drizzle-kit auto-generated this file
-- after schema/notifications.ts was committed; the hand-written 0016 had
-- already applied the same tables. Converted to IF NOT EXISTS so re-running
-- this file is a no-op on any database that already has the notifications
-- tables from 0016. Functionally identical to the no-op path.
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "notification_deliveries" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "notification_id" uuid NOT NULL,
  "channel"         text NOT NULL,
  "recipient"       text NOT NULL,
  "status"          text DEFAULT 'queued' NOT NULL,
  "error"           text,
  "attempted_at"    timestamp with time zone DEFAULT now() NOT NULL,
  "sent_at"         timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "notification_templates" (
  "key"           text PRIMARY KEY NOT NULL,
  "name"          text NOT NULL,
  "description"   text,
  "channels"      text[] DEFAULT '{"inapp","email"}' NOT NULL,
  "email_subject" text,
  "email_body"    text,
  "inapp_title"   text,
  "inapp_body"    text,
  "enabled"       boolean DEFAULT true NOT NULL,
  "updated_by"    uuid,
  "updated_at"    timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "notifications" (
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id"      uuid NOT NULL,
  "template_key" text,
  "title"        text NOT NULL,
  "body"         text,
  "link_url"     text,
  "metadata"     jsonb DEFAULT '{}'::jsonb NOT NULL,
  "read_at"      timestamp with time zone,
  "created_at"   timestamp with time zone DEFAULT now() NOT NULL
);

DO $$ BEGIN
  ALTER TABLE "notification_deliveries"
    ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk"
    FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "notification_templates"
    ADD CONSTRAINT "notification_templates_updated_by_users_id_fk"
    FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_user_id_users_id_fk"
    FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "notifications"
    ADD CONSTRAINT "notifications_template_key_notification_templates_key_fk"
    FOREIGN KEY ("template_key") REFERENCES "public"."notification_templates"("key") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "notification_deliveries_notification_idx"
  ON "notification_deliveries" USING btree ("notification_id");

CREATE INDEX IF NOT EXISTS "notifications_user_idx"
  ON "notifications" USING btree ("user_id","created_at");
