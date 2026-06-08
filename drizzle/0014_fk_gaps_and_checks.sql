-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0014 — Close FK gaps + add money CHECK constraints
--
-- 1. Add missing FK: user_role_assignments.scope_committee_id → committees.id
-- 2. Add missing FK: consultations.counselor_id → users.id
-- 3. Convert student_profiles.articleship_status: text → articleship_status enum
-- 4. Add CHECK constraint: payments.amount_paise >= 0
--
-- Pre-flight (run scripts/preflight-check.mjs) confirms zero orphans for the
-- new FKs and zero negative payments. All four changes are SAFE on current data.
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

-- ─── 1. user_role_assignments.scope_committee_id → committees.id ──────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'user_role_assignments'
      AND constraint_name = 'user_role_assignments_scope_committee_id_committees_id_fk'
  ) THEN
    ALTER TABLE "user_role_assignments"
      ADD CONSTRAINT "user_role_assignments_scope_committee_id_committees_id_fk"
      FOREIGN KEY ("scope_committee_id") REFERENCES "committees"("id")
      ON DELETE RESTRICT;
  END IF;
END $$;

-- ─── 2. consultations.counselor_id → users.id ─────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'consultations'
      AND constraint_name = 'consultations_counselor_id_users_id_fk'
  ) THEN
    ALTER TABLE "consultations"
      ADD CONSTRAINT "consultations_counselor_id_users_id_fk"
      FOREIGN KEY ("counselor_id") REFERENCES "users"("id")
      ON DELETE RESTRICT;
  END IF;
END $$;

-- ─── 3. student_profiles.articleship_status → enum ────────────────────────
-- The enum was created in migration 0001_hot_paibok. The column is still text.
-- Convert via USING; only "ongoing" exists in current data per preflight, and
-- it's a valid enum value. Falls back to NULL for any unexpected text so the
-- migration can't fail on dirty data.
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'student_profiles' AND column_name = 'articleship_status') = 'text' THEN
    ALTER TABLE "student_profiles"
      ALTER COLUMN "articleship_status" TYPE "articleship_status"
      USING CASE
        WHEN "articleship_status" IN ('not_started', 'ongoing', 'completed', 'terminated')
          THEN "articleship_status"::"articleship_status"
        ELSE NULL
      END;
  END IF;
END $$;

-- ─── 4. payments.amount_paise >= 0 ────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'payments'
      AND constraint_name = 'payments_amount_paise_nonneg'
  ) THEN
    ALTER TABLE "payments"
      ADD CONSTRAINT "payments_amount_paise_nonneg"
      CHECK ("amount_paise" >= 0);
  END IF;
END $$;
