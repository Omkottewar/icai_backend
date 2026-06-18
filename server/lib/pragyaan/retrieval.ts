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
  /** Override the per-query fan-out (default PRAGYAAN_TOP_K). */
  topK?: number;
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
  const scopeList = [...scopes];

  // Fail-closed: no question or no allowed scope ⇒ nothing is retrievable.
  if (!question.trim() || scopeList.length === 0) {
    return { chunks: [], topSimilarity: null, noAnswer: true };
  }

  const provider = getProvider();
  const qvec = await provider.embedQuery(question);
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

  // pgvector ANN search. The scope filter + governance gate run BEFORE the
  // similarity ranking, so out-of-scope or ungated chunks never surface.
  // `${qliteral}::vector` binds the literal and casts it; the scope filter is
  // the per-element-cast `ARRAY[…]` built above.
  const rows = (await db.execute(sql`
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
      1 - (c.embedding <=> ${qliteral}::vector) AS similarity
    FROM kb_chunks c
    JOIN kb_sources s ON s.id = c.source_id
    WHERE c.scope = ANY(ARRAY[${scopeArray}])
      AND c.embedding IS NOT NULL
      AND s.status = 'indexed'
      AND s.retired_at IS NULL
      AND s.approved_at IS NOT NULL
      AND (s.retention_expires_at IS NULL OR s.retention_expires_at > now())
    ORDER BY c.embedding <=> ${qliteral}::vector
    LIMIT ${topK}
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

  const topSimilarity = chunks.length > 0 ? chunks[0]!.similarity : null;
  const noAnswer = topSimilarity == null || topSimilarity < pragyaanConfig.minSimilarity;

  return { chunks, topSimilarity, noAnswer };
}
