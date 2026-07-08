import { pgTable, uuid, text, jsonb, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { users } from "./identity";

// Per-user widget layout for customizable dashboards.
// `layout` is an array of { id, size } in render order. The widget registry
// on the frontend is the single source of truth for what each id means;
// the DB just persists the user's choice without knowing the widget catalog.
//
// `scope` lets a single user hold multiple layouts — one per dashboard
// surface (branch chairman, treasurer, …) — without them clobbering each
// other on save. Existing rows are backfilled to 'chairman' by migration.
export const dashboardLayouts = pgTable(
  "dashboard_layouts",
  {
    user_id:    uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    scope:      text("scope").notNull().default("chairman"),
    layout:     jsonb("layout").notNull().default([]),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.user_id, t.scope] }),
  ],
);
