import { pgTable, uuid, text, integer, numeric, boolean, timestamp, index, unique } from "drizzle-orm/pg-core";
import { studentLevelEnum } from "./enums";
import { users } from "./identity";
import { branches } from "./identity";
import { files } from "./files";

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
    // ── Hybrid-engine columns (migration 0040) ──────────────────────────
    // The branch runs the actual test on paper at the venue, but the
    // portal handles registration, practice-paper distribution, and
    // result entry/release.
    description:           text("description"),
    practice_paper_file_id: uuid("practice_paper_file_id").references(() => files.id, { onDelete: "set null" }),
    answer_key_file_id:    uuid("answer_key_file_id").references(() => files.id, { onDelete: "set null" }),
    max_score:             integer("max_score").notNull().default(100),
    // null until WICASA explicitly publishes; students only see their
    // score after this timestamp is set.
    result_published_at:   timestamp("result_published_at", { withTimezone: true }),
    registration_close_at: timestamp("registration_close_at", { withTimezone: true }),
    // ── Online-attempt opt-in (migration 0047) ─────────────────────────
    // When true, the test exposes question paper + timed attempt UI to
    // registered students. False (default) preserves the existing
    // paper-at-venue model: only registration + materials + marks entry
    // flow through the portal.
    supports_online: boolean("supports_online").notNull().default(false),
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

// ─── Mock Test Engine (migration 0047) ─────────────────────────────────────
//
// Question bank + attempts. Turns mock_tests into a real test platform with
// online attempts and auto-graded MCQ / numerical questions. Subjective
// (short / long) answers are auto-grade-skipped and admins fill marks
// through the per-answer review surface.

export const mockTestQuestions = pgTable(
  "mock_test_questions",
  {
    id:                  uuid("id").primaryKey().defaultRandom(),
    mock_test_id:        uuid("mock_test_id").notNull().references(() => mockTests.id, { onDelete: "cascade" }),
    question_no:         integer("question_no").notNull(),
    question_type:       text("question_type").notNull(),
    // 'mcq' | 'numerical' | 'short' | 'long'
    body:                text("body").notNull(),                                // markdown
    marks:               integer("marks").notNull().default(1),
    negative_marks:      numeric("negative_marks", { precision: 4, scale: 2 }).notNull().default("0"),
    topic_tag:           text("topic_tag"),
    difficulty:          text("difficulty"),
    // For 'numerical' question type
    numerical_answer:    numeric("numerical_answer"),
    numerical_tolerance: numeric("numerical_tolerance").notNull().default("0"),
    explanation:         text("explanation"),                                   // shown in review mode
    created_at:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deleted_at:          timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("mock_test_questions_test_idx").on(t.mock_test_id, t.question_no),
  ],
);

export const mockTestOptions = pgTable(
  "mock_test_options",
  {
    id:          uuid("id").primaryKey().defaultRandom(),
    question_id: uuid("question_id").notNull().references(() => mockTestQuestions.id, { onDelete: "cascade" }),
    option_label: text("option_label").notNull(),   // 'A' | 'B' | 'C' | 'D'
    body:         text("body").notNull(),
    is_correct:   boolean("is_correct").notNull().default(false),
    sort_order:   integer("sort_order").notNull().default(0),
  },
  (t) => [
    index("mock_test_options_question_idx").on(t.question_id, t.sort_order),
  ],
);

export const mockTestAttempts = pgTable(
  "mock_test_attempts",
  {
    id:              uuid("id").primaryKey().defaultRandom(),
    mock_test_id:    uuid("mock_test_id").notNull().references(() => mockTests.id, { onDelete: "cascade" }),
    user_id:         uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    registration_id: uuid("registration_id").references(() => mockTestRegistrations.id, { onDelete: "set null" }),
    attempt_token:   text("attempt_token").notNull().unique(),
    started_at:      timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    expires_at:      timestamp("expires_at", { withTimezone: true }).notNull(),
    submitted_at:    timestamp("submitted_at", { withTimezone: true }),
    status:          text("status").notNull().default("in_progress"),
    // in_progress | submitted | auto_submitted | abandoned
    score_auto:      numeric("score_auto"),
    score_manual:    numeric("score_manual"),
    score_total:     numeric("score_total"),
    graded_at:       timestamp("graded_at", { withTimezone: true }),
    graded_by:       uuid("graded_by").references(() => users.id, { onDelete: "set null" }),
    tab_blur_count:  integer("tab_blur_count").notNull().default(0),
    created_at:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("mock_test_attempts_user_idx").on(t.user_id, t.created_at),
    index("mock_test_attempts_test_idx").on(t.mock_test_id, t.status),
  ],
);

export const mockTestAnswers = pgTable(
  "mock_test_answers",
  {
    id:                  uuid("id").primaryKey().defaultRandom(),
    attempt_id:          uuid("attempt_id").notNull().references(() => mockTestAttempts.id, { onDelete: "cascade" }),
    question_id:         uuid("question_id").notNull().references(() => mockTestQuestions.id, { onDelete: "cascade" }),
    // Array even for single-select MCQ so multi-select questions work
    // through the same column.
    selected_option_ids: uuid("selected_option_ids").array(),
    numerical_value:     numeric("numerical_value"),
    text_answer:         text("text_answer"),
    marks_awarded:       numeric("marks_awarded"),
    time_spent_ms:       integer("time_spent_ms").notNull().default(0),
    marked_for_review:   boolean("marked_for_review").notNull().default(false),
    updated_at:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("mock_test_answers_unique").on(t.attempt_id, t.question_id),
    index("mock_test_answers_attempt_idx").on(t.attempt_id),
  ],
);
