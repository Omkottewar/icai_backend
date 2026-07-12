-- Migration 0091 — Multi-room support for the reading-room monthly pass.
--
-- Original design (0090) assumed a single 40-seat reading room whose
-- capacity lived in site_settings. Admin now wants to run multiple rooms
-- (Main hall, Silent zone, Late-hours room, etc.) each with its own
-- capacity. Students pick the room they want when they book their
-- monthly seat — the deposit still unlocks booking across all rooms.
--
-- Model:
--   • `reading_rooms` — admin-managed catalogue (name, capacity, active)
--   • `reading_room_bookings.room_id` — which room the seat is in
--   • The "one booking per student per month" rule stays as-is — the
--     partial unique index on (user_id, year, month) still enforces it
--     regardless of room.

-- ─── Rooms catalogue ──────────────────────────────────────────────────────
CREATE TABLE reading_rooms (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  description text,
  location    text,
  capacity    integer NOT NULL DEFAULT 40 CHECK (capacity > 0),
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX reading_rooms_active_idx ON reading_rooms (active, sort_order);

-- Seed a default room using the existing site_settings capacity so the
-- module keeps working while admin fleshes out the real room list.
INSERT INTO reading_rooms (name, description, location, capacity, sort_order)
SELECT
  'Main Reading Room',
  'Primary study hall — silence enforced, air-conditioned.',
  'ICAI Bhawan, Dhantoli · Ground floor',
  COALESCE(NULLIF(ss.value, '')::int, 40),
  1
FROM (SELECT value FROM site_settings WHERE key = 'reading_room_capacity' UNION ALL SELECT '40' LIMIT 1) ss;

-- ─── room_id on bookings ─────────────────────────────────────────────────
-- Nullable during the backfill, then flipped to NOT NULL. Any existing
-- bookings (from 0090's launch) get pointed at the seeded default room.
ALTER TABLE reading_room_bookings
  ADD COLUMN room_id uuid REFERENCES reading_rooms(id) ON DELETE RESTRICT;

UPDATE reading_room_bookings
SET room_id = (SELECT id FROM reading_rooms ORDER BY sort_order, created_at LIMIT 1)
WHERE room_id IS NULL;

ALTER TABLE reading_room_bookings ALTER COLUMN room_id SET NOT NULL;

-- Per-room monthly index — used for capacity checks.
CREATE INDEX reading_room_bookings_room_month_idx
  ON reading_room_bookings (room_id, year, month)
  WHERE cancelled_at IS NULL;
