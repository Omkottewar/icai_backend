import { pgTable, text, jsonb, uuid, timestamp, integer, index } from "drizzle-orm/pg-core";
import { users, branches } from "./identity";

// ─── Site Content ─────────────────────────────────────────────────────────────
// Named editorial slots keyed by a small fixed slug. The `data` JSON shape
// varies per slot (chairman has photo+quote+name+role; about_history is just
// a markdown body). Allowed slugs + their field shapes are documented in
// server/lib/siteContentSlots.ts so server and admin form-generator agree.
//
// Frontend reads via GET /api/site/content (cached). Admin writes via
// PUT /api/admin/site/content/:slug.

export const siteContent = pgTable("site_content", {
  slug:       text("slug").primaryKey(),
  data:       jsonb("data").notNull().default({}),
  updated_by: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Site Settings ────────────────────────────────────────────────────────────
// Flat key/value table for simple strings (phone, email, address, footer
// copyright, social URLs). Anything richer than a single string belongs in
// site_content instead.

export const siteSettings = pgTable("site_settings", {
  key:        text("key").primaryKey(),
  value:      text("value").notNull().default(""),
  updated_by: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Announcements ────────────────────────────────────────────────────────────
// Drives the homepage ticker (Requirements §E.3) and the future "all
// announcements" page. Each row is one announcement; the public endpoint
// filters to "currently active" via starts_at/ends_at.
//
// `audience` is a plain text column (default 'all') so we can add scoping
// later without an enum migration. v1 ignores it on the frontend.

export const announcements = pgTable(
  "announcements",
  {
    id:            uuid("id").primaryKey().defaultRandom(),
    branch_id:     uuid("branch_id").references(() => branches.id, { onDelete: "cascade" }),
    title:         text("title").notNull(),
    body:          text("body"),               // optional long-form for detail view
    link_url:      text("link_url"),           // optional CTA url
    audience:      text("audience").notNull().default("all"),  // 'all' | 'members' | 'students' | 'employers'
    starts_at:     timestamp("starts_at", { withTimezone: true }).notNull().defaultNow(),
    ends_at:       timestamp("ends_at", { withTimezone: true }),
    display_order: integer("display_order").notNull().default(0),
    created_by:    uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deleted_at:    timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // The public list is sorted by starts_at within the active window;
    // this index lets the planner pick rows fast.
    index("announcements_window_idx").on(t.starts_at, t.ends_at),
    index("announcements_branch_idx").on(t.branch_id),
  ],
);
