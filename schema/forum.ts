import { pgTable, uuid, text, timestamp, AnyPgColumn, integer, jsonb, primaryKey, unique, index, boolean } from "drizzle-orm/pg-core";
import { forumThreadTagEnum } from "./enums";
import { users } from "./identity";
import { events } from "./events";
import { committees } from "./committees";
import { mockTests } from "./mockTests";

// ─── forum_threads ────────────────────────────────────────────────────────
// Top of a discussion. Scoped to an event, a committee, OR a mock test
// (DB enforces the CHECK constraint forum_threads_scope_check — at least
// one must be set). See migration 0052.
export const forumThreads = pgTable("forum_threads", {
  id:           uuid("id").primaryKey().defaultRandom(),
  title:        text("title").notNull(),
  body:         text("body").notNull(),
  tag:          forumThreadTagEnum("tag").notNull().default("discussion"),
  event_id:     uuid("event_id").references(() => events.id, { onDelete: "set null" }),
  committee_id: uuid("committee_id").references(() => committees.id, { onDelete: "set null" }),
  mock_test_id: uuid("mock_test_id").references(() => mockTests.id, { onDelete: "cascade" }),
  // Scope-less discussion topic (e.g. 'student_general', 'members_general').
  // A thread is valid when ANY of event_id / committee_id / mock_test_id /
  // topic is set — enforced by the forum_threads_scope_check constraint.
  topic:        text("topic"),
  created_by:   uuid("created_by").notNull().references(() => users.id),
  created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at:   timestamp("deleted_at", { withTimezone: true }),
});

