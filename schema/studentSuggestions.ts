import {
  pgTable, uuid, text, boolean, integer, timestamp, primaryKey, index, check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users, branches } from "./identity";

// ─── Student Suggestions ────────────────────────────────────────────────────
//
// Topic-bucketed, upvote-only suggestions feed driven by signed-in
// students/members. The home page WICASA card surfaces the top-N
// approved entries; a full page at /student-suggestions lets users
// browse all approved suggestions and submit their own.
//
// Moderation flow:
//   submit       → status='pending'
//   admin reads  /admin/student-suggestions
//   approve      → status='approved' (becomes publicly visible)
//   reject       → status='rejected' (only visible to the author)
//
// Votes use a composite PK (suggestion_id, user_id) so a user can vote
// at most once per suggestion. Re-tapping the upvote toggles the row
// off. Net vote count is just COUNT(votes) for a given suggestion.

export const studentSuggestionTopics = pgTable(
  "student_suggestion_topics",
  {
    id:           uuid("id").primaryKey().defaultRandom(),
    branch_id:    uuid("branch_id").references(() => branches.id, { onDelete: "cascade" }),
    code:         text("code").notNull(),
    name:         text("name").notNull(),
    description:  text("description"),
    active:       boolean("active").notNull().default(true),
    sort_order:   integer("sort_order").notNull().default(0),
    created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("student_suggestion_topics_branch_idx").on(t.branch_id),
  ],
);

export const studentSuggestions = pgTable(
  "student_suggestions",
  {
    id:             uuid("id").primaryKey().defaultRandom(),
    topic_id:       uuid("topic_id").references(() => studentSuggestionTopics.id, { onDelete: "set null" }),
    user_id:        uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    body:           text("body").notNull(),
    // pending | approved | rejected | archived
    status:         text("status").notNull().default("pending"),
    reject_reason:  text("reject_reason"),
    reviewed_by:    uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewed_at:    timestamp("reviewed_at", { withTimezone: true }),
    created_at:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deleted_at:     timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("student_suggestions_status_idx").on(t.status),
    index("student_suggestions_topic_idx").on(t.topic_id),
    index("student_suggestions_user_idx").on(t.user_id),
    check("student_suggestions_body_length_ck",
      sql`char_length(${t.body}) > 0 AND char_length(${t.body}) <= 280`),
    check("student_suggestions_status_ck",
      sql`${t.status} IN ('pending', 'approved', 'rejected', 'archived')`),
  ],
);

export const studentSuggestionVotes = pgTable(
  "student_suggestion_votes",
  {
    suggestion_id: uuid("suggestion_id").notNull().references(() => studentSuggestions.id, { onDelete: "cascade" }),
    user_id:       uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.suggestion_id, t.user_id] }),
    index("student_suggestion_votes_user_idx").on(t.user_id),
  ],
);
