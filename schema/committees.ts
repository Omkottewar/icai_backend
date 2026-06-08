import { pgTable, uuid, text, boolean, timestamp } from "drizzle-orm/pg-core";

// ─── Committees ──────────────────────────────────────────────────────────
// The branch's standing committees (CPE, Membership, Investor Awareness, …).
// Every event belongs to exactly one committee (events.committee_id NOT NULL).
// Committee chairmen are tracked via user_role_assignments with
// scope_committee_id pointing here.

export const committees = pgTable("committees", {
  id:          uuid("id").primaryKey().defaultRandom(),
  code:        text("code").notNull().unique(),  // CPE, EXAM, MEMBERSHIP …
  name:        text("name").notNull(),
  description: text("description"),
  active:      boolean("active").notNull().default(true),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
