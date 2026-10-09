-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0100 — SabPaisa payment gateway integration
--
-- Replaces the UPI QR + manual UTR verification flow (added in 0084/0085)
-- with SabPaisa — the branch's existing live payment gateway (Client Code
-- NBW, provisioned by SabPaisa account manager Sushanta Bhattacharyya, Oct
-- 2026). The branch has been collecting SabPaisa payments since at least
-- Oct 2024 but the previous developer never handed over the integration
-- code; this build is a fresh integration against the same merchant
-- account.
--
-- New flow:
--   1. POST /api/payments/initiate — create payment row, build encrypted
--      SabPaisa init payload, return fields the browser auto-POSTs to
--      SabPaisa's hosted checkout page.
--   2. User pays on SabPaisa's hosted page (card / UPI / netbanking / wallet).
--   3. SabPaisa POSTs encrypted response back to our return URL
--      (/api/payments/return) — we decrypt, update status, redirect user
--      to a success/failure/pending page in the SPA.
--   4. SabPaisa also fires the Push API webhook asynchronously (POST to
--      /api/payments/webhook). Either path flips the row to 'success' and
--      creates the event registration — whichever lands first wins
--      (idempotent).
--   5. Double verification endpoint hits SabPaisa /status/verify as a
--      safety net before the SPA shows "payment confirmed" to the user.
--
-- UPI QR columns (upi_utr etc.) are KEPT for historical rows — any payment
-- created before migration 0100 still shows its UTR in the admin UI. New
-- rows won't set them.
-- ════════════════════════════════════════════════════════════════════════════

-- Step 1: provider column — labels every payment row by the gateway/channel
-- that handled it. New rows default to 'sabpaisa'. Historical rows (razorpay
-- + upi_manual) are backfilled below based on which columns they populated.
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "provider" text NOT NULL DEFAULT 'sabpaisa';

-- Backfill: anything with a Razorpay order id is from the Razorpay era;
-- anything with a UTR is from the UPI-manual era. Anything with neither
-- is almost certainly a 'created' row that never got paid — label it
-- 'legacy' so it's distinguishable from new SabPaisa rows.
UPDATE "payments"
   SET "provider" = CASE
     WHEN "razorpay_order_id" IS NOT NULL THEN 'razorpay'
     WHEN "upi_utr"            IS NOT NULL THEN 'upi_manual'
     ELSE 'legacy'
   END
 WHERE "created_at" < now();

-- Step 2: SabPaisa-specific columns. All nullable — only set once we have
-- SabPaisa's response. `client_txn_id` is OUR generated reference sent to
-- SabPaisa (it echoes it back on every callback/webhook so we can
-- correlate without trusting their id). `sabpaisa_txn_id` is their id.
ALTER TABLE "payments"
  ADD COLUMN IF NOT EXISTS "client_txn_id"         text,
  ADD COLUMN IF NOT EXISTS "sabpaisa_txn_id"       text,
  ADD COLUMN IF NOT EXISTS "sabpaisa_status_code"  text,
  ADD COLUMN IF NOT EXISTS "sabpaisa_payment_mode" text,
  ADD COLUMN IF NOT EXISTS "sabpaisa_bank_name"    text,
  ADD COLUMN IF NOT EXISTS "sabpaisa_bank_txn_id"  text,
  ADD COLUMN IF NOT EXISTS "sabpaisa_response"     jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "return_received_at"    timestamptz,
  ADD COLUMN IF NOT EXISTS "webhook_received_at"   timestamptz,
  ADD COLUMN IF NOT EXISTS "last_verified_at"      timestamptz;

-- Step 3: uniqueness guards. client_txn_id is our own generation — we must
-- never reuse one across two payment rows (SabPaisa would reject the
-- second init with a duplicate). sabpaisa_txn_id uniqueness is a
-- defensive check against replayed webhooks.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_payments_client_txn_id"
  ON "payments" ("client_txn_id")
  WHERE "client_txn_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ux_payments_sabpaisa_txn_id"
  ON "payments" ("sabpaisa_txn_id")
  WHERE "sabpaisa_txn_id" IS NOT NULL;

-- Step 4: hot index for the admin "recent SabPaisa payments" view and
-- the webhook endpoint's "find payment by client_txn_id" lookup.
CREATE INDEX IF NOT EXISTS "idx_payments_provider_created"
  ON "payments" ("provider", "created_at" DESC);
