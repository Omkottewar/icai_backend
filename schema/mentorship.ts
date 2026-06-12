import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./identity";

// ─── Mentorship Requests ──────────────────────────────────────────────────────
//
// Student-initiated mentorship requests; matched by WICASA to a willing
// mentor (typically a senior practising CA). Distinct from the `consultations`
// table — those are paid 1-on-1 career-counseling slots with their own
// payment/medium contract. Mentorship is free, student-initiated, ongoing.
//
// Lifecycle:
//   pending  → student has submitted, WICASA hasn't picked a mentor
//   matched  → WICASA assigned a mentor; awaiting first session
//   scheduled → first session date confirmed by both parties
//   completed → mentor or WICASA marks the engagement closed
//   cancelled → either party drops out

export const mentorshipRequests = pgTable(
  "mentorship_requests",
  {
    id:                uuid("id").primaryKey().defaultRandom(),
    student_user_id:   uuid("student_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    mentor_user_id:    uuid("mentor_user_id").references(() => users.id, { onDelete: "set null" }),
    topic:             text("topic").notNull(),
    preferred_window:  text("preferred_window"),
    status:            text("status").notNull().default("pending"),
    // pending | matched | scheduled | completed | cancelled
    notes:             text("notes"),
    matched_at:        timestamp("matched_at", { withTimezone: true }),
    scheduled_at:      timestamp("scheduled_at", { withTimezone: true }),
    completed_at:      timestamp("completed_at", { withTimezone: true }),
    created_at:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // WICASA inbox: pending requests awaiting mentor assignment
    index("mentorship_status_idx").on(t.status),
    // "My mentees" view for mentors
    index("mentorship_mentor_idx").on(t.mentor_user_id),
    index("mentorship_student_idx").on(t.student_user_id),
  ],
);
