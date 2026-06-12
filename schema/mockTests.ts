import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { studentLevelEnum } from "./enums";
import { users } from "./identity";
import { branches } from "./identity";

// ─── Mock Tests ───────────────────────────────────────────────────────────────
//
// WICASA-owned mock-test schedule + per-student registrations. Deliberately
// separate from the `events` table — mock tests have a different metadata
// shape (paper number, group, level) and a different audience contract
// (students only, by level/group).
//
// Series names are free text ("May 2026 Final mock series") so WICASA can
// organise tests however they like without us imposing a taxonomy.

export const mockTests = pgTable(
  "mock_tests",
  {
    id:             uuid("id").primaryKey().defaultRandom(),
    branch_id:      uuid("branch_id").references(() => branches.id, { onDelete: "cascade" }),
    title:          text("title").notNull(),
    series_name:    text("series_name"),
    level:          studentLevelEnum("level").notNull(),
    group_no:       integer("group_no"),   // 1 or 2 — null for foundation
    paper_no:       integer("paper_no"),   // 1..8 per level — null for combined-paper tests
    scheduled_at:   timestamp("scheduled_at", { withTimezone: true }).notNull(),
    duration_mins:  integer("duration_mins").notNull().default(180),
    venue:          text("venue"),
    capacity:       integer("capacity"),
    fee_paise:      integer("fee_paise").notNull().default(0),
    status:         text("status").notNull().default("scheduled"),
    // scheduled | open_for_registration | closed | completed | cancelled
    created_by:     uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    created_at:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deleted_at:     timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // Public listing — upcoming tests, sorted by date
    index("mock_tests_scheduled_idx").on(t.scheduled_at),
    // WICASA-side filter by status (open for registration)
    index("mock_tests_status_idx").on(t.status),
  ],
);

export const mockTestRegistrations = pgTable(
  "mock_test_registrations",
  {
    id:             uuid("id").primaryKey().defaultRandom(),
    mock_test_id:   uuid("mock_test_id").notNull().references(() => mockTests.id, { onDelete: "cascade" }),
    user_id:        uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    status:         text("status").notNull().default("registered"),
    // registered | attended | absent | cancelled
    score:          integer("score"),  // percentage when WICASA records marks
    registered_at:  timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
    attended_at:    timestamp("attended_at", { withTimezone: true }),
  },
  (t) => [
    index("mock_test_regs_test_idx").on(t.mock_test_id),
    index("mock_test_regs_user_idx").on(t.user_id),
  ],
);
