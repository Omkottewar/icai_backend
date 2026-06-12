-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0018 — bills
--
-- Post-event bills and standalone branch operational bills. Workflow-oriented
-- replacement for the abandoned `invoices` table (dropped in migration 0015).
-- Idempotent: safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "bills" (
  "id"                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "event_id"          uuid REFERENCES "events"("id") ON DELETE SET NULL,
  "committee_id"      uuid REFERENCES "committees"("id") ON DELETE SET NULL,
  "vendor_name"       text NOT NULL,
  "description"       text,
  "amount_paise"      integer NOT NULL,
  "bill_date"         date NOT NULL,
  "bill_number"       text,
  "budget_paise"      integer,
  "document_file_id"  uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "status"            text NOT NULL DEFAULT 'draft',
  "submitted_by"      uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "submitted_at"      timestamptz,
  "approved_by"       uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "approved_at"       timestamptz,
  "paid_at"           timestamptz,
  "rejection_reason"  text,
  "notes"             text,
  "created_at"        timestamptz NOT NULL DEFAULT now(),
  "updated_at"        timestamptz NOT NULL DEFAULT now(),
  "deleted_at"        timestamptz,
  CONSTRAINT bills_status_chk
    CHECK (status IN ('draft','submitted','approved','rejected','paid')),
  CONSTRAINT bills_amount_chk
    CHECK (amount_paise >= 0)
);

CREATE INDEX IF NOT EXISTS "bills_status_idx"        ON "bills" ("status");
CREATE INDEX IF NOT EXISTS "bills_event_idx"         ON "bills" ("event_id");
CREATE INDEX IF NOT EXISTS "bills_submitted_by_idx"  ON "bills" ("submitted_by");
