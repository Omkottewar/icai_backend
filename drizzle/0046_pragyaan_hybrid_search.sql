-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0046 — Pragyaan hybrid search support
--
-- Adds a Postgres full-text index on kb_chunks.content so the retrieval
-- layer can do hybrid search (BM25-ish via ts_rank_cd × cosine via
-- pgvector). Hybrid search consistently outperforms either signal alone,
-- especially for proper-noun queries ("CA Karan Sharma", "ITC reversal",
-- "Form 26AS") where embeddings underperform because the rare token
-- isn't in their training distribution.
--
-- We use a functional GIN index over `to_tsvector('english', content)`
-- — not a stored generated column — so we don't touch the kb_chunks
-- row layout. The 'english' configuration is OK for Hindi / Marathi
-- text too because Devanagari tokens fall through as-is (they're not
-- stop-listed). If we ever need Indic stemming we can swap to a
-- bilingual config without re-indexing existing chunks.
--
-- The "simple" config is unused but reserved if we want to disable
-- stemming for exact-match queries; for now `english` strikes the
-- right balance.
-- ════════════════════════════════════════════════════════════════════════════

CREATE INDEX IF NOT EXISTS kb_chunks_content_fts_idx
  ON kb_chunks
  USING GIN (to_tsvector('english', content));
