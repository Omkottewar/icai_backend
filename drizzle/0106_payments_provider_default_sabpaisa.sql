-- Migration 0106 — SabPaisa is now the only payment gateway.
-- New payment rows default to provider 'sabpaisa'. Historical rows and
-- their reference columns are left untouched.
ALTER TABLE "payments" ALTER COLUMN "provider" SET DEFAULT 'sabpaisa';
