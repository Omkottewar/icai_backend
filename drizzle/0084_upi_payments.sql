-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0084 — payment_status: add 'pending_verification'
--
-- Postgres refuses `ALTER TYPE ... ADD VALUE` and any statement that
-- REFERENCES that new value in the same transaction. Our migration runner
-- wraps each file in one transaction, so the enum change lives here on
-- its own — the follow-up 0085 file adds the columns / indexes that use
-- the value, and by the time it runs the enum change has committed.
--
-- Safe to re-run: DO block skips silently if the value is already present.
-- ════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'payment_status' AND e.enumlabel = 'pending_verification'
  ) THEN
    ALTER TYPE "payment_status" ADD VALUE 'pending_verification' AFTER 'pending';
  END IF;
END $$;
