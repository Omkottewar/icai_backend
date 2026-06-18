-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0038 — Pragyaan AI governance, audit & analytics (FIN-151, P0-8/P1)
--
-- Builds on 0037 (kb_sources / kb_chunks / kb_conversations / kb_messages).
-- Adds the three governance/observability tables the spec calls out:
--
--   • kb_feedback   answer-quality thumbs up/down (+ optional comment) attached
--                   to an assistant kb_message. Feeds the admin review queue
--                   (P1-1).
--   • kb_audit      append-only, hash-chained, tamper-evident log of every
--                   source mutation (upload/approve/reject/reindex/rollback/
--                   retire/retention). Each row's row_hash chains the previous
--                   row_hash, so any tampering breaks the chain. UPDATE/DELETE
--                   are blocked by a trigger — the log is write-once (P0-8).
--   • kb_query_log  per-answer analytics (volume, no-answer rate, top
--                   similarity, citations, model) for the analytics cards
--                   (P1-5). Already written best-effort by answer.ts (guarded
--                   so it no-ops until this migration lands).
--
-- Idempotent / guarded throughout (CREATE … IF NOT EXISTS, guarded enum-free
-- DO-blocks for the function + trigger) so it is safe to re-run. The kb_scope /
-- locale enums and the kb_* tables it references already exist from 0037 and
-- earlier migrations.
-- ════════════════════════════════════════════════════════════════════════════

-- ── kb_feedback ──────────────────────────────────────────────────────────────
-- Thumbs up/down on an assistant turn. user_id NULL = anonymous visitor's
-- feedback (the assistant message is the durable anchor; deleting the user
-- keeps the rating but nulls the author).
CREATE TABLE IF NOT EXISTS "kb_feedback" (
  "id"         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "message_id" uuid NOT NULL REFERENCES "kb_messages"("id") ON DELETE CASCADE,
  "rating"     text NOT NULL CHECK ("rating" IN ('up','down')),
  "comment"    text,
  "user_id"    uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "kb_feedback_message_idx" ON "kb_feedback" ("message_id");

-- ── kb_audit ─────────────────────────────────────────────────────────────────
-- Append-only, hash-chained governance log. `seq` is a gap-free monotonic
-- ordering key (the chain order); `row_hash` = sha256(prev_hash || '\n' ||
-- canonicalJSON(payload)) is computed in server/lib/pragyaan/audit.ts and
-- written here. prev_hash on the first row is NULL.
CREATE TABLE IF NOT EXISTS "kb_audit" (
  "seq"          bigint GENERATED ALWAYS AS IDENTITY,
  "id"           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_id"    uuid REFERENCES "kb_sources"("id") ON DELETE SET NULL,
  "actor_id"     uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "action"       text NOT NULL,
  "from_version" integer,
  "to_version"   integer,
  "detail"       jsonb NOT NULL DEFAULT '{}'::jsonb,
  "prev_hash"    text,
  "row_hash"     text NOT NULL,
  "created_at"   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "kb_audit_source_idx"  ON "kb_audit" ("source_id");
CREATE INDEX IF NOT EXISTS "kb_audit_created_idx" ON "kb_audit" ("created_at");

-- Immutability: block UPDATE and DELETE so the hash chain can never be rewritten
-- or pruned. A BEFORE trigger raises, so even a superuser hits the guard unless
-- they drop the trigger first (which is itself an audit-worthy DDL event).
-- INSERT is unaffected — the table is append-only by construction.
CREATE OR REPLACE FUNCTION "kb_audit_block_mutations"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'kb_audit is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'raise_exception';
END;
$$;

DO $$ BEGIN
  CREATE TRIGGER "kb_audit_no_update_delete"
    BEFORE UPDATE OR DELETE ON "kb_audit"
    FOR EACH ROW EXECUTE FUNCTION "kb_audit_block_mutations"();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── kb_query_log ─────────────────────────────────────────────────────────────
-- Per-answer analytics. conversation_id may be nulled if the conversation is
-- deleted; the analytics row survives for aggregate reporting. `scope_set` is
-- the resolved allowed-scope set for the asking role (text[], not the enum, so
-- the analytics table is decoupled from the kb_scope enum's lifecycle).
CREATE TABLE IF NOT EXISTS "kb_query_log" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id" uuid REFERENCES "kb_conversations"("id") ON DELETE SET NULL,
  "question"        text,
  "lang"            "locale",
  "role_label"      text,
  "scope_set"       text[],
  "no_answer"       boolean NOT NULL DEFAULT false,
  "top_similarity"  real,
  "citation_count"  integer NOT NULL DEFAULT 0,
  "model"           text,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "kb_query_log_created_idx"   ON "kb_query_log" ("created_at");
CREATE INDEX IF NOT EXISTS "kb_query_log_no_answer_idx" ON "kb_query_log" ("no_answer");
