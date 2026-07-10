-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0084 — UPI QR payment flow replaces Razorpay
--
-- The branch is dropping Razorpay for now and switching to a
-- "customer scans a UPI QR + manual admin verification" model. Every
-- paid event (and every other paid flow) now:
--
--   1. Creates a payment row in status 'pending' with the amount and
--      purpose, no razorpay_order_id.
--   2. The frontend renders `upi://pay?pa=<upi_id>&pn=ICAI+Nagpur&am=<amt>&tn=<ref>`
--      as a QR. Amount is pre-filled in the user's UPI app.
--   3. After paying, the user submits the UTR (UPI reference number) +
--      an optional screenshot. Payment flips to 'pending_verification'.
--   4. Admin sees a queue in /admin/payments, cross-checks against the
--      bank statement, and clicks Approve → status 'success', creates
--      the event registration row, fires the confirmation email.
--
-- Reject flow: admin marks 'failed' with a reason; the user gets an
-- email and can retry. The Razorpay columns (order_id, payment_id,
-- signature) are kept for now — old rows still have them and future
-- reintroduction of Razorpay stays a one-migration change.
--
-- Safe to re-run: uses IF NOT EXISTS + DO block for the enum value.
-- ════════════════════════════════════════════════════════════════════════════

-- Step 1: add 'pending_verification' to payment_status. Wrapped in DO so
-- re-runs after the value exists are silent.
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

-- Step 2: UPI verification columns. All nullable — old Razorpay rows have
-- these blank, new QR flows set them at UTR submission / verification time.
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "upi_utr"                text,
  ADD COLUMN IF NOT EXISTS "upi_screenshot_file_id" uuid REFERENCES "files" ("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "verified_by"            uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "verified_at"            timestamptz,
  ADD COLUMN IF NOT EXISTS "rejected_reason"        text;

-- Step 3: partial unique index on UTR so a fraudster can't submit the same
-- UPI reference against two different registrations. NULL utrs are ignored
-- (Razorpay rows never had one; unsubmitted QR rows haven't set one yet).
CREATE UNIQUE INDEX IF NOT EXISTS "ux_payments_upi_utr"
  ON "payments" ("upi_utr")
  WHERE "upi_utr" IS NOT NULL;

-- Step 4: pending-verification queue index — the admin dashboard opens with
-- this exact filter, so give it a hot index.
CREATE INDEX IF NOT EXISTS "idx_payments_pending_verification"
  ON "payments" ("status", "created_at" DESC)
  WHERE "status" = 'pending_verification';

-- Step 5: seed the UPI ID as a site setting so admin can change it later
-- from Site Content admin without a redeploy. Blank by default — the
-- frontend renders a friendly "payments not configured yet" message when
-- it's empty.
INSERT INTO "site_settings" ("key", "value")
VALUES ('payment_upi_id', '')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "site_settings" ("key", "value")
VALUES ('payment_upi_payee_name', 'ICAI Nagpur Branch')
ON CONFLICT ("key") DO NOTHING;
