-- Migration 0090 — Reading Room monthly-pass booking.
--
-- Replaces the never-shipped slot-based `room_bookings` model (for the
-- reading room specifically) with a monthly-pass model per the branch's
-- 2026 policy:
--   • one-time ₹500 refundable deposit per student → unlocks booking
--   • student books one calendar month at a time — no time slots
--   • booking window for month M+1 opens on the 25th of month M
--   • hard capacity ceiling (default 40 seats), admin-configurable
--
-- The existing `rooms` + `room_bookings` tables are left in place — they
-- may still be used for seminar-hall bookings in future. Reading Room
-- monthly passes get their own tables so the flows don't fight over the
-- same schema.

-- ─── Deposits ──────────────────────────────────────────────────────────────
-- One row per student. The unique(user_id) forces at most one deposit per
-- student — a refund flips status to 'refunded' but the row stays as an
-- audit trail; the student can re-pay to get a new row only after admin
-- clears the old one (via DELETE, done from the admin refund action).
CREATE TABLE reading_room_deposits (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  amount_paise  integer NOT NULL DEFAULT 50000,
  utr           text,
  status        text NOT NULL DEFAULT 'pending_verification',
                  -- 'pending_verification' | 'verified' | 'rejected' | 'refunded'
  submitted_at  timestamptz,
  verified_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at   timestamptz,
  rejection_reason text,
  refunded_at   timestamptz,
  refund_note   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reading_room_deposits_status_idx
  ON reading_room_deposits (status, created_at DESC);

-- ─── Bookings ──────────────────────────────────────────────────────────────
-- One row per student per month. Cancelled bookings free the seat and don't
-- count against capacity — the partial unique index excludes them so a
-- student who cancels can re-book if space opens up.
CREATE TABLE reading_room_bookings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  year          integer NOT NULL,
  month         integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  cancelled_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX reading_room_bookings_active_uq
  ON reading_room_bookings (user_id, year, month)
  WHERE cancelled_at IS NULL;

CREATE INDEX reading_room_bookings_month_idx
  ON reading_room_bookings (year, month) WHERE cancelled_at IS NULL;

-- ─── Config ────────────────────────────────────────────────────────────────
-- Capacity + deposit amount live in site_settings so the branch can bump
-- them without a redeploy. reading_room_open flag lets admin freeze
-- bookings temporarily (e.g. during renovation) — server checks it too.
INSERT INTO site_settings (key, value) VALUES
  ('reading_room_capacity',      '40'),
  ('reading_room_deposit_paise', '50000'),
  ('reading_room_open',          '1')
ON CONFLICT (key) DO NOTHING;
