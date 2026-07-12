import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity";

// ─── Reading Rooms catalogue (migration 0091) ──────────────────────────────
// Admin-managed list of bookable study rooms. Each row has its own
// capacity — the "one booking per student per month" rule still applies
// across rooms (a student picks one room per month), but each room's
// capacity is checked independently.
export const readingRooms = pgTable(
  "reading_rooms",
  {
    id:          uuid("id").primaryKey().defaultRandom(),
    name:        text("name").notNull(),
    description: text("description"),
    location:    text("location"),
    capacity:    integer("capacity").notNull().default(40),
    active:      boolean("active").notNull().default(true),
    sort_order:  integer("sort_order").notNull().default(0),
    created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("reading_rooms_active_idx").on(t.active, t.sort_order),
  ],
);

// ─── Reading Room monthly-pass booking (migration 0090) ────────────────────
//
// The reading room seats 40 students. Access model:
//   1. Student pays a one-time refundable ₹500 deposit → deposit row is
//      created with status 'pending_verification'. Admin verifies against
//      the UPI statement and flips status to 'verified'.
//   2. Once verified, the student can book one calendar month at a time.
//      The booking window for month M+1 opens on the 25th of month M.
//   3. Cancelling a booking frees the seat immediately (partial unique
//      index excludes cancelled rows so the same student can re-book if
//      capacity re-opens).
//   4. Capacity + deposit amount live in site_settings so admin can bump
//      them without a redeploy.

export const readingRoomDeposits = pgTable(
  "reading_room_deposits",
  {
    id:               uuid("id").primaryKey().defaultRandom(),
    // UNIQUE user_id → at most one deposit row per student. When a student
    // is refunded, the row stays (status='refunded') as an audit trail; to
    // let the student re-enrol, admin deletes the row explicitly.
    user_id:          uuid("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
    amount_paise:     integer("amount_paise").notNull().default(50000),
    utr:              text("utr"),
    // 'pending_verification' | 'verified' | 'rejected' | 'refunded'
    status:           text("status").notNull().default("pending_verification"),
    submitted_at:     timestamp("submitted_at", { withTimezone: true }),
    verified_by:      uuid("verified_by").references(() => users.id, { onDelete: "set null" }),
    verified_at:      timestamp("verified_at", { withTimezone: true }),
    rejection_reason: text("rejection_reason"),
    refunded_at:      timestamp("refunded_at", { withTimezone: true }),
    refund_note:      text("refund_note"),
    created_at:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("reading_room_deposits_status_idx").on(t.status, t.created_at),
  ],
);

export const readingRoomBookings = pgTable(
  "reading_room_bookings",
  {
    id:           uuid("id").primaryKey().defaultRandom(),
    user_id:      uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    room_id:      uuid("room_id").notNull().references(() => readingRooms.id, { onDelete: "restrict" }),
    year:         integer("year").notNull(),
    month:        integer("month").notNull(),  // 1-12 (CHECK constraint in migration)
    cancelled_at: timestamp("cancelled_at", { withTimezone: true }),
    created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial unique — cancelled rows don't block re-booking. "One
    // booking per user per month" is enforced across rooms so a student
    // can't hold seats in two rooms in the same month.
    uniqueIndex("reading_room_bookings_active_uq")
      .on(t.user_id, t.year, t.month)
      .where(sql`cancelled_at IS NULL`),
    index("reading_room_bookings_month_idx")
      .on(t.year, t.month)
      .where(sql`cancelled_at IS NULL`),
    index("reading_room_bookings_room_month_idx")
      .on(t.room_id, t.year, t.month)
      .where(sql`cancelled_at IS NULL`),
  ],
);
