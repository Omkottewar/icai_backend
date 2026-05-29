-- ──────────────────────────────────────────────────────────────────────────
-- verify.sql — sanity-check that Supabase matches the expected schema.
--
-- Paste into Supabase SQL Editor and run. Each block prints a small report.
-- Expected counts noted in comments — if anything is off, the diff tells you
-- exactly what's missing.
-- ──────────────────────────────────────────────────────────────────────────

-- 1. Tables that should exist (expect 25 rows, all present=true)
WITH expected(name) AS (VALUES
  ('branches'),('roles'),('users'),('user_role_assignments'),('mfa_devices'),
  ('employers'),('employer_users'),('member_profiles'),('student_profiles'),
  ('sessions'),('magic_links'),('oauth_links'),
  ('payments'),('payment_refunds'),('payment_disputes'),('invoices'),
  ('events'),('event_registrations'),('cpe_credits'),
  ('firms'),('job_postings'),
  ('approvals'),('room_bookings'),
  ('consultations'),('cabf_assistance_requests')
)
SELECT
  e.name AS table_name,
  (t.tablename IS NOT NULL) AS present
FROM expected e
LEFT JOIN pg_tables t ON t.schemaname = 'public' AND t.tablename = e.name
ORDER BY present ASC, e.name;

-- 2. Enums that should exist (expect 41 rows, all present=true).
--    The unused ones (chat_role, kb_*, etc) are intentional — see prior review.
WITH expected(name) AS (VALUES
  ('application_status'),('approval_stage'),('approval_status'),('approval_target'),
  ('chat_role'),('circular_source'),('consultation_kind'),('consultation_status'),
  ('cop_status'),('cpe_type'),('dignitary_role'),('dispute_status'),
  ('doc_locker_type'),('employer_user_role'),('event_audience'),('event_mode'),
  ('event_status'),('file_scan_status'),('gender'),('grievance_status'),
  ('home_slot_kind'),('kb_ingest_status'),('kb_scope'),('kb_source_type'),
  ('locale'),('mfa_type'),('newsletter_status'),('notification_channel'),
  ('payment_purpose'),('payment_status'),('posting_status'),('posting_type'),
  ('question_status'),('refund_status'),('registration_status'),
  ('room_booking_status'),('service_request_status'),('service_request_type'),
  ('standard_family'),('student_level'),('user_role'),('user_status')
)
SELECT e.name AS enum_name, (t.typname IS NOT NULL) AS present
FROM expected e
LEFT JOIN pg_type t ON t.typname = e.name AND t.typtype = 'e'
ORDER BY present ASC, e.name;

-- 3. Hand-added constraints from 0001 (expect 8 rows, all present=true).
WITH expected(name, kind) AS (VALUES
  ('event_capacity_check',        'CHECK'),
  ('room_booking_slot_valid',     'CHECK'),
  ('consultation_slot_valid',     'CHECK'),
  ('ura_window_valid',            'CHECK'),
  ('room_no_overlap',             'EXCLUDE'),
  ('consultation_no_overlap',     'EXCLUDE'),
  ('payments_razorpay_order_id_unique', 'UNIQUE'),  -- from 0000 — sanity
  ('users_email_unique',          'UNIQUE')          -- from 0000 — sanity
)
SELECT e.name AS constraint_name, e.kind AS expected_kind,
       (c.conname IS NOT NULL) AS present
FROM expected e
LEFT JOIN pg_constraint c ON c.conname = e.name
ORDER BY present ASC, e.name;

-- 4. Hand-added unique + hot-path indexes from 0001
--    (expect 30 rows, all present=true).
WITH expected(name) AS (VALUES
  -- composite uniques
  ('employer_users_emp_user_uniq'),
  ('oauth_links_provider_extid_uniq'),
  ('event_registrations_event_user_uniq'),
  ('approvals_target_stage_uniq'),
  ('user_role_assignments_active_uniq'),
  -- hot-path indexes
  ('users_branch_id_idx'),
  ('user_role_assignments_user_idx'),
  ('user_role_assignments_role_idx'),
  ('user_role_assignments_committee_idx'),
  ('sessions_user_idx'),('sessions_expires_idx'),
  ('magic_links_scope_idx'),('magic_links_expires_idx'),
  ('mfa_devices_user_idx'),
  ('events_committee_starts_idx'),('events_status_starts_idx'),('events_branch_starts_idx'),
  ('event_registrations_user_idx'),
  ('cpe_credits_user_year_idx'),('cpe_credits_user_type_idx'),
  ('payments_payer_idx'),('payments_purpose_status_idx'),('payments_ref_idx'),
  ('payment_refunds_payment_idx'),('payment_disputes_payment_idx'),('invoices_payment_idx'),
  ('firms_name_idx'),('firms_areas_gin'),
  ('job_postings_type_status_idx'),('job_postings_poster_idx'),('job_postings_expires_idx'),
  ('room_bookings_room_slot_idx'),('room_bookings_user_idx'),
  ('consultations_counselor_idx'),('consultations_client_idx'),
  ('approvals_target_idx'),('approvals_reviewer_pending_idx')
)
SELECT e.name AS index_name, (i.indexname IS NOT NULL) AS present
FROM expected e
LEFT JOIN pg_indexes i ON i.schemaname = 'public' AND i.indexname = e.name
ORDER BY present ASC, e.name;

-- 5. btree_gist extension must be enabled for the EXCLUDE constraints
SELECT extname, extversion
FROM pg_extension
WHERE extname = 'btree_gist';

-- 6. Foreign-key count per table — useful baseline for "does it look right"
SELECT
  tc.table_name,
  COUNT(*) AS fk_count
FROM information_schema.table_constraints tc
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND tc.table_schema = 'public'
GROUP BY tc.table_name
ORDER BY tc.table_name;

-- 7. Stale drizzle migration tracking — should show 1 row per applied migration
SELECT id, hash, created_at
FROM drizzle.__drizzle_migrations
ORDER BY created_at DESC;
