import { pgTable, uuid, text, timestamp, AnyPgColumn } from "drizzle-orm/pg-core";
import { forumThreadTagEnum } from "./enums";
import { users } from "./identity";
import { events } from "./events";
import { committees } from "./committees";

// ─── forum_threads ────────────────────────────────────────────────────────
// Top of a discussion. Scoped to an event OR a committee (DB enforces the
// CHECK constraint forum_threads_scope_check — at least one must be set).
export const forumThreads = pgTable("forum_threads", {
  id:           uuid("id").primaryKey().defaultRandom(),
  title:        text("title").notNull(),
  body:         text("body").notNull(),
  tag:          forumThreadTagEnum("tag").notNull().default("discussion"),
  event_id:     uuid("event_id").references(() => events.id, { onDelete: "set null" }),
  committee_id: uuid("committee_id").references(() => committees.id, { onDelete: "set null" }),
  created_by:   uuid("created_by").notNull().references(() => users.id),
  created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at:   timestamp("deleted_at", { withTimezone: true }),
});

// ─── forum_posts ──────────────────────────────────────────────────────────
// Replies. parent_post_id is reserved for future nested-reply support — for
// v1 we only render flat threads.
export const forumPosts = pgTable("forum_posts", {
  id:             uuid("id").primaryKey().defaultRandom(),
  thread_id:      uuid("thread_id").notNull().references(() => forumThreads.id, { onDelete: "cascade" }),
  parent_post_id: uuid("parent_post_id").references((): AnyPgColumn => forumPosts.id, { onDelete: "cascade" }),
  body:           text("body").notNull(),
  created_by:     uuid("created_by").notNull().references(() => users.id),
  created_at:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at:     timestamp("deleted_at", { withTimezone: true }),
});
