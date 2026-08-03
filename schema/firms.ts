import {
  pgTable, uuid, text, integer, bigint, boolean, timestamp,
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
  // Job category — drives subscription matching. Nullable to preserve
  // existing rows that predate the taxonomy; new postings should set it.
  // FK declared via inline SQL to break the circular dep with jobsExtended.ts.
  category_id:         uuid("category_id"),
  seat_count:          integer("seat_count").notNull().default(1),
  experience_required: text("experience_required"),
  location:            text("location"),
  // Salary / CTC / stipend range in paise. Both ends nullable so an
  // employer can list "up to ₹8L" or "from ₹12L" or omit entirely. The
  // period column separates monthly stipends (articleship), annual CTC
  // (jobs), and per-engagement fees (assignments). See migration 0094.
  salary_paise_min:    bigint("salary_paise_min", { mode: "number" }),
  salary_paise_max:    bigint("salary_paise_max", { mode: "number" }),
  salary_period:       text("salary_period").notNull().default("monthly"),
  // Simple view counter incremented on GET /api/jobs/:id. Best-effort —
  // a dropped update doesn't matter for the ratio the employer cares
  // about (views vs. applications).
  view_count:          integer("view_count").notNull().default(0),
  fee_paise:           integer("fee_paise").notNull().default(0),    // posting fee paid by employer
  payment_id:          uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),  // Fix #2
  status:              postingStatusEnum("status").notNull().default("draft"),
  expires_at:          timestamp("expires_at", { withTimezone: true }),
  created_at:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at:          timestamp("deleted_at", { withTimezone: true }),
});
