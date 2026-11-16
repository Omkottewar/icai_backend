-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0105 — Re-add SabPaisa payment columns for dual-provider support
--
-- Brings back the SabPaisa columns dropped in migration 0103 so the branch
-- can run Razorpay + SabPaisa side-by-side. Which gateway handles a given
-- payment is decided at /initiate time by the PAYMENT_PROVIDER env var
-- (see backend/server/lib/paymentProvider.ts). Historical Razorpay rows
-- stay on `provider = 'razorpay'`; new rows land on whichever provider the
-- active env flag names.
--
-- Rationale: Razorpay live account is currently Cards-only (UPI / Netbanking
-- / Wallet activation pending). Rather than wait an uncertain number of
-- days for activation while paid events keep landing, rebuild the SabPaisa
-- integration (F30 spec) so the branch can flip to SabPaisa in minutes via
-- `fly secrets set PAYMENT_PROVIDER=sabpaisa`. Once Razorpay UPI activates,
-- flip back the same way — zero code change, zero downtime.
--
-- This migration is schema-only: no data moves, no existing rows change.
-- Safe to run on a live DB with Razorpay traffic in flight.
-- ════════════════════════════════════════════════════════════════════════════

-- Step 1: SabPaisa-specific columns. All nullable — only set once we have
-- SabPaisa's response. Shape matches 0100 exactly so the admin UI code that
-- surfaces these columns doesn't need another migration.
--   `client_txn_id`        OUR generated ref sent to SabPaisa (they echo it back)
--   `sabpaisa_txn_id`      SabPaisa's internal txn id (returned in callback + webhook)
--   `sabpaisa_status_code` numeric status code from SabPaisa (`0000` = success)
--   `sabpaisa_payment_mode` card / UPI / netbanking / wallet
--   `sabpaisa_bank_name`   acquiring bank name (card / netbanking) or VPA issuer (UPI)
--   `sabpaisa_bank_txn_id` acquiring bank's reference
--   `sabpaisa_response`    full decrypted callback / webhook JSON for audit
--   `return_received_at`   when the browser hit /api/payments/sabpaisa/return
--   `webhook_received_at`  when SabPaisa's Push API hit /api/payments/sabpaisa/webhook
--   `last_verified_at`     when we last polled SabPaisa's /status/verify endpoint
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

-- Step 2: uniqueness guards. client_txn_id is our own generation — we must
-- never reuse one across two payment rows (SabPaisa would reject the second
-- init with a duplicate). sabpaisa_txn_id uniqueness is a defensive check
-- against replayed webhooks.
CREATE UNIQUE INDEX IF NOT EXISTS "ux_payments_client_txn_id"
  ON "payments" ("client_txn_id")
  WHERE "client_txn_id" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "ux_payments_sabpaisa_txn_id"
  ON "payments" ("sabpaisa_txn_id")
  WHERE "sabpaisa_txn_id" IS NOT NULL;

-- Step 3: the hot (provider, created_at) index already exists from 0103 —
-- no-op if present. Keeps the admin "recent payments" view fast when
-- filtered by provider.
CREATE INDEX IF NOT EXISTS "idx_payments_provider_created"
  ON "payments" ("provider", "created_at" DESC);
