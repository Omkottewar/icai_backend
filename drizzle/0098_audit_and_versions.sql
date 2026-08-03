-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0098 — Audit log + entity version snapshots
--
-- Two-table foundation for "who did what, when" across the whole portal.
--
-- audit_log     — firehose. One row per write action. Cheap to append,
--                 indexed for the common queries: "what happened to
--                 entity X" and "what did user Y do lately". Grows fast;
--                 pruned by cron (retention lives in code, not SQL).
--
-- entity_versions — full snapshot rows for the entities where we want
--                   *queryable* version history (checklists, site
--                   content, events, notification templates, etc.). One
--                   row per version. audit_log tells you what changed;
--                   entity_versions lets you view / revert to a specific
--                   older shape.
--
-- Neither table has a foreign key to `users` on the actor column —
-- keeping actor as a raw uuid avoids cascade problems when a user is
-- soft-deleted (we still want the audit row to say who did it).
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS "audit_log" (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  actor_user_id UUID,                -- NULL for system-triggered writes (cron, webhooks)
  actor_ip      TEXT,
  actor_role_code TEXT,              -- convenience — 'branch_chairman' / 'wicasa' / etc.
  entity_type   TEXT NOT NULL,       -- 'job_postings' / 'checklist_instances' / 'site_content' / …
  entity_id     UUID,                -- nullable for bulk / non-uuid actions
  action        TEXT NOT NULL,       -- 'created' | 'updated' | 'deleted' | 'status_changed' | 'reassigned' | custom
  changed_fields TEXT[] NOT NULL DEFAULT '{}',
  before_json   JSONB,               -- prior state (null on 'created')
  after_json    JSONB,               -- new state (null on 'deleted')
  note          TEXT                 -- free-text reason from admin ("reassigned because…")
);

-- Hot-path indexes — see comments on the columns above.
CREATE INDEX IF NOT EXISTS idx_audit_log_entity
  ON audit_log (entity_type, entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor
  ON audit_log (actor_user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_occurred
  ON audit_log (occurred_at DESC);


CREATE TABLE IF NOT EXISTS "entity_versions" (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type     TEXT NOT NULL,
  entity_id       UUID NOT NULL,
  version_number  INTEGER NOT NULL, -- monotonically increasing per (entity_type, entity_id)
  saved_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  saved_by_user_id UUID,
  change_note     TEXT,
  snapshot_json   JSONB NOT NULL
);

-- Version numbering is unique per entity, and the "latest version" query
-- lands on the second index without a sort.
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_versions_unique
  ON entity_versions (entity_type, entity_id, version_number);
CREATE INDEX IF NOT EXISTS idx_entity_versions_lookup
  ON entity_versions (entity_type, entity_id, saved_at DESC);
