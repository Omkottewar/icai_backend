// Pragyaan AI — typed runtime config (FIN-151).
//
// Single source of truth for the env knobs the RAG assistant reads. Loaded
// once at import time (env is fixed for the process lifetime). Values mirror
// the "Environment additions" block in docs/PRAGYAAN_SPEC.md.
//
// `OPENAI_API_KEY` is read here too: a blank/absent key flips the provider
// into dev-echo mode (see provider.ts). We don't throw on a missing key —
// the whole point of dev-echo is to let the rest of the pipeline run offline.

import "dotenv/config";

// ─── helpers ──────────────────────────────────────────────────────────────
function str(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

export interface PragyaanConfig {
  /** OpenAI API key. Blank ⇒ dev-echo mode. */
  readonly openaiApiKey: string;
  /** Chat/completion model id (e.g. a GPT-5.x mini/nano tier). */
  readonly chatModel: string;
  /** Embedding model id. */
  readonly embeddingModel: string;
  /** Embedding vector dimension — must match the kb_chunks vector column (1536). */
  readonly embeddingDimensions: number;
  /** ANN search fan-out: number of chunks pulled per query. */
  readonly topK: number;
  /** Cosine-similarity floor; top result below this ⇒ no-answer. */
  readonly minSimilarity: number;
  /** Hard cap on assembled context length handed to the model. */
  readonly maxContextChars: number;
  /** Per-minute chat rate limit for anonymous (by-IP) callers. */
  readonly anonRatePerMin: number;
  /** Per-minute chat rate limit for authenticated callers. */
  readonly userRatePerMin: number;
  /**
   * LLM reranker on/off. The reranker is a full extra LLM round-trip
   * that scores retrieval candidates before generation. It adds ~250 ms
   * of wall-clock latency for a marginal quality bump — off by default
   * so the bot feels snappy. Flip on via PRAGYAAN_RERANK=1 if answer
   * quality regresses on tough queries.
   */
  readonly rerankEnabled: boolean;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// `OPENAI_EMBEDDING_MODEL` is the canonical spec name; `EMBEDDING_MODEL`
// is honoured as a legacy alias so an existing .env keeps working.
const embeddingModel =
  process.env.OPENAI_EMBEDDING_MODEL ??
  process.env.EMBEDDING_MODEL ??
  "text-embedding-3-small";

export const pragyaanConfig: PragyaanConfig = {
  openaiApiKey:        (process.env.OPENAI_API_KEY ?? "").trim(),
  // gpt-4o-mini is 2-4× faster than gpt-4o for a chatbot and 20-50× cheaper,
  // with quality that's still very good on grounded RAG answers. Override via
  // OPENAI_CHAT_MODEL if a specific model is required.
  chatModel:           str("OPENAI_CHAT_MODEL", "gpt-4o-mini"),
  embeddingModel:      embeddingModel === "" ? "text-embedding-3-small" : embeddingModel,
  embeddingDimensions: int("EMBEDDING_DIMENSIONS", 1536),
  topK:                int("PRAGYAAN_TOP_K", 6),
  minSimilarity:       num("PRAGYAAN_MIN_SIMILARITY", 0.18),
  maxContextChars:     int("PRAGYAAN_MAX_CONTEXT_CHARS", 12000),
  anonRatePerMin:      int("PRAGYAAN_ANON_RATE_PER_MIN", 8),
  userRatePerMin:      int("PRAGYAAN_USER_RATE_PER_MIN", 30),
  rerankEnabled:       bool("PRAGYAAN_RERANK", false),
};
