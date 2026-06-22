-- ════════════════════════════════════════════════════════════════════════════
-- Migration 0044 — Replace partial unique on forum_posts(channel_id, client_id)
--                  with a full unique so ON CONFLICT can target it.
--
-- Migration 0043 created the index as PARTIAL:
--
--   CREATE UNIQUE INDEX forum_posts_channel_client_id_idx
--     ON forum_posts (channel_id, client_id)
--     WHERE client_id IS NOT NULL;
--
-- Postgres rejects `ON CONFLICT (channel_id, client_id) DO NOTHING`
-- against a partial index because the planner can't prove every input
-- row falls under the index's predicate (42P10 "there is no unique or
-- exclusion constraint matching the ON CONFLICT specification").
--
-- We don't actually need the partial — Postgres treats NULLs as
-- distinct in a unique index by default (NULLS DISTINCT), so multiple
-- rows with NULL client_id won't violate uniqueness even when the
-- index is full. We can drop the WHERE clause safely.
--
-- After this migration the chat send path's INSERT … ON CONFLICT
-- works first-try, and any rows that already exist with a NULL
-- client_id are unaffected.
-- ════════════════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS forum_posts_channel_client_id_idx;

CREATE UNIQUE INDEX forum_posts_channel_client_id_idx
  ON forum_posts (channel_id, client_id);
