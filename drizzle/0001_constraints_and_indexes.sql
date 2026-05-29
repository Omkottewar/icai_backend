-- ──────────────────────────────────────────────────────────────────────────
-- 0001_constraints_and_indexes.sql
--
-- Hand-written follow-up to the auto-generated 0000_*.sql. Drizzle-kit
-- cannot emit EXCLUDE constraints or CHECK constraints today, and the
-- composite uniques + hot-path indexes below were missed by the schema files.
--
-- Apply via: psql "$DATABASE_URL" -f drizzle/0001_constraints_and_indexes.sql
-- (or paste into Supabase SQL Editor)
--
-- Idempotent: uses IF NOT EXISTS everywhere.
-- ──────────────────────────────────────────────────────────────────────────

-- ─── Extensions ───────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ─── Composite UNIQUEs (data integrity) ───────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS employer_users_emp_user_uniq
  ON employer_users (employer_id, user_id);

CREATE UNIQUE INDEX IF NOT EXISTS oauth_links_provider_extid_uniq
  ON oauth_links (provider, external_id);

CREATE UNIQUE INDEX IF NOT EXISTS event_registrations_event_user_uniq
  ON event_registrations (event_id, user_id)
  WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS approvals_target_stage_uniq
  ON approvals (target_type, target_id, stage);

CREATE UNIQUE INDEX IF NOT EXISTS user_role_assignments_active_uniq
  ON user_role_assignments (user_id, role_id, COALESCE(scope_committee_id, '00000000-0000-0000-0000-000000000000'::uuid), effective_from);

-- ─── Hot-path indexes ─────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS users_branch_id_idx                  ON users (branch_id);
CREATE INDEX IF NOT EXISTS user_role_assignments_user_idx       ON user_role_assignments (user_id);
CREATE INDEX IF NOT EXISTS user_role_assignments_role_idx       ON user_role_assignments (role_id);
CREATE INDEX IF NOT EXISTS user_role_assignments_committee_idx  ON user_role_assignments (scope_committee_id);

CREATE INDEX IF NOT EXISTS sessions_user_idx                    ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx                 ON sessions (expires_at);

CREATE INDEX IF NOT EXISTS magic_links_scope_idx                ON magic_links (scope_type, scope_id);
CREATE INDEX IF NOT EXISTS magic_links_expires_idx              ON magic_links (expires_at);

CREATE INDEX IF NOT EXISTS mfa_devices_user_idx                 ON mfa_devices (user_id);

CREATE INDEX IF NOT EXISTS events_committee_starts_idx          ON events (committee_id, starts_at);
CREATE INDEX IF NOT EXISTS events_status_starts_idx             ON events (status, starts_at);
CREATE INDEX IF NOT EXISTS events_branch_starts_idx             ON events (branch_id, starts_at);

CREATE INDEX IF NOT EXISTS event_registrations_user_idx         ON event_registrations (user_id);

CREATE INDEX IF NOT EXISTS cpe_credits_user_year_idx            ON cpe_credits (user_id, year);
CREATE INDEX IF NOT EXISTS cpe_credits_user_type_idx            ON cpe_credits (user_id, type);

CREATE INDEX IF NOT EXISTS payments_payer_idx                   ON payments (payer_user_id);
CREATE INDEX IF NOT EXISTS payments_purpose_status_idx          ON payments (purpose, status);
CREATE INDEX IF NOT EXISTS payments_ref_idx                     ON payments (ref_type, ref_id);

CREATE INDEX IF NOT EXISTS payment_refunds_payment_idx          ON payment_refunds (payment_id);
CREATE INDEX IF NOT EXISTS payment_disputes_payment_idx         ON payment_disputes (payment_id);
CREATE INDEX IF NOT EXISTS invoices_payment_idx                 ON invoices (payment_id);

CREATE INDEX IF NOT EXISTS firms_name_idx                       ON firms (name);
CREATE INDEX IF NOT EXISTS firms_areas_gin                      ON firms USING gin (areas_of_expertise);

CREATE INDEX IF NOT EXISTS job_postings_type_status_idx         ON job_postings (type, status);
CREATE INDEX IF NOT EXISTS job_postings_poster_idx              ON job_postings (poster_user_id);
CREATE INDEX IF NOT EXISTS job_postings_expires_idx             ON job_postings (expires_at);

CREATE INDEX IF NOT EXISTS room_bookings_room_slot_idx          ON room_bookings (room_id, slot_start);
CREATE INDEX IF NOT EXISTS room_bookings_user_idx               ON room_bookings (user_id);

CREATE INDEX IF NOT EXISTS consultations_counselor_idx          ON consultations (counselor_id, slot_start);
CREATE INDEX IF NOT EXISTS consultations_client_idx             ON consultations (client_user_id, slot_start);

CREATE INDEX IF NOT EXISTS approvals_target_idx                 ON approvals (target_type, target_id);
CREATE INDEX IF NOT EXISTS approvals_reviewer_pending_idx       ON approvals (reviewed_by, status);

-- ─── CHECK constraints (sanity guards) ────────────────────────────────────

-- Capacity guard (per events.ts comment)
ALTER TABLE events
  DROP CONSTRAINT IF EXISTS event_capacity_check;
ALTER TABLE events
  ADD CONSTRAINT event_capacity_check
  CHECK (capacity IS NULL OR registered_count <= capacity);

-- Slot sanity (per ops.ts / counseling.ts comments)
ALTER TABLE room_bookings
  DROP CONSTRAINT IF EXISTS room_booking_slot_valid;
ALTER TABLE room_bookings
  ADD CONSTRAINT room_booking_slot_valid
  CHECK (slot_end > slot_start);

ALTER TABLE consultations
  DROP CONSTRAINT IF EXISTS consultation_slot_valid;
ALTER TABLE consultations
  ADD CONSTRAINT consultation_slot_valid
  CHECK (slot_end > slot_start);

-- Role-effective-window sanity
ALTER TABLE user_role_assignments
  DROP CONSTRAINT IF EXISTS ura_window_valid;
ALTER TABLE user_role_assignments
  ADD CONSTRAINT ura_window_valid
  CHECK (effective_to IS NULL OR effective_to >= effective_from);

-- ─── EXCLUDE constraints (no double-booking) ──────────────────────────────

ALTER TABLE room_bookings
  DROP CONSTRAINT IF EXISTS room_no_overlap;
ALTER TABLE room_bookings
  ADD CONSTRAINT room_no_overlap
  EXCLUDE USING gist (
    room_id WITH =,
    tstzrange(slot_start, slot_end, '[)') WITH &&
  ) WHERE (status NOT IN ('cancelled'));

ALTER TABLE consultations
  DROP CONSTRAINT IF EXISTS consultation_no_overlap;
ALTER TABLE consultations
  ADD CONSTRAINT consultation_no_overlap
  EXCLUDE USING gist (
    counselor_id WITH =,
    tstzrange(slot_start, slot_end, '[)') WITH &&
  ) WHERE (status NOT IN ('cancelled', 'no_show'));
