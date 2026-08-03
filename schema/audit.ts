import {
  pgTable, uuid, text, integer, timestamp, jsonb, index, uniqueIndex,
} from "drizzle-orm/pg-core";

// ─── Audit log ────────────────────────────────────────────────────────────
//
// One row per write action across the whole portal. Powers the admin
// audit-log page ("who did what") and per-entity History tabs. Grows
// unbounded — pruned by a retention cron (default: 2 years for the
// firehose, forever for entity_versions).
//
// See migration 0098 and backend/server/lib/audit.ts for the write API.

export const auditLog = pgTable(
  "audit_log",
  {
    id:              uuid("id").primaryKey().defaultRandom(),
    occurred_at:     timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    // Deliberately not a FK to users — we want the row to survive after
    // a user is soft-deleted or their account is cascaded elsewhere.
    actor_user_id:   uuid("actor_user_id"),
    actor_ip:        text("actor_ip"),
    actor_role_code: text("actor_role_code"),
    entity_type:     text("entity_type").notNull(),
    entity_id:       uuid("entity_id"),
    action:          text("action").notNull(),
    changed_fields:  text("changed_fields").array().notNull().default([]),
    before_json:     jsonb("before_json"),
    after_json:      jsonb("after_json"),
    note:            text("note"),
  },
  (t) => [
    index("idx_audit_log_entity").on(t.entity_type, t.entity_id, t.occurred_at),
    index("idx_audit_log_actor").on(t.actor_user_id, t.occurred_at),
    index("idx_audit_log_occurred").on(t.occurred_at),
  ],
);

// ─── Entity versions ──────────────────────────────────────────────────────
//
// Full-snapshot rows for entities that need queryable version history —
// e.g. "give me v5 of this checklist instance" or "revert this site-
// content slot to yesterday's copy". Only used for entities that opt in
// via saveVersion() in the audit helper.

export const entityVersions = pgTable(
  "entity_versions",
  {
    id:               uuid("id").primaryKey().defaultRandom(),
    entity_type:      text("entity_type").notNull(),
    entity_id:        uuid("entity_id").notNull(),
    version_number:   integer("version_number").notNull(),
    saved_at:         timestamp("saved_at", { withTimezone: true }).notNull().defaultNow(),
    saved_by_user_id: uuid("saved_by_user_id"),
    change_note:      text("change_note"),
    snapshot_json:    jsonb("snapshot_json").notNull(),
  },
  (t) => [
    uniqueIndex("idx_entity_versions_unique").on(t.entity_type, t.entity_id, t.version_number),
    index("idx_entity_versions_lookup").on(t.entity_type, t.entity_id, t.saved_at),
  ],
);
