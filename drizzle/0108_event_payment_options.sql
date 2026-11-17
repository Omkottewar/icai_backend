-- Migration 0108 — per-event "pay at venue" switch. The server also creates
-- this table on first use, so running this by hand is optional.
CREATE TABLE IF NOT EXISTS "event_payment_options" (
  "event_id" uuid PRIMARY KEY REFERENCES "events"("id") ON DELETE CASCADE,
  "pay_at_venue" boolean NOT NULL DEFAULT false,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
