-- Pragyaan AI — RAG knowledge base foundation (FIN-151, Phase 1)
--
-- Adds pgvector + the four core KB tables: sources, chunks (with embeddings),
-- conversations, and messages. The kb_* / chat_role enums are already declared
-- in schema/enums.ts; they're (re)created here with a guarded DO-block so this
-- migration is safe whether or not the types already exist in the DB.
--
-- Scope enforcement (P0-3) is the `scope` column on kb_chunks: retrieval filters
-- `WHERE scope IN (:allowedScopes)` BEFORE the vector search, so gated chunks
-- never enter the LLM context for an unauthorized role. Enforcement at
-- retrieval, not just prompt.
--
-- Embeddings are vector(1536) to match OpenAI text-embedding-3-small. Vector
-- search uses the cosine operator (<=>) via raw SQL in server/lib/rag.

CREATE EXTENSION IF NOT EXISTS vector;

-- ── Enums (guarded — no-op if already present) ─────────────────────────────
DO $$ BEGIN
  CREATE TYPE "kb_source_type" AS ENUM ('uploaded_pdf','url','internal_doc','event_material','newsletter','circular');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "kb_scope" AS ENUM ('public','member','student','employer','internal');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "kb_ingest_status" AS ENUM ('pending','chunking','embedded','indexed','failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "chat_role" AS ENUM ('user','assistant','system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── kb_sources ─────────────────────────────────────────────────────────────
-- One row per ingested source (uploaded PDF, URL, or a row pulled from an
-- existing DB table such as events/circulars/site_content). Carries the
-- access-scope tag, ingest status, and version chain for rollback.
CREATE TABLE IF NOT EXISTS "kb_sources" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "title"                text NOT NULL,
  "source_type"          "kb_source_type" NOT NULL,
  "scope"                "kb_scope" NOT NULL DEFAULT 'public',
  "lang"                 "locale" NOT NULL DEFAULT 'en',
  "file_id"              uuid REFERENCES "files"("id") ON DELETE SET NULL,
  "url"                  text,
  "origin_kind"          text,          -- 'event' | 'circular' | 'site_content' | 'newsletter' | … for DB-sourced rows
  "origin_id"            uuid,          -- id of the originating DB row (nullable)
  "checksum"             text,          -- content hash — change detection / re-index dedupe
  "status"               "kb_ingest_status" NOT NULL DEFAULT 'pending',
  "version"              integer NOT NULL DEFAULT 1,
  "supersedes_id"        uuid REFERENCES "kb_sources"("id") ON DELETE SET NULL,
  "uploaded_by"          uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "approved_by"          uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "approved_at"          timestamptz,
  "retention_expires_at" timestamptz,
  "retired_at"           timestamptz,
  "error"                text,
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "kb_sources_scope_status_idx" ON "kb_sources" ("scope","status");
CREATE INDEX IF NOT EXISTS "kb_sources_origin_idx"       ON "kb_sources" ("origin_kind","origin_id");

-- ── kb_chunks ────────────────────────────────────────────────────────────────
-- Chunked source text + its embedding. `scope`/`lang` are denormalized from the
-- parent source so role-scoped retrieval is a single indexed WHERE clause.
CREATE TABLE IF NOT EXISTS "kb_chunks" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "source_id"   uuid NOT NULL REFERENCES "kb_sources"("id") ON DELETE CASCADE,
  "chunk_index" integer NOT NULL,
  "content"     text NOT NULL,
  "token_count" integer,
  "scope"       "kb_scope" NOT NULL,
  "lang"        "locale" NOT NULL DEFAULT 'en',
  "embedding"   vector(1536),
  "created_at"  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "kb_chunks_scope_idx"  ON "kb_chunks" ("scope");
CREATE INDEX IF NOT EXISTS "kb_chunks_source_idx" ON "kb_chunks" ("source_id");
-- HNSW cosine index for ANN search (pgvector >= 0.5). Cheap to create empty.
CREATE INDEX IF NOT EXISTS "kb_chunks_embedding_hnsw"
  ON "kb_chunks" USING hnsw ("embedding" vector_cosine_ops);

-- ── kb_conversations ─────────────────────────────────────────────────────────
-- A chat session. user_id NULL = anonymous visitor (identified by anon_id).
CREATE TABLE IF NOT EXISTS "kb_conversations" (
  "id"               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id"          uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "anon_id"          text,
  "role_at_time"     text,           -- role label that scoped this conversation's retrieval
  "lang"             "locale",
  "title"            text,
  "started_at"       timestamptz NOT NULL DEFAULT now(),
  "last_activity_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "kb_conversations_user_idx" ON "kb_conversations" ("user_id");

-- ── kb_messages ──────────────────────────────────────────────────────────────
-- Individual turns. `citations` is [{source_id,title,url,chunk_id}] for the
-- assistant turn that produced them.
CREATE TABLE IF NOT EXISTS "kb_messages" (
  "id"              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "conversation_id" uuid NOT NULL REFERENCES "kb_conversations"("id") ON DELETE CASCADE,
  "role"            "chat_role" NOT NULL,
  "content"         text NOT NULL,
  "citations"       jsonb NOT NULL DEFAULT '[]'::jsonb,
  "model"           text,
  "tokens_in"       integer,
  "tokens_out"      integer,
  "latency_ms"      integer,
  "created_at"      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "kb_messages_conversation_idx" ON "kb_messages" ("conversation_id","created_at");
