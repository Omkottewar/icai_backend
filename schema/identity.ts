import {
  pgTable, uuid, text, boolean, timestamp, date, integer, jsonb, AnyPgColumn,
} from "drizzle-orm/pg-core";
import {
  userRoleEnum, userStatusEnum, localeEnum, genderEnum,
  studentLevelEnum, articleshipStatusEnum, copStatusEnum,
  employerUserRoleEnum, roleScopeEnum,
} from "./enums";
import { committees } from "./committees";
import { files } from "./files";

// ─── Branches ───────────────────────────────────────────────────────────────

export const branches = pgTable("branches", {
  id:          uuid("id").primaryKey().defaultRandom(),
  code:        text("code").notNull().unique(),          // NGP, PNE, MUM …
  name:        text("name").notNull(),                   // Nagpur Branch
  city:        text("city").notNull(),
  state:       text("state").notNull(),
  region_code: text("region_code"),                      // WIRC, NIRC …
  active:      boolean("active").notNull().default(true),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Roles ───────────────────────────────────────────────────────────────────

export const roles = pgTable("roles", {
  id:                   uuid("id").primaryKey().defaultRandom(),
  code:                 text("code").notNull().unique(),   // branch_chairman, mcm, committee_chairman …
  name:                 text("name").notNull(),
  description:          text("description"),
  scope:                roleScopeEnum("scope").notNull().default("global"),
  singleton_per_scope:  boolean("singleton_per_scope").notNull().default(false),
  created_at:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Users ────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id:            uuid("id").primaryKey().defaultRandom(),
  name:          text("name").notNull(),
  email:         text("email").notNull().unique(),
  phone:         text("phone"),
  primary_role:  userRoleEnum("primary_role").notNull(),  // UI hint only
  status:        userStatusEnum("status").notNull().default("active"),
  locale:        localeEnum("locale").notNull().default("en"),
  avatar_id:     uuid("avatar_id").references((): AnyPgColumn => files.id, { onDelete: "set null" }),
  branch_id:     uuid("branch_id").references(() => branches.id),
  last_login_at: timestamp("last_login_at", { withTimezone: true }),
  notify_email:  boolean("notify_email").notNull().default(true),
  notify_sms:    boolean("notify_sms").notNull().default(false),
  notify_push:   boolean("notify_push").notNull().default(true),
  created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at:    timestamp("deleted_at", { withTimezone: true }),
});

// ─── User Role Assignments ────────────────────────────────────────────────────

export const userRoleAssignments = pgTable("user_role_assignments", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  user_id:             uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role_id:             uuid("role_id").notNull().references(() => roles.id),
  scope_branch_id:     uuid("scope_branch_id").references(() => branches.id),   // populated for branch-scoped roles
  scope_committee_id:  uuid("scope_committee_id").references(() => committees.id, { onDelete: "restrict" }),  // for committee-scoped roles
  effective_from:      date("effective_from").notNull(),
  effective_to:        date("effective_to"),          // NULL = currently active
  created_at:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Employers ────────────────────────────────────────────────────────────────

export const employers = pgTable("employers", {
  id:           uuid("id").primaryKey().defaultRandom(),
  company_name: text("company_name").notNull(),
  gstin:        text("gstin"),
  pan:          text("pan"),
  verified:     boolean("verified").notNull().default(false),
  website:      text("website"),
  address:      text("address"),
  created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at:   timestamp("deleted_at", { withTimezone: true }),
});

// ─── Employer Users ───────────────────────────────────────────────────────────

export const employerUsers = pgTable("employer_users", {
  id:          uuid("id").primaryKey().defaultRandom(),
  employer_id: uuid("employer_id").notNull().references(() => employers.id, { onDelete: "cascade" }),
  user_id:     uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role:        employerUserRoleEnum("role").notNull().default("poster"),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // UNIQUE(employer_id, user_id) — add via index or .unique() on both cols
});

// ─── Member Profiles ──────────────────────────────────────────────────────────

export const memberProfiles = pgTable("member_profiles", {
  user_id:           uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  mrn:               text("mrn").notNull().unique(),   // ICAI Membership Registration No.
  is_fca:            boolean("is_fca").notNull().default(false),
  cop_status:        copStatusEnum("cop_status").notNull().default("none"),
  cop_number:        text("cop_number"),
  is_practising:     boolean("is_practising").notNull().default(false),
  gender:            genderEnum("gender").notNull().default("unspecified"),
  member_since:      date("member_since"),
  areas_of_practice: text("areas_of_practice").array(),
  address:           text("address"),
  city:              text("city"),
  pincode:           text("pincode"),
  kym_data:          jsonb("kym_data").notNull().default({}),  // KYM compliance — restored Fix #13
  deleted_at:        timestamp("deleted_at", { withTimezone: true }),
});

// ─── Student Profiles ─────────────────────────────────────────────────────────

export const studentProfiles = pgTable("student_profiles", {
  user_id:              uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  srn:                  text("srn").notNull().unique(),
  level:                studentLevelEnum("level").notNull(),
  articleship_status:   articleshipStatusEnum("articleship_status"),  // not_started | ongoing | completed | terminated
  articleship_start:    date("articleship_start"),
  principal_member_id:  uuid("principal_member_id").references(() => users.id),
  exam_attempts:        integer("exam_attempts").notNull().default(0),
  deleted_at:           timestamp("deleted_at", { withTimezone: true }),
});

// ─── OAuth Links ──────────────────────────────────────────────────────────────

export const oauthLinks = pgTable("oauth_links", {
  id:             uuid("id").primaryKey().defaultRandom(),
  user_id:        uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider:       text("provider").notNull(),   // icai_sso
  external_id:    text("external_id").notNull(), // MRN or SRN — UNIQUE(provider, external_id)
  last_synced_at: timestamp("last_synced_at", { withTimezone: true }),
  created_at:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