// ─── event_chat_channels ──────────────────────────────────────────────────
// Discord-style channels scoped to an event. Each event gets at least a
// 'general' channel auto-provisioned; admins can add more (Q&A,
// announcements, speaker). See backend/server/routes/eventChat.ts.
export const eventChatChannels = pgTable(
  "event_chat_channels",
  {
    id:                 uuid("id").primaryKey().defaultRandom(),
    event_id:           uuid("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    name:               text("name").notNull(),
    description:        text("description"),
    kind:               text("kind").notNull().default("general"),
    sort_order:         integer("sort_order").notNull().default(0),
    post_role_required: text("post_role_required"),  // NULL = anyone registered
    // Moderator-controlled lockdown. `frozen`: read-only for everyone
    // except moderators (lets a chairman quiet a runaway channel). `archived_at`:
    // read-only for everyone (set when the event ends).
    frozen:             boolean("frozen").notNull().default(false),
    archived_at:        timestamp("archived_at", { withTimezone: true }),
    created_at:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deleted_at:         timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("event_chat_channels_event_idx").on(t.event_id, t.sort_order),
  ],
);

// ─── event_chat_mutes ─────────────────────────────────────────────────────
// Moderator-applied mutes — affected user can't send messages until the
// row expires (`muted_until`) or is deleted by another moderator. Scope
// is per-event (channel_id NULL) or per-channel.
export const eventChatMutes = pgTable("event_chat_mutes", {
  id:          uuid("id").primaryKey().defaultRandom(),
  event_id:    uuid("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  user_id:     uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  channel_id:  uuid("channel_id").references(() => eventChatChannels.id, { onDelete: "cascade" }),
  reason:      text("reason"),
  muted_until: timestamp("muted_until", { withTimezone: true }),
  muted_by:    uuid("muted_by").references(() => users.id, { onDelete: "set null" }),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── event_chat_message_reports ───────────────────────────────────────────
// "Report this message" by another user. The UNIQUE on (message_id,
// reported_by) means one user can only report a given message once.
export const eventChatMessageReports = pgTable(
  "event_chat_message_reports",
  {
    id:              uuid("id").primaryKey().defaultRandom(),
    message_id:      uuid("message_id").notNull().references(() => forumPosts.id, { onDelete: "cascade" }),
    reported_by:     uuid("reported_by").notNull().references(() => users.id, { onDelete: "cascade" }),
    reason:          text("reason").notNull(),
    resolved_at:     timestamp("resolved_at", { withTimezone: true }),
    resolved_by:     uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
    resolution_note: text("resolution_note"),
    created_at:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("event_chat_message_reports_uq").on(t.message_id, t.reported_by),
  ],
);

// ─── event_chat_audit ─────────────────────────────────────────────────────
// Append-only log. We write a row on every edit/delete/pin/mute/freeze
// so an audit trail exists for the regulatory branch.
export const eventChatAudit = pgTable(
  "event_chat_audit",
  {
    id:                uuid("id").primaryKey().defaultRandom(),
    event_id:          uuid("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    actor_id:          uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
    action:            text("action").notNull(),
    target_message_id: uuid("target_message_id"),
    target_user_id:    uuid("target_user_id"),
    target_channel_id: uuid("target_channel_id"),
    details:           jsonb("details").notNull().default({}),
    created_at:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

// ─── forum_posts ──────────────────────────────────────────────────────────
// Used by both the legacy forum (thread_id) AND the Discord-style event
// chat (channel_id). Exactly one of those two is set per row. The chat
// model uses parent_post_id for replies, attachments[] for files, and
// mention_user_ids[] to drive notifications + the "you were mentioned"
// counter.
export const forumPosts = pgTable("forum_posts", {
  id:               uuid("id").primaryKey().defaultRandom(),
  // Legacy threads (committee discussions) still use thread_id; chat
  // posts have it NULL. Migration 0041 dropped NOT NULL.
  thread_id:        uuid("thread_id").references(() => forumThreads.id, { onDelete: "cascade" }),
  channel_id:       uuid("channel_id").references(() => eventChatChannels.id, { onDelete: "cascade" }),
  parent_post_id:   uuid("parent_post_id").references((): AnyPgColumn => forumPosts.id, { onDelete: "cascade" }),
  // Client-generated UUID stamped onto the post BEFORE it leaves the
  // browser. Lets the server treat retried sends as idempotent — the
  // (channel_id, client_id) UNIQUE partial index catches duplicates.
  // Null for server-internal inserts (e.g. system messages).
  client_id:        uuid("client_id"),
  body:             text("body").notNull(),
  // jsonb array of { file_id, name, mime_type, size, url }. We don't FK
  // to the files table per-row because attachments come and go fast in
  // chat and the file rows manage their own lifecycle.
  attachments:      jsonb("attachments").notNull().default([]),
  mention_user_ids: uuid("mention_user_ids").array().notNull().default([]),
  pinned_at:        timestamp("pinned_at", { withTimezone: true }),
  edited_at:        timestamp("edited_at", { withTimezone: true }),
  // Q&A resolution marker — only meaningful on top-level posts in a
  // channel.kind = 'qa' channel. NULL = open question, non-NULL = answered
  // (with audit who/when). See migration 0051.
  answered_at:      timestamp("answered_at", { withTimezone: true }),
  answered_by:      uuid("answered_by").references(() => users.id, { onDelete: "set null" }),
  created_by:       uuid("created_by").notNull().references(() => users.id),
  created_at:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at:       timestamp("deleted_at", { withTimezone: true }),
});

// ─── forum_post_reactions ─────────────────────────────────────────────────
// One row per (post, user, emoji). The UNIQUE constraint means clicking
// the same emoji twice is a no-op insert at the API layer (we DELETE
// instead — toggle semantics).
export const forumPostReactions = pgTable(
  "forum_post_reactions",
  {
    id:         uuid("id").primaryKey().defaultRandom(),
    post_id:    uuid("post_id").notNull().references(() => forumPosts.id, { onDelete: "cascade" }),
    user_id:    uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    emoji:      text("emoji").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("forum_post_reactions_uq").on(t.post_id, t.user_id, t.emoji),
    index("forum_post_reactions_post_idx").on(t.post_id),
  ],
);

// ─── event_chat_channel_reads ─────────────────────────────────────────────
// Per-(channel, user) "last read" timestamp. The channel list compares
// this against the channel's newest message to compute an unread
// indicator without scanning every message.
export const eventChatChannelReads = pgTable(
  "event_chat_channel_reads",
  {
    channel_id:   uuid("channel_id").notNull().references(() => eventChatChannels.id, { onDelete: "cascade" }),
    user_id:      uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    last_read_at: timestamp("last_read_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.channel_id, t.user_id] }),
  ],
);
