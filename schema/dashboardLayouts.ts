import { pgTable, uuid, jsonb, timestamp } from "drizzle-orm/pg-core";
import { users } from "./identity";

// Per-user widget layout for the customizable chairman dashboard.
// `layout` is an array of { id, size } in render order. The widget registry
// on the frontend is the single source of truth for what each id means;
// the DB just persists the user's choice without knowing the widget catalog.
export const dashboardLayouts = pgTable("dashboard_layouts", {
  user_id:    uuid("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  layout:     jsonb("layout").notNull().default([]),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
