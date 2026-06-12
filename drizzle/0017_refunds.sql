-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0017 — payment_refunds (reintroduced v2)
--
-- Was dropped in migration 0015 as v0 dead weight. This is the v2 — every
-- column has a concrete caller in the treasurer dashboard work.
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "payment_refunds" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "payment_id"          uuid NOT NULL REFERENCES "payments"("id") ON DELETE RESTRICT,
  "amount_paise"        integer NOT NULL,
  "reason"              text NOT NULL,
  "status"              text NOT NULL DEFAULT 'requested',
  "requested_by"        uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "requested_at"        timestamptz NOT NULL DEFAULT now(),
  "approved_by"         uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "approved_at"         timestamptz,
  "razorpay_refund_id"  text,
  "processed_at"        timestamptz,
  "notes"               text,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_refunds_status_chk
    CHECK (status IN ('requested','approved','rejected','processed')),
  CONSTRAINT payment_refunds_amount_chk
    CHECK (amount_paise > 0)
);

CREATE INDEX IF NOT EXISTS "payment_refunds_status_idx"  ON "payment_refunds" ("status");
CREATE INDEX IF NOT EXISTS "payment_refunds_payment_idx" ON "payment_refunds" ("payment_id");
