-- Migration 0109 — non-member registration options per event.
-- The server also adds these columns on first use, so running this by hand
-- is optional.
ALTER TABLE "event_payment_options" ADD COLUMN IF NOT EXISTS "allow_non_members" boolean NOT NULL DEFAULT false;
ALTER TABLE "event_payment_options" ADD COLUMN IF NOT EXISTS "non_member_fee_paise" integer;
