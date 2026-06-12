import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { events } from "./events";
import { firms } from "./firms";
import { files } from "./files";

// ─── Articleship Matches ──────────────────────────────────────────────────────
//
// Post-seminar form responses for articleship matchmaking. The flow agreed
// with the client (Section N.9 of the requirements):
//   1. Student attends a WICASA articleship seminar
//   2. Fills the matchmaking form linked to that seminar event
//   3. System computes recommended firms based on preferences
//   4. WICASA chairman reviews + sends recommendations
//   5. Student lands at one of the recommended firms
//
// `recommended_firm_ids` is a Postgres uuid[] populated by the recommendation
// engine. WICASA can edit it before sending. `placed_firm_id` is set once
// the student confirms placement.

export const articleshipMatches = pgTable(
  "articleship_matches",
  {
    id:                          uuid("id").primaryKey().defaultRandom(),
    student_user_id:             uuid("student_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    seminar_event_id:            uuid("seminar_event_id").references(() => events.id, { onDelete: "set null" }),
    preferred_specialisations:   text("preferred_specialisations").array(),
    preferred_location:          text("preferred_location"),
    preferred_firm_size:         text("preferred_firm_size"),
    // sole_practitioner | small | medium | large | big4
    expected_stipend_paise:      integer("expected_stipend_paise"),
    cv_file_id:                  uuid("cv_file_id").references(() => files.id, { onDelete: "set null" }),
    status:                      text("status").notNull().default("submitted"),
    // submitted | matched | placed | cancelled
    recommended_firm_ids:        uuid("recommended_firm_ids").array(),
    placed_firm_id:              uuid("placed_firm_id").references(() => firms.id, { onDelete: "set null" }),
    notes:                       text("notes"),
    created_at:                  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:                  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // WICASA inbox: submitted submissions awaiting review
    index("articleship_matches_status_idx").on(t.status),
    // Lookups for "all submissions from this seminar"
    index("articleship_matches_event_idx").on(t.seminar_event_id),
  ],
);
