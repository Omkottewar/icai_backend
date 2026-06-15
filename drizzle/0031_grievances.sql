-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0031 — Grievances
--
-- Adds the public Contact / Grievance / Suggestion form backing store + the
-- admin-editable subject → email routing table. Spec confirmed by client in
-- the requirements PDF (Q.2): single combined form, 3-value subject dropdown
-- (Events / Membership Updation / Other), admin CRUD over routing, 48h SLA,
-- newsletter integration flagged at chairperson's discretion.
--
-- The grievance_status enum + the `grievance_ack` notification template
-- already exist (migrations 0000 and 0016). This migration only adds the
-- two new tables and the seed routes.
--
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "grievance_subject_routes" (
  "subject"     text PRIMARY KEY,
  "label"       text NOT NULL,
  "route_email" text NOT NULL,
  "active"      boolean NOT NULL DEFAULT true,
  "updated_by"  uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "grievances" (
  "id"                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "ticket_no"                text NOT NULL UNIQUE,
  "name"                     text NOT NULL,
  "email"                    text NOT NULL,
  "phone"                    text,
  "subject"                  text NOT NULL,
  "against_type"             text NOT NULL DEFAULT 'branch',
  "against_ref"              text,
  "message"                  text NOT NULL,
  "user_id"                  uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "status"                   grievance_status NOT NULL DEFAULT 'open',
  "assigned_to"              uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "resolution_note"          text,
  "resolved_at"              timestamptz,
  "feature_in_newsletter"    boolean NOT NULL DEFAULT false,
  "newsletter_approved_by"   uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "newsletter_approved_at"   timestamptz,
  "escalated_at"             timestamptz,
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  "updated_at"               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT grievances_against_type_chk
    CHECK (against_type IN ('member','firm','branch'))
);

CREATE INDEX IF NOT EXISTS "grievances_status_idx"
  ON "grievances" ("status", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "grievances_email_idx"
  ON "grievances" ("email");

-- Partial index — only unresolved rows are eligible for the 48h escalation
-- sweep, so the cron's lookup is essentially free as the backlog grows.
CREATE INDEX IF NOT EXISTS "grievances_open_no_escal_idx"
  ON "grievances" ("created_at")
  WHERE "status" IN ('open','in_review') AND "escalated_at" IS NULL;

-- ─── Seed routes ─────────────────────────────────────────────────────────────
-- Client-confirmed subject list: Events / Membership Updation / Other.
-- Routes default to the dev test inbox until the branch confirms per-subject
-- addresses; admin re-points them via /admin/grievance-routes at that point.
-- An additional safety net lives in lib/email.ts (DEV_EMAIL_OVERRIDE env var)
-- which redirects ALL outbound mail in non-production builds.

INSERT INTO "grievance_subject_routes" (subject, label, route_email)
VALUES
  ('events',             'Events',             'omkottewar19.04@gmail.com'),
  ('membership_updation','Membership Updation','omkottewar19.04@gmail.com'),
  ('other',              'Other',              'omkottewar19.04@gmail.com')
ON CONFLICT (subject) DO NOTHING;
