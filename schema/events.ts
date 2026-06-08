import {
  pgTable, uuid, text, integer, numeric, timestamp, boolean,
} from "drizzle-orm/pg-core";
import {
  eventAudienceEnum, eventModeEnum, eventStatusEnum,
  registrationStatusEnum, cpeTypeEnum,
  eventChecklistStatusEnum, eventChecklistItemKindEnum, eventChecklistActionEnum,
} from "./enums";
import { users, branches } from "./identity";
import { payments } from "./payments";
import { committees } from "./committees";
import { files } from "./files";

// ─── Events ───────────────────────────────────────────────────────────────────

export const events = pgTable("events", {
  id:                   uuid("id").primaryKey().defaultRandom(),
  slug:                 text("slug").notNull().unique(),
  title:                text("title").notNull(),
  description:          text("description"),           // markdown
  committee_id:         uuid("committee_id").notNull().references(() => committees.id, { onDelete: "restrict" }),
  branch_id:            uuid("branch_id").references(() => branches.id),   // Fix #3 — jurisdiction
  audience:             eventAudienceEnum("audience").notNull().default("members"),
  mode:                 eventModeEnum("mode").notNull().default("in_person"),
  venue:                text("venue"),
  online_url:           text("online_url"),
  starts_at:            timestamp("starts_at", { withTimezone: true }).notNull(),
  ends_at:              timestamp("ends_at", { withTimezone: true }).notNull(),
  cpe_hours:            numeric("cpe_hours", { precision: 4, scale: 1 }).notNull().default("0"),
  fee_paise:            integer("fee_paise").notNull().default(0),
  capacity:             integer("capacity"),            // NULL = unlimited
  registered_count:     integer("registered_count").notNull().default(0),  // Fix #4 — atomic seat tracking
  status:               eventStatusEnum("status").notNull().default("draft"),
  banner_id:            uuid("banner_id").references(() => files.id, { onDelete: "set null" }),
  recurrence_parent_id: uuid("recurrence_parent_id"),  // self-ref FK → events.id
  recurrence_rrule:     text("recurrence_rrule"),       // RFC 5545
  highlights:           text("highlights").array(),
  program_type:         text("program_type"),
  created_by:           uuid("created_by").references(() => users.id),
  created_at:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:           timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at:           timestamp("deleted_at", { withTimezone: true }),
  // DB constraint added in migration: CHECK (capacity IS NULL OR registered_count <= capacity)
});

// ─── Event Registrations ──────────────────────────────────────────────────────

export const eventRegistrations = pgTable("event_registrations", {
  id:            uuid("id").primaryKey().defaultRandom(),
  event_id:      uuid("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  user_id:       uuid("user_id").notNull().references(() => users.id),
  status:        registrationStatusEnum("status").notNull().default("registered"),
  payment_id:    uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),  // Fix #2
  registered_at: timestamp("registered_at", { withTimezone: true }).notNull().defaultNow(),
  attended_at:   timestamp("attended_at", { withTimezone: true }),
  deleted_at:    timestamp("deleted_at", { withTimezone: true }),
});

// ─── Event Checklists (LEGACY — soft-deprecated 2026-06-04) ─────────────────
//
// The original event-approval pipeline. Replaced by the generic checklist
// engine in schema/checklists.ts; new event approvals create a row in
// `checklist_instances` instead. These tables stay live ONLY for in-flight
// rows started before the swap.
//
// SUNSET DATE: 2026-09-04 (3 months).
// At that point:
//   1. Run: SELECT COUNT(*) FROM event_checklists WHERE finalized_at IS NULL;
//      Confirm the count is 0 (every old checklist has been approved/rejected).
//   2. Drop routes/checklists.ts, hooks/useChecklist.js, the legacy badge on
//      DashboardPage, the legacy branch in EventsAdminPage.ChecklistButton,
//      the legacy filter in CommitteeChecklistsCard + ApprovalsQueueCard.
//   3. Drop the tables + their enums (event_checklist_status,
//      event_checklist_item_kind, event_checklist_action) via a new migration.
//
// Until that date: leave alone. The legacy code path is fully maintained.
// admin drafts → committee chairman fills → branch chairman reviews
// Branch chairman approval auto-publishes the event (via DB trigger).

export const eventChecklists = pgTable("event_checklists", {
  id:           uuid("id").primaryKey().defaultRandom(),
  event_id:     uuid("event_id").notNull().unique().references(() => events.id, { onDelete: "cascade" }),
  status:       eventChecklistStatusEnum("status").notNull().default("awaiting_committee"),
  created_by:   uuid("created_by").references(() => users.id),
  created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  finalized_at: timestamp("finalized_at", { withTimezone: true }),
});

export const eventChecklistItems = pgTable("event_checklist_items", {
  id:           uuid("id").primaryKey().defaultRandom(),
  checklist_id: uuid("checklist_id").notNull().references(() => eventChecklists.id, { onDelete: "cascade" }),
  label:        text("label").notNull(),
  kind:         eventChecklistItemKindEnum("kind").notNull().default("text"),
  value:        text("value"),  // chairman-supplied, interpreted per kind
  required:     boolean("required").notNull().default(true),
  sort_order:   integer("sort_order").notNull().default(0),
  created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const eventChecklistReviews = pgTable("event_checklist_reviews", {
  id:           uuid("id").primaryKey().defaultRandom(),
  checklist_id: uuid("checklist_id").notNull().references(() => eventChecklists.id, { onDelete: "cascade" }),
  actor_id:     uuid("actor_id").references(() => users.id),
  action:       eventChecklistActionEnum("action").notNull(),
  note:         text("note"),
  created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── CPE Credits ──────────────────────────────────────────────────────────────

export const cpeCredits = pgTable("cpe_credits", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  user_id:             uuid("user_id").notNull().references(() => users.id),
  event_id:            uuid("event_id").references(() => events.id),  // NULL for unstructured credits
  hours:               numeric("hours", { precision: 4, scale: 1 }).notNull(),
  type:                cpeTypeEnum("type").notNull(),
  year:                integer("year").notNull(),         // calendar year of credit
  source:              text("source"),                    // branch_event / icai_self_study
  issued_at:           timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  certificate_file_id: uuid("certificate_file_id").references(() => files.id, { onDelete: "set null" }),
  deleted_at:          timestamp("deleted_at", { withTimezone: true }),
});
