import {
  pgTable, uuid, text, integer, boolean, timestamp,
} from "drizzle-orm/pg-core";
import { postingTypeEnum, postingStatusEnum } from "./enums";
import { users, employers } from "./identity";
import { payments } from "./payments";

// ─── Firms ────────────────────────────────────────────────────────────────────

export const firms = pgTable("firms", {
  id:                uuid("id").primaryKey().defaultRandom(),
  name:              text("name").notNull(),
  registration_no:   text("registration_no").notNull().unique(),
  email:             text("email"),          // API-gated to members
  phone:             text("phone"),
  website:           text("website"),
  address:           text("address"),
  city:              text("city"),
  pincode:           text("pincode"),
  gstin:             text("gstin"),
  partners_count:    integer("partners_count").notNull().default(0),
  areas_of_expertise: text("areas_of_expertise").array(),
  verified:          boolean("verified").notNull().default(false),
  created_at:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at:        timestamp("deleted_at", { withTimezone: true }),
});

// ─── Job Postings ─────────────────────────────────────────────────────────────

export const jobPostings = pgTable("job_postings", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  type:                postingTypeEnum("type").notNull(),
  title:               text("title").notNull(),
  description:         text("description").notNull(),
  poster_user_id:      uuid("poster_user_id").notNull().references(() => users.id),
  employer_id:         uuid("employer_id").references(() => employers.id, { onDelete: "set null" }),  // Fix #5
  firm_id:             uuid("firm_id").references(() => firms.id),   // for CA firm assignments
  seat_count:          integer("seat_count").notNull().default(1),
  experience_required: text("experience_required"),
  location:            text("location"),
  fee_paise:           integer("fee_paise").notNull().default(0),    // posting fee paid by employer
  payment_id:          uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),  // Fix #2
  status:              postingStatusEnum("status").notNull().default("draft"),
  expires_at:          timestamp("expires_at", { withTimezone: true }),
  created_at:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at:          timestamp("deleted_at", { withTimezone: true }),
});
