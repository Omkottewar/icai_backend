import {
  pgTable, uuid, text, integer, bigint, timestamp, jsonb, vector, boolean, real, AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  kbSourceTypeEnum, kbScopeEnum, kbIngestStatusEnum, chatRoleEnum, localeEnum,
} from "./enums";
import { users } from "./identity";
import { files } from "./files";

// ─── Pragyaan AI — RAG knowledge base (FIN-151) ────────────────────────────
// Canonical DDL lives in drizzle/0037_pragyaan_kb.sql; this mirrors it for
// typed CRUD + chat logging. Vector similarity search is done with raw SQL
// (the `<=>` cosine operator) in server/lib/rag, not the query builder.

export const kbSources = pgTable("kb_sources", {
  id:                   uuid("id").primaryKey().defaultRandom(),
  title:                text("title").notNull(),
  source_type:          kbSourceTypeEnum("source_type").notNull(),
  scope:                kbScopeEnum("scope").notNull().default("public"),
  lang:                 localeEnum("lang").notNull().default("en"),
  file_id:              uuid("file_id").references(() => files.id, { onDelete: "set null" }),
  url:                  text("url"),
  origin_kind:          text("origin_kind"),
  origin_id:            uuid("origin_id"),
  checksum:             text("checksum"),
  status:               kbIngestStatusEnum("status").notNull().default("pending"),
  version:              integer("version").notNull().default(1),
  supersedes_id:        uuid("supersedes_id").references((): AnyPgColumn => kbSources.id, { onDelete: "set null" }),
  uploaded_by:          uuid("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  approved_by:          uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
  approved_at:          timestamp("approved_at", { withTimezone: true }),
  retention_expires_at: timestamp("retention_expires_at", { withTimezone: true }),
  retired_at:           timestamp("retired_at", { withTimezone: true }),
  error:                text("error"),
  created_at:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:           timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const kbChunks = pgTable("kb_chunks", {
  id:          uuid("id").primaryKey().defaultRandom(),
  source_id:   uuid("source_id").notNull().references(() => kbSources.id, { onDelete: "cascade" }),
  chunk_index: integer("chunk_index").notNull(),
  content:     text("content").notNull(),
  token_count: integer("token_count"),
  scope:       kbScopeEnum("scope").notNull(),
  lang:        localeEnum("lang").notNull().default("en"),
  // 1536 dims = OpenAI text-embedding-3-small. Search via raw SQL `<=>`.
  embedding:   vector("embedding", { dimensions: 1536 }),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const kbConversations = pgTable("kb_conversations", {
  id:               uuid("id").primaryKey().defaultRandom(),
  user_id:          uuid("user_id").references(() => users.id, { onDelete: "set null" }), // null = anon
  anon_id:          text("anon_id"),
  role_at_time:     text("role_at_time"),
  lang:             localeEnum("lang"),
  title:            text("title"),
  started_at:       timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  last_activity_at: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
});

export const kbMessages = pgTable("kb_messages", {
  id:              uuid("id").primaryKey().defaultRandom(),
  conversation_id: uuid("conversation_id").notNull().references(() => kbConversations.id, { onDelete: "cascade" }),
  role:            chatRoleEnum("role").notNull(),
  content:         text("content").notNull(),
  citations:       jsonb("citations").notNull().default(sql`'[]'::jsonb`),
  model:           text("model"),
  tokens_in:       integer("tokens_in"),
  tokens_out:      integer("tokens_out"),
  latency_ms:      integer("latency_ms"),
  created_at:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Governance / audit / analytics (migration 0038) ───────────────────────

/** Answer-quality thumbs up/down on an assistant turn (P1-1). */
export const kbFeedback = pgTable("kb_feedback", {
  id:         uuid("id").primaryKey().defaultRandom(),
  message_id: uuid("message_id").notNull().references(() => kbMessages.id, { onDelete: "cascade" }),
  rating:     text("rating").notNull(), // 'up' | 'down' (CHECK enforced in SQL)
  comment:    text("comment"),
  user_id:    uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Append-only, hash-chained governance log (P0-8). UPDATE/DELETE are blocked by
 * a DB trigger; `row_hash` chains `prev_hash`, so any tampering breaks the chain.
 * Written only via server/lib/pragyaan/audit.ts. `seq` is the chain order.
 */
export const kbAudit = pgTable("kb_audit", {
  seq:          bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
  id:           uuid("id").primaryKey().defaultRandom(),
  source_id:    uuid("source_id").references(() => kbSources.id, { onDelete: "set null" }),
  actor_id:     uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  action:       text("action").notNull(),
  from_version: integer("from_version"),
  to_version:   integer("to_version"),
  detail:       jsonb("detail").notNull().default(sql`'{}'::jsonb`),
  prev_hash:    text("prev_hash"),
  row_hash:     text("row_hash").notNull(),
  created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Per-answer analytics for the admin dashboards (P1-5). */
export const kbQueryLog = pgTable("kb_query_log", {
  id:              uuid("id").primaryKey().defaultRandom(),
  conversation_id: uuid("conversation_id").references(() => kbConversations.id, { onDelete: "set null" }),
  question:        text("question"),
  lang:            localeEnum("lang"),
  role_label:      text("role_label"),
  scope_set:       text("scope_set").array(),
  no_answer:       boolean("no_answer").notNull().default(false),
  top_similarity:  real("top_similarity"),
  citation_count:  integer("citation_count").notNull().default(0),
  model:           text("model"),
  created_at:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
