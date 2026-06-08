import { pgTable, uuid, text, boolean, integer, timestamp } from "drizzle-orm/pg-core";

// ─── Rooms ───────────────────────────────────────────────────────────────
// Bookable spaces (seminar halls, reading room, library). Referenced by
// room_bookings.room_id. The hall-booking workflow is not yet built — this
// table exists for forward compatibility.

export const rooms = pgTable("rooms", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  name:                text("name").notNull(),
  location:            text("location"),
  capacity:            integer("capacity"),
  fee_paise_per_hour:  integer("fee_paise_per_hour").notNull().default(0),
  active:              boolean("active").notNull().default(true),
  created_at:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
