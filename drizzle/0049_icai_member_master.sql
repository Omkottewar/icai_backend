-- 0049_icai_member_master.sql
-- Local mirror of the ICAI master member directory. The branch admin
-- uploads ICAI_DIRECTORY.xlsx via /admin/icai-directory; the importer
-- upserts rows into this table.
--
-- Used at signup time (Open Question #3): when role=member, the supplied
-- MRN must exist here before Auth0 creates the account. Defends against
-- random sign-ups from people who aren't actually CAs.
--
-- We intentionally store ONLY what's needed for signup gating + UI prefill.
-- Sensitive PII (Aadhar / PAN) does NOT live in this table — that data
-- belongs in member_profiles after onboarding, with explicit consent.

CREATE TABLE IF NOT EXISTS icai_member_master (
  mrn           text PRIMARY KEY,
  name          text NOT NULL,
  email         text,
  phone         text,
  city          text,
  firm_name     text,
  fca_flag      boolean NOT NULL DEFAULT false,
  cop_status    text,
  imported_at   timestamptz NOT NULL DEFAULT now(),
  source_file   text,
  raw           jsonb
);

CREATE INDEX IF NOT EXISTS idx_icai_member_master_email
  ON icai_member_master (lower(email))
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_icai_member_master_imported_at
  ON icai_member_master (imported_at DESC);

-- Feature flag: when 'true', signup rejects member-role applications
-- whose MRN is not in this table. Default 'false' so existing dev/test
-- accounts keep working until the branch uploads their first directory.
INSERT INTO site_settings (key, value)
VALUES ('signup.mrn_gating_enabled', 'false')
ON CONFLICT (key) DO NOTHING;
