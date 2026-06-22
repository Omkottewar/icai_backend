// Pragyaan AI — role-scoped vector retrieval (FIN-151).
//
// Embeds the user's question and runs a pgvector ANN search over kb_chunks,
// filtered by (a) the caller's allowed scopes (the P0-3 access boundary —
// gated chunks never enter the result set) and (b) the governance gate (only
// live / approved / non-retired / non-expired sources are searchable).
//
// Cosine distance is the `<=>` operator; similarity = 1 - distance. Results
// come back ordered by closeness, and `noAnswer` is set when even the top hit
// falls below PRAGYAAN_MIN_SIMILARITY — the orchestrator uses that to emit the
// localized "I don't know" line instead of fabricating an answer.
//
// Raw SQL (not the query builder) so we can use the vector operator and a
// scope-array filter in one indexed pass. Uses the db singleton + drizzle
// sql`` template; the query vector is bound as a pgvector literal '[...]'.

import { sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { pragyaanConfig } from "./config.js";
import { getProvider } from "./provider.js";
import { getCachedEmbedding, setCachedEmbedding } from "./cache.js";
import type { KbScope } from "./scope.js";

/** One retrieved chunk with its parent-source metadata and similarity. */
export interface RetrievedChunk {
  /** kb_chunks.id */
  id: string;
  /** Chunk text — the SOURCES body fed to the model. */
  content: string;
  /** kb_sources.id this chunk belongs to (used to dedupe citations). */
  sourceId: string;
  /** The chunk's access scope. */
  scope: KbScope;
  /** 0-based position within its source. */
  chunkIndex: number;
  /** Parent source title (citation label). */
  title: string;
  /** Parent source URL, if any (citation deep-link). */
  url: string | null;
  /** Originating table kind for DB-sourced rows ('event'|'circular'|…), if any. */
  originKind: string | null;
  /** Originating DB row id, if any (citation deep-link target). */
  originId: string | null;
  /** Cosine similarity in [-1, 1]; higher = closer. */
  similarity: number;
}

export interface RetrieveOptions {
  /** Override the final result size (default PRAGYAAN_TOP_K). */
  topK?: number;
  /**
   * Over-fetch candidate pool size for the reranker. Set to (e.g.) 20
   * so the reranker has room to elevate items that ranked low in raw
   * hybrid scoring but actually answer the question. Defaults to topK
   * (no over-fetch — equivalent to the pre-rerank behavior).
   */
  fetchK?: number;
}

export interface RetrieveResult {
  /** Matching chunks, ordered most-similar first (length ≤ topK). */
  chunks: RetrievedChunk[];
  /** Highest similarity among `chunks`, or null when there were no rows. */
  topSimilarity: number | null;
  /** True when the top hit is below PRAGYAAN_MIN_SIMILARITY (or no rows). */
  noAnswer: boolean;
}

// Shape of a raw row returned by the ANN query (snake_case from SQL).
interface RetrievalRow {
  id: string;
  content: string;
  source_id: string;
  scope: KbScope;
  chunk_index: number;
  title: string;
  url: string | null;
  origin_kind: string | null;
  origin_id: string | null;
  similarity: number | string; // pg numeric may arrive as a string
}

/** Format a JS number[] as a pgvector text literal: '[v1,v2,...]'. */
function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * Embed `question` and retrieve the top-K scope-allowed, governance-gated
 * chunks by cosine similarity.
 *
 * @param question  The user's query text.
 * @param scopes    Allowed scopes from resolveRequestScopes/rolesToScopes.
 *                  An empty set yields no results (fail-closed).
 * @param opts      Optional overrides (topK).
 */
export async function retrieve(
  question: string,
  scopes: Set<KbScope>,
  opts: RetrieveOptions = {},
): Promise<RetrieveResult> {
  const topK = opts.topK ?? pragyaanConfig.topK;
  const fetchK = Math.max(opts.fetchK ?? topK, topK);
  const scopeList = [...scopes];

  // Fail-closed: no question or no allowed scope ⇒ nothing is retrievable.
  if (!question.trim() || scopeList.length === 0) {
    return { chunks: [], topSimilarity: null, noAnswer: true };
  }

  const provider = getProvider();
  // Cache the query embedding — identical questions are common (a
  // notification linking 50 users to the same FAQ, a popular starter
  // re-fired). Saves an OpenAI embeddings round-trip and ~20ms.
  let qvec = getCachedEmbedding(question);
  if (!qvec) {
    qvec = await provider.embedQuery(question);
    if (qvec.length > 0) setCachedEmbedding(question, qvec);
  }
  const qliteral = toVectorLiteral(qvec);

  // Build `ARRAY['public'::kb_scope, …]` with each scope bound as a parameter
  // and element-cast to the enum. Binding a JS string[] and casting the whole
  // thing `::kb_scope[]` makes Postgres throw (22P02 / 42846), so we cast
  // per element instead. Scope values come from the fixed KbScope enum, never
  // from client input.
  const scopeArray = sql.join(
    scopeList.map((s) => sql`${s}::kb_scope`),
    sql`, `,
  );

  // ── Hybrid search via Reciprocal Rank Fusion ──────────────────────
  //
  // Pure vector search misses proper-noun queries ("CA Karan Sharma",
  // "Form 26AS") because rare tokens are under-represented in embedding
  // training data. Pure keyword search misses semantic paraphrase
  // ("how to register" vs "registration steps"). We combine both via
  // RRF:
  //
  //   rrf_score(chunk) = Σ_searches 1 / (60 + rank_in_search)
  //
  // ...with the standard k=60 constant from the original paper.
  //
  // SHAPE: the two score-CTEs (vec_scores / fts_scores) carry ONLY the
  // chunk id + numeric scoring columns — no uuid metadata. We GROUP BY
  // id to sum per-branch RRF contributions (Postgres has no MAX(uuid),
  // so dragging source_id through the aggregation would fail). The
  // outer SELECT then JOINs back to kb_chunks + kb_sources once per
  // surviving id to hydrate the metadata the caller actually needs.
  //
  // Each branch over-fetches 3× the requested fetchK so the fusion has
  // overlap to elevate items that only one branch ranked well.
  const fetchPerBranch = Math.max(fetchK * 3, 20);

  const rows = (await db.execute(sql`
    WITH vec_scores AS (
      SELECT
        c.id,
        1 - (c.embedding <=> ${qliteral}::vector) AS similarity,
        ROW_NUMBER() OVER (ORDER BY c.embedding <=> ${qliteral}::vector) AS rnk
      FROM kb_chunks c
      JOIN kb_sources s ON s.id = c.source_id
      WHERE c.scope = ANY(ARRAY[${scopeArray}])
        AND c.embedding IS NOT NULL
        AND s.status = 'indexed'
        AND s.retired_at IS NULL
        AND s.approved_at IS NOT NULL
        AND (s.retention_expires_at IS NULL OR s.retention_expires_at > now())
      ORDER BY c.embedding <=> ${qliteral}::vector
      LIMIT ${fetchPerBranch}
    ),
    fts_scores AS (
      SELECT
        c.id,
        ROW_NUMBER() OVER (
          ORDER BY ts_rank_cd(to_tsvector('english', c.content), websearch_to_tsquery('english', ${question})) DESC
        ) AS rnk
      FROM kb_chunks c
      JOIN kb_sources s ON s.id = c.source_id
      WHERE c.scope = ANY(ARRAY[${scopeArray}])
        AND to_tsvector('english', c.content) @@ websearch_to_tsquery('english', ${question})
        AND s.status = 'indexed'
        AND s.retired_at IS NULL
        AND s.approved_at IS NOT NULL
        AND (s.retention_expires_at IS NULL OR s.retention_expires_at > now())
      ORDER BY ts_rank_cd(to_tsvector('english', c.content), websearch_to_tsquery('english', ${question})) DESC
      LIMIT ${fetchPerBranch}
    ),
    combined AS (
      SELECT id,
             MAX(similarity)::float AS similarity,
             SUM(rrf)::float        AS rrf_score
      FROM (
        SELECT id, similarity::float AS similarity, (1.0 / (60 + rnk))::float AS rrf
        FROM vec_scores
        UNION ALL
        SELECT id, NULL::float       AS similarity, (1.0 / (60 + rnk))::float AS rrf
        FROM fts_scores
      ) x
      GROUP BY id
    )
    SELECT
      c.id,
      c.content,
      c.source_id,
      c.scope,
      c.chunk_index,
      s.title,
      s.url,
      s.origin_kind,
      s.origin_id,
      COALESCE(combined.similarity, 0)::float AS similarity
    FROM combined
    JOIN kb_chunks  c ON c.id = combined.id
    JOIN kb_sources s ON s.id = c.source_id
    ORDER BY combined.rrf_score DESC
    LIMIT ${fetchK}
  `)) as unknown as Iterable<RetrievalRow>;

  const chunks: RetrievedChunk[] = [];
  for (const r of rows) {
    chunks.push({
      id: r.id,
      content: r.content,
      sourceId: r.source_id,
      scope: r.scope,
      chunkIndex: r.chunk_index,
      title: r.title,
      url: r.url,
      originKind: r.origin_kind,
      originId: r.origin_id,
      similarity: typeof r.similarity === "string" ? Number(r.similarity) : r.similarity,
    });
  }

  // Top similarity is computed from the vector-search similarity (kept
  // verbatim on each row for the no-answer gate). RRF reordering may
  // surface a chunk with slightly lower cosine but stronger keyword
  // match — that's fine for noAnswer purposes; what matters is whether
  // SOMETHING relevant was found.
  const topSimilarity = chunks.length > 0
    ? chunks.reduce((m, c) => Math.max(m, c.similarity), 0)
    : null;
  const noAnswer = topSimilarity == null || topSimilarity < pragyaanConfig.minSimilarity;

  return { chunks, topSimilarity, noAnswer };
}
