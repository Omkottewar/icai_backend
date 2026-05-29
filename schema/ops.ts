import {
  pgTable, uuid, text, timestamp,
} from "drizzle-orm/pg-core";
import {
  approvalTargetEnum, approvalStageEnum, approvalStatusEnum,
  roomBookingStatusEnum,
} from "./enums";
import { users } from "./identity";
import { payments } from "./payments";

// ─── Approvals ────────────────────────────────────────────────────────────────
// stage is now an enum (mcm | chairman), not free-text — Fix #11
// UNIQUE(target_type, target_id, stage) enforced in migration SQL
// App MUST verify 'mcm' approved before inserting 'chairman' row

export const approvals = pgTable("approvals", {
  id:           uuid("id").primaryKey().defaultRandom(),
  target_type:  approvalTargetEnum("target_type").notNull(),
  target_id:    uuid("target_id").notNull(),   // polymorphic FK
  stage:        approvalStageEnum("stage").notNull(),
  status:       approvalStatusEnum("status").notNull().default("pending"),
  submitted_by: uuid("submitted_by").references(() => users.id),
  reviewed_by:  uuid("reviewed_by").references(() => users.id),
  comments:     text("comments"),
  created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  decided_at:   timestamp("decided_at", { withTimezone: true }),
});

// ─── Room Bookings ────────────────────────────────────────────────────────────
// EXCLUDE gist(room_id, tstzrange(slot_start, slot_end)) prevents double-booking
// CHECK (slot_end > slot_start) prevents zero/negative durations

export const roomBookings = pgTable("room_bookings", {
  id:         uuid("id").primaryKey().defaultRandom(),
  room_id:    uuid("room_id").notNull(),   // FK → rooms.id
  user_id:    uuid("user_id").notNull().references(() => users.id),
  slot_start: timestamp("slot_start", { withTimezone: true }).notNull(),
  slot_end:   timestamp("slot_end", { withTimezone: true }).notNull(),
  purpose:    text("purpose"),
  status:     roomBookingStatusEnum("status").notNull().default("requested"),
  payment_id: uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),  // Fix #2
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
