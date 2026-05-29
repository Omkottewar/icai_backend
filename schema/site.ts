import { pgTable, text, jsonb, uuid, timestamp } from "drizzle-orm/pg-core";
import { users } from "./identity";

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
