-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0085 — UPI QR payment fields + queue index + site settings
--
-- Companion to 0084 (which added the 'pending_verification' enum value).
-- Kept separate because the CREATE INDEX below references that new value
-- in a WHERE clause — Postgres won't let us do both in one transaction.
--
-- Flow (rewritten from Razorpay):
--   1. POST /events/:slug/register — creates a payment row in status
--      'pending', returns upi://pay?pa=<upi_id>&am=<amt>&tn=<ref> URI.
--   2. User pays via UPI app, comes back and submits the UTR.
--   3. POST /events/:slug/submit-utr — flips status to
--      'pending_verification', stashes utr + optional screenshot.
--   4. Admin reviews in /admin/payments, clicks Approve → status
--      'success', creates the event_registrations row, fires confirmation.
--      Reject sets 'failed' + rejected_reason and emails the user.
--
-- Razorpay columns are kept for old rows and easy future reintroduction.
-- ════════════════════════════════════════════════════════════════════════════

-- Step 1: UPI verification columns. All nullable — old Razorpay rows leave
-- them blank, new QR flows set them at UTR submission / verification time.
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "upi_utr"                text,
  ADD COLUMN IF NOT EXISTS "upi_screenshot_file_id" uuid REFERENCES "files" ("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "verified_by"            uuid REFERENCES "users" ("id") ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS "verified_at"            timestamptz,
  ADD COLUMN IF NOT EXISTS "rejected_reason"        text;

-- Step 2: partial unique index on UTR so a fraudster can't submit the same
-- UPI reference against two different registrations. NULL utrs are ignored
-- (Razorpay rows never had one; unsubmitted QR rows haven't set one yet).
CREATE UNIQUE INDEX IF NOT EXISTS "ux_payments_upi_utr"
  ON "payments" ("upi_utr")
  WHERE "upi_utr" IS NOT NULL;

-- Step 3: pending-verification queue index — admin dashboard opens with
-- this exact filter, so give it a hot index. Uses the value 0084 just
-- added; the file split is what lets Postgres accept this.
CREATE INDEX IF NOT EXISTS "idx_payments_pending_verification"
  ON "payments" ("status", "created_at" DESC)
  WHERE "status" = 'pending_verification';

-- Step 4: seed the UPI ID as a site setting so admin can change it later
-- from Site Content admin without a redeploy. Blank by default — the
-- backend rejects paid registrations with a friendly "payments not
-- configured yet" until the admin fills it in.
INSERT INTO "site_settings" ("key", "value")
VALUES ('payment_upi_id', '')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "site_settings" ("key", "value")
VALUES ('payment_upi_payee_name', 'ICAI Nagpur Branch')
ON CONFLICT ("key") DO NOTHING;
