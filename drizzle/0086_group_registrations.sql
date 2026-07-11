-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0086 — Group event bookings
--
-- A user can now book seats for other users on the same payment: they
-- pick 2-3 people from the portal directory in the register modal, the
-- payment amount is fee × (1 + N), and after admin approves the payment
-- every attendee gets their own event_registrations row.
--
-- Schema changes:
--   • Add `booked_by_user_id` to event_registrations. NULL for self-
--     registrations (the historical behaviour); set to the payer's
--     user_id for guest seats so their dashboard can show "Booked by X".
--   • The linkage to the shared payment already exists via `payment_id`
--     (added way back in migration 0002) — nothing to change there.
--   • Attendee list is stashed in payment.metadata on registration so
--     admin approve can recover it without another table.
--
-- Safe to re-run: uses ADD COLUMN IF NOT EXISTS.
-- ════════════════════════════════════════════════════════════════════════════

ALTER TABLE "event_registrations"
  ADD COLUMN IF NOT EXISTS "booked_by_user_id" uuid REFERENCES "users" ("id") ON DELETE SET NULL;

-- Index the FK so the dashboard's "who booked my seat" join stays fast
-- even if a single power user books hundreds of seats over time.
CREATE INDEX IF NOT EXISTS "idx_event_registrations_booked_by"
  ON "event_registrations" ("booked_by_user_id")
  WHERE "booked_by_user_id" IS NOT NULL;
