import {
  pgTable, uuid, text, integer, numeric, timestamp, boolean,
} from "drizzle-orm/pg-core";
import {
  eventAudienceEnum, eventModeEnum, eventStatusEnum,
  registrationStatusEnum, cpeTypeEnum,
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
  gst_applicable:       boolean("gst_applicable").notNull().default(false),
  gst_percent:          numeric("gst_percent", { precision: 4, scale: 2 }).notNull().default("18.00"),
  capacity:             integer("capacity"),            // NULL = unlimited
  registered_count:     integer("registered_count").notNull().default(0),  // Fix #4 — atomic seat tracking
  status:               eventStatusEnum("status").notNull().default("draft"),
  banner_id:            uuid("banner_id").references(() => files.id, { onDelete: "set null" }),
  recurrence_parent_id: uuid("recurrence_parent_id"),  // self-ref FK → events.id
  recurrence_rrule:     text("recurrence_rrule"),       // RFC 5545
  highlights:           text("highlights").array(),
  program_type:         text("program_type"),
  speaker_name:         text("speaker_name"),
  speaker_bio:          text("speaker_bio"),
  speaker_photo_id:     uuid("speaker_photo_id").references(() => files.id, { onDelete: "set null" }),
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

// Legacy event_checklists / event_checklist_items / event_checklist_reviews
// tables were dropped in migration 0024. The single source of truth for
// event approval is now checklist_instances (see schema/checklists.ts).

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
