-- Migration 0107 — event registration by membership number (no login).
-- One-time email codes used by server/routes/memberVerify.ts. The server
-- also creates this table on first use (CREATE TABLE IF NOT EXISTS), so
-- running this file by hand is optional.
CREATE TABLE IF NOT EXISTS "member_otps" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "purpose"         text NOT NULL,
  "mrn"             text NOT NULL,
  "email"           text NOT NULL,
  "code_hash"       text NOT NULL,
  "user_id"         uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "linking_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "pending"         jsonb NOT NULL DEFAULT '{}'::jsonb,
  "attempts"        integer NOT NULL DEFAULT 0,
  "expires_at"      timestamptz NOT NULL,
  "consumed_at"     timestamptz,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_member_otps_mrn_created" ON "member_otps" ("mrn", "created_at");
