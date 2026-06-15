import { pgTable, uuid, text, timestamp, boolean } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { grievanceStatusEnum } from "./enums";

// Admin-editable map of subject → email. CRUD'd from /admin/grievance-routes
// so the client can change which inbox a complaint goes to without a deploy.
export const grievanceSubjectRoutes = pgTable("grievance_subject_routes", {
  subject:     text("subject").primaryKey(),
  label:       text("label").notNull(),
  route_email: text("route_email").notNull(),
  active:      boolean("active").notNull().default(true),
  updated_by:  uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updated_at:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Public contact / grievance / suggestion submissions. user_id is nullable
// because anonymous (logged-out) visitors can submit too — tracking is via
// the ticket_no + email pair, not the session.
export const grievances = pgTable("grievances", {
  id:                     uuid("id").primaryKey().defaultRandom(),
  ticket_no:              text("ticket_no").notNull().unique(),
  name:                   text("name").notNull(),
  email:                  text("email").notNull(),
  phone:                  text("phone"),
  subject:                text("subject").notNull(),
  against_type:           text("against_type").notNull().default("branch"),
  against_ref:            text("against_ref"),
  message:                text("message").notNull(),
  user_id:                uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  status:                 grievanceStatusEnum("status").notNull().default("open"),
  assigned_to:            uuid("assigned_to").references(() => users.id, { onDelete: "set null" }),
  resolution_note:        text("resolution_note"),
  resolved_at:            timestamp("resolved_at", { withTimezone: true }),
  feature_in_newsletter:  boolean("feature_in_newsletter").notNull().default(false),
  newsletter_approved_by: uuid("newsletter_approved_by").references(() => users.id, { onDelete: "set null" }),
  newsletter_approved_at: timestamp("newsletter_approved_at", { withTimezone: true }),
  escalated_at:           timestamp("escalated_at", { withTimezone: true }),
  created_at:             timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:             timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
