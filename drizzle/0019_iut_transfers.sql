-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0019 — iut_transfers
--
-- Inter-Unit Transfers between branch accounts / ICAI HO / WIRC. Distinct
-- from `payments` (customer-facing Razorpay flow) and `bills` (vendor
-- outflows). Most common use cases: monthly CABF remittance to HO,
-- inter-committee budget reallocations.
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "iut_transfers" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "amount_paise"      integer NOT NULL,
  "transfer_date"     date NOT NULL,
  "from_account"      text NOT NULL,
  "to_account"        text NOT NULL,
  "purpose"           text NOT NULL,
  "reference_number"  text,
  "document_file_id"  uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "status"            text NOT NULL DEFAULT 'requested',
  "requested_by"      uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "requested_at"      timestamptz NOT NULL DEFAULT now(),
  "approved_by"       uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "approved_at"       timestamptz,
  "executed_at"       timestamptz,
  "rejection_reason"  text,
  "notes"             text,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT iut_transfers_status_chk
    CHECK (status IN ('requested','approved','rejected','executed')),
  CONSTRAINT iut_transfers_amount_chk
    CHECK (amount_paise > 0),
  CONSTRAINT iut_transfers_accounts_distinct
    CHECK (from_account <> to_account)
);

CREATE INDEX IF NOT EXISTS "iut_transfers_status_idx" ON "iut_transfers" ("status");
CREATE INDEX IF NOT EXISTS "iut_transfers_date_idx"   ON "iut_transfers" ("transfer_date");
