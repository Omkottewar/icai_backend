// Pragyaan AI — in-process caches for embeddings + answers.
//
// Cuts spend + latency on the two hot paths:
//
//   embedQueryCached(text)   — same input ⇒ same embedding (deterministic
//                              for both OpenAI's models and the dev-echo
//                              hash-based vectors). Cache forever (until
//                              process restart). Bounded by LRU size.
//
//   answerCacheGet/Set       — same question + same scope set ⇒ same
//                              answer. Cache for ~3 min so a small
//                              spike in repeats (e.g. a notification
//                              pointing 50 users at the same FAQ link)
//                              doesn't fan-out 50 LLM calls.
//
// Scope-set is part of the answer key because a member sees member-
// scope sources and a visitor doesn't — caching across roles would
// leak gated content. The key includes scopes alphabetized for
// stability.
//
// LRU eviction is the simplest possible: when the Map size hits the
// cap we drop the oldest insertion (Map preserves insertion order).
// We don't bother with strict LFU/LRU bookkeeping — the workload is
// tiny and the cost of a miss is just "re-run what you would have run
// anyway."

import type { Citation } from "./answer.js";
import type { Lang } from "./prompt.js";
import type { KbScope } from "./scope.js";

// ─── Embedding cache (no TTL) ───────────────────────────────────────────────
//
// Vectors are deterministic per input + model. We never need to evict
// for staleness — only for memory. 5k entries × 1536 floats × 8 bytes
// ≈ 60 MB which is fine for a process serving thousands of users.
const EMBED_CACHE_MAX = 5000;
const embedCache = new Map<string, number[]>();

function embedKey(text: string): string {
  // text + provider-side model is implicit in the JS process (one
  // provider per process). We don't include model in the key because
  // restarting after a model change resets the cache anyway.
  return text;
}

export function getCachedEmbedding(text: string): number[] | null {
  return embedCache.get(embedKey(text)) ?? null;
}

export function setCachedEmbedding(text: string, vec: number[]): void {
  if (embedCache.size >= EMBED_CACHE_MAX) {
    const oldest = embedCache.keys().next().value;
    if (oldest !== undefined) embedCache.delete(oldest);
  }
  embedCache.set(embedKey(text), vec);
}

// ─── Answer cache (TTL) ──────────────────────────────────────────────────────
//
// Cached for ANSWER_TTL_MS. Hot path uses peek (returns cached answer
// or null) and the orchestrator decides whether to stream the cached
// answer back as one big delta. The "stream-from-cache" path bypasses
// the LLM entirely — sub-50ms response.
const ANSWER_CACHE_MAX = 500;
const ANSWER_TTL_MS    = 3 * 60_000; // 3 minutes — long enough for a notification burst

interface CachedAnswer {
  ts: number;
  text: string;
  citations: Citation[];
  lang: Lang;
  noAnswer: boolean;
}

const answerCache = new Map<string, CachedAnswer>();

function answerKey(question: string, scopes: Set<KbScope>, lang: Lang | null): string {
  const scopeStr = [...scopes].sort().join(",");
  return `${(lang ?? "")}|${scopeStr}|${question.trim().toLowerCase()}`;
}

export function getCachedAnswer(
  question: string,
  scopes: Set<KbScope>,
  lang: Lang | null,
): CachedAnswer | null {
  const key = answerKey(question, scopes, lang);
  const hit = answerCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > ANSWER_TTL_MS) {
    answerCache.delete(key);
    return null;
  }
  return hit;
}

export function setCachedAnswer(
  question: string,
  scopes: Set<KbScope>,
  lang: Lang,
  entry: Omit<CachedAnswer, "ts" | "lang"> & { lang?: Lang },
): void {
  // Never cache the no-answer line — it's not the answer to a future
  // identical question, it's the answer to "we had no sources at the
  // time"; ingest may have run since.
  if (entry.noAnswer) return;
  // Never cache an empty answer either.
  if (!entry.text || entry.text.trim().length === 0) return;

  const key = answerKey(question, scopes, lang);
  if (answerCache.size >= ANSWER_CACHE_MAX) {
    const oldest = answerCache.keys().next().value;
    if (oldest !== undefined) answerCache.delete(oldest);
  }
  answerCache.set(key, {
    ts: Date.now(),
    text: entry.text,
    citations: entry.citations,
    lang,
    noAnswer: entry.noAnswer,
  });
}
