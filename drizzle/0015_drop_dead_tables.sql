-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0015 — Drop unused tables and their enums
--
-- These four tables were scaffolding for unbuilt features. Each was confirmed
-- to have zero rows and zero query references in the codebase:
--   • invoices          — GST invoices never generated
--   • payment_refunds   — Razorpay refunds; webhook handler doesn't write here
--   • payment_disputes  — Razorpay chargebacks; same
--   • approvals         — generic two-stage approval; superseded by
--                         checklist_instances
--
-- Their enums become unused after the drops:
--   • refund_status
--   • dispute_status
--   • approval_stage
--   • approval_status
--   • approval_target
--
-- If any of these features come back, re-introduce them with a fresh schema
-- — the v0 design wasn't worth keeping.
--
-- Idempotent — safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

DROP TABLE IF EXISTS "invoices"          CASCADE;
DROP TABLE IF EXISTS "payment_refunds"   CASCADE;
DROP TABLE IF EXISTS "payment_disputes"  CASCADE;
DROP TABLE IF EXISTS "approvals"         CASCADE;

DROP TYPE IF EXISTS "refund_status";
DROP TYPE IF EXISTS "dispute_status";
DROP TYPE IF EXISTS "approval_stage";
DROP TYPE IF EXISTS "approval_status";
DROP TYPE IF EXISTS "approval_target";
