-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0103 — Swap SabPaisa for Razorpay
--
-- The SabPaisa integration added in migration 0100 is replaced with
-- Razorpay (modal-based Checkout + HMAC signature verification). The
-- branch never went live on SabPaisa — no production payments were
-- collected through 0100's columns — so we DROP the SabPaisa columns
-- outright rather than leaving them around as dead space. The
-- unique-index + `provider` default also flip to the new gateway.
--
-- Razorpay columns (razorpay_order_id, razorpay_payment_id,
-- razorpay_signature) already exist from the pre-0100 era — we keep them
-- as-is, except razorpay_order_id goes from "nullable unique" to carrying
-- live production data again.
--
-- UPI QR columns (upi_utr, upi_screenshot_file_id, etc.) are KEPT for the
-- historical pending_verification rows the admin backfill queue still
-- processes.
-- ════════════════════════════════════════════════════════════════════════════

-- Step 1: drop the SabPaisa-specific indexes before dropping the columns
-- they index (Postgres would cascade, but explicit is clearer in the
-- migration log).
DROP INDEX IF EXISTS "ux_payments_client_txn_id";
DROP INDEX IF EXISTS "ux_payments_sabpaisa_txn_id";
DROP INDEX IF EXISTS "idx_payments_provider_created";

-- Step 2: drop the SabPaisa columns themselves. No data loss risk — never
-- used in production.
ALTER TABLE "payments"
  DROP COLUMN IF EXISTS "client_txn_id",
  DROP COLUMN IF EXISTS "sabpaisa_txn_id",
  DROP COLUMN IF EXISTS "sabpaisa_status_code",
  DROP COLUMN IF EXISTS "sabpaisa_payment_mode",
  DROP COLUMN IF EXISTS "sabpaisa_bank_name",
  DROP COLUMN IF EXISTS "sabpaisa_bank_txn_id",
  DROP COLUMN IF EXISTS "sabpaisa_response",
  DROP COLUMN IF EXISTS "return_received_at",
  DROP COLUMN IF EXISTS "webhook_received_at",
  DROP COLUMN IF EXISTS "last_verified_at";

-- Step 3: flip the default `provider` from 'sabpaisa' to 'razorpay' so
-- any new INSERT that omits the column lands on the right label. Backfill
-- existing rows with provider = 'sabpaisa' (should only be 0100-era test
-- rows) to 'razorpay' so the admin UI doesn't surface a dead gateway name.
ALTER TABLE "payments" ALTER COLUMN "provider" SET DEFAULT 'razorpay';
UPDATE "payments" SET "provider" = 'razorpay' WHERE "provider" = 'sabpaisa';

-- Step 4: re-add the hot index on (provider, created_at) that migration
-- 0100 set up — still useful for the admin "recent Razorpay payments"
-- view, and for the reconciliation cron's scan.
CREATE INDEX IF NOT EXISTS "idx_payments_provider_created"
  ON "payments" ("provider", "created_at" DESC);

-- Step 5: update the sold-out treasurer notification template. The var
-- name went from {{sabpaisa_txn_id}} → {{gateway_txn_id}} so the template
-- isn't tied to any one gateway. Body copy also renamed "SabPaisa Txn"
-- → "Txn ID" for the same reason.
UPDATE "notification_templates"
   SET email_body = E'Hi {{first_name}},\n\nA payment landed after "{{event_title}}" reached capacity. The payer has been auto-waitlisted and now needs a refund.\n\n  Payer:          {{payer_name}} ({{payer_email}})\n  Amount:         ₹{{amount_rupees}}\n  Payment ID:     {{payment_id}}\n  Txn ID:         {{gateway_txn_id}}\n  Event:          {{event_title}} on {{event_date}}\n\nProcess the refund from the admin console → Refunds queue. The payment is flagged `needs_refund = event_full_after_payment`.\n\n{{refund_queue_link}}\n\n— ICAI Nagpur Portal'
 WHERE key = 'payment_sold_out_treasurer';
