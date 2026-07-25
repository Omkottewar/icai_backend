import {
  pgTable, uuid, text, boolean, integer, timestamp, jsonb,
  index, uniqueIndex, primaryKey, check,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./identity";
import { files } from "./files";
import { jobPostings } from "./firms";
import { postingTypeEnum, applicationStatusEnum } from "./enums";

// ─── Job Categories ─────────────────────────────────────────────────────────
// A branch-editable taxonomy for the jobs board. Subscribers pick one or
// more categories to be alerted about; each posting picks one category.
// Mirrors the studentSuggestionTopics shape so the admin CRUD looks and
// behaves identically to /admin/student-suggestion-topics.

export const jobCategories = pgTable(
  "job_categories",
  {
    id:          uuid("id").primaryKey().defaultRandom(),
    code:        text("code").notNull(),        // machine key — used in seed / URLs
    name:        text("name").notNull(),        // display name
    description: text("description"),
    active:      boolean("active").notNull().default(true),
    sort_order:  integer("sort_order").notNull().default(0),
    created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("job_categories_code_uq").on(t.code),
    index("job_categories_active_idx").on(t.active, t.sort_order),
  ],
);

// ─── Job Alert Subscriptions ────────────────────────────────────────────────
// One row per (user, category, posting_type) that the subscriber wants alerts
// for. Unsubscribing sets `unsubscribed_at` — the row is retained so
// re-subscribing preserves history and admin can audit past preferences.
//
// Confirmation flow (double opt-in):
//   1. subscribe → row inserted with confirmed_at NULL
//   2. confirmation email sent with signed token
//   3. user clicks → confirmed_at stamped
//   4. subsequent subscriptions by the same email skip step 2/3
//
// filter_location / filter_experience are optional case-insensitive
// substring filters applied at dispatch time so a subscriber can, e.g.,
// only see Nagpur-based openings for freshers.

export const jobAlertSubscriptions = pgTable(
  "job_alert_subscriptions",
  {
    id:                 uuid("id").primaryKey().defaultRandom(),
    user_id:            uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    category_id:        uuid("category_id").notNull().references(() => jobCategories.id, { onDelete: "cascade" }),
    posting_type:       postingTypeEnum("posting_type").notNull(),
    // instant | daily_digest | weekly_digest
    frequency:          text("frequency").notNull().default("instant"),
    filter_location:    text("filter_location"),
    filter_experience:  text("filter_experience"),
    confirmed_at:       timestamp("confirmed_at",   { withTimezone: true }),
    unsubscribed_at:    timestamp("unsubscribed_at", { withTimezone: true }),
    last_notified_at:   timestamp("last_notified_at", { withTimezone: true }),
    created_at:         timestamp("created_at",     { withTimezone: true }).notNull().defaultNow(),
    updated_at:         timestamp("updated_at",     { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("job_alert_subs_user_cat_type_uq").on(t.user_id, t.category_id, t.posting_type),
    index("job_alert_subs_category_idx").on(t.category_id, t.posting_type),
    check(
      "job_alert_subs_frequency_ck",
      sql`${t.frequency} IN ('instant', 'daily_digest', 'weekly_digest')`,
    ),
  ],
);

// ─── Job Applications ───────────────────────────────────────────────────────
// One row per (user, posting). The applicant's resume is snapshotted at
// apply time so later profile edits don't retroactively change what the
// employer saw. `applicant_snapshot` captures name/email/phone at apply
// time for the same reason.

export const jobApplications = pgTable(
  "job_applications",
  {
    id:                 uuid("id").primaryKey().defaultRandom(),
    posting_id:         uuid("posting_id").notNull().references(() => jobPostings.id, { onDelete: "cascade" }),
    user_id:            uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    resume_file_id:     uuid("resume_file_id").references(() => files.id, { onDelete: "set null" }),
    cover_message:      text("cover_message"),
    applicant_snapshot: jsonb("applicant_snapshot").notNull().default({}),
    status:             applicationStatusEnum("status").notNull().default("applied"),
    status_note:        text("status_note"),
    reviewed_by:        uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewed_at:        timestamp("reviewed_at", { withTimezone: true }),
    created_at:         timestamp("created_at",  { withTimezone: true }).notNull().defaultNow(),
    updated_at:         timestamp("updated_at",  { withTimezone: true }).notNull().defaultNow(),
    withdrawn_at:       timestamp("withdrawn_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("job_applications_posting_user_uq").on(t.posting_id, t.user_id),
    index("job_applications_posting_idx").on(t.posting_id, t.status),
    index("job_applications_user_idx").on(t.user_id, t.created_at),
  ],
);

// ─── Saved Jobs ─────────────────────────────────────────────────────────────
// One row per (user, posting) bookmark. Composite PK so toggling is idempotent
// and the "am I saved?" check is a PK lookup.

export const savedJobs = pgTable(
  "saved_jobs",
  {
    user_id:    uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    posting_id: uuid("posting_id").notNull().references(() => jobPostings.id, { onDelete: "cascade" }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.posting_id] }),
    index("saved_jobs_user_idx").on(t.user_id, t.created_at),
  ],
);
