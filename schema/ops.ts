import {
  pgTable, uuid, text, timestamp,
} from "drizzle-orm/pg-core";
import { roomBookingStatusEnum } from "./enums";
import { users } from "./identity";
import { payments } from "./payments";
import { rooms } from "./rooms";

// `approvals` was dropped in migration 0015 — the generic two-stage approval
// scaffolding never had any queries against it and is superseded by the
// checklist_instances flow. If a generic approval queue comes back, design
// it fresh against the new requirements.

// ─── Room Bookings ────────────────────────────────────────────────────────────
// EXCLUDE gist(room_id, tstzrange(slot_start, slot_end)) prevents double-booking
// CHECK (slot_end > slot_start) prevents zero/negative durations

export const roomBookings = pgTable("room_bookings", {
  id:         uuid("id").primaryKey().defaultRandom(),
  room_id:    uuid("room_id").notNull().references(() => rooms.id, { onDelete: "restrict" }),
  user_id:    uuid("user_id").notNull().references(() => users.id),
  slot_start: timestamp("slot_start", { withTimezone: true }).notNull(),
  slot_end:   timestamp("slot_end", { withTimezone: true }).notNull(),
  purpose:    text("purpose"),
  status:     roomBookingStatusEnum("status").notNull().default("requested"),
  payment_id: uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
