import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./identity";

// ─── Counselling Requests ─────────────────────────────────────────────────
//
// Public-facing "book a counselling session" intake, mirrors the pattern in
// mentorship_requests: the `consultations` table has a strict counselor_id
// + slot_start + EXCLUDE constraint that a "hey I want to talk" request
// can't populate yet. This table captures the request; an admin later
// creates the actual consultation row when they schedule.
//
// Lifecycle:
//   pending    → student / member has submitted
//   scheduled  → admin picked a counselor + slot; a consultations row exists
//                (linked via consultation_id)
//   completed  → the linked consultation session ran
//   cancelled  → either party dropped out before scheduling

export const counsellingRequests = pgTable(
  "counselling_requests",
  {
    id:                uuid("id").primaryKey().defaultRandom(),
    client_user_id:    uuid("client_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    // 'career_counseling' | 'women_counseling' | 'mentorship' — matches
    // consultation_kind enum values so admin can drop straight into a
    // consultations row when scheduling.
    kind:              text("kind").notNull().default("career_counseling"),
    topic:             text("topic").notNull(),
    preferred_window:  text("preferred_window"),
    preferred_medium:  text("preferred_medium"),  // 'video' | 'call' | 'in_person'
    contact_phone:     text("contact_phone"),
    status:            text("status").notNull().default("pending"),
    notes:             text("notes"),
    // Once admin schedules a slot, this links back to the consultations row.
    consultation_id:   uuid("consultation_id"),
    scheduled_at:      timestamp("scheduled_at", { withTimezone: true }),
    completed_at:      timestamp("completed_at", { withTimezone: true }),
    created_at:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("counselling_requests_status_idx").on(t.status),
    index("counselling_requests_client_idx").on(t.client_user_id),
  ],
);
