// Pragyaan AI — LLM-based reranker.
//
// pgvector + tsvector hybrid gives us a candidate set ordered by
// "close-in-vector-space + matches-keyword." That's not the same as
// "actually answers the question." A reranker is one extra cheap pass
// that asks an instruction-following model: "Given this question and
// these candidates, which are MOST RELEVANT?" The model reads each
// candidate and outputs a ranked id list.
//
// Trade-off: ~150–400 ms latency for a measurable jump in answer
// quality, because the chunks the LLM actually reasons over are the
// ones a model already judged relevant — not just nearby.
//
// We use the same chat provider (no new vendor). To keep cost down:
//   • Truncate each candidate to ~600 chars before showing.
//   • Cap input candidates at 20.
//   • Ask only for the top-K ids in compact form (one number per line).
//   • Set a hard maxTokens budget — replies are short.
//
// Failure modes are all silent: bad parse, network blip, or dev-echo
// mode all fall back to the input order. Reranking is a quality
// optimization, not a correctness step.

import { getProvider } from "./provider.js";
import type { ChatMsg } from "./provider.js";
import type { RetrievedChunk } from "./retrieval.js";

// How much of each chunk to show the reranker. Keep it small — the
// reranker needs enough context to judge relevance, not the whole
// document. ~600 chars ≈ 150 tokens × 20 candidates = 3000 input
// tokens, well under any model's budget.
const CHUNK_PREVIEW_CHARS = 600;
const MAX_CANDIDATES      = 20;

/**
 * Rerank candidates by LLM-judged relevance to the question.
 * Returns at most `topK` chunks in the new order. On any error or
 * when fewer than 2 candidates are supplied, returns the input
 * (truncated to topK) unchanged.
 */
export async function rerank(
  question: string,
  candidates: RetrievedChunk[],
  topK: number,
): Promise<RetrievedChunk[]> {
  if (candidates.length <= 1) return candidates.slice(0, topK);

  const provider = getProvider();
  // Dev-echo can't follow ranking instructions usefully — passthrough.
  if (provider.mode === "dev-echo") return candidates.slice(0, topK);

  // Cap input set; the LLM doesn't gain much past 20 candidates.
  const trimmed = candidates.slice(0, MAX_CANDIDATES);

  const listing = trimmed
    .map((c, i) => {
      const preview = c.content.length > CHUNK_PREVIEW_CHARS
        ? c.content.slice(0, CHUNK_PREVIEW_CHARS) + "…"
        : c.content;
      return `[${i + 1}] (${c.title})\n${preview}`;
    })
    .join("\n\n");

  const messages: ChatMsg[] = [
    {
      role: "system",
      content: [
        "You are a relevance ranker for a Q&A retrieval system.",
        "",
        "Given a USER QUESTION and a numbered list of CANDIDATES,",
        `output the up to ${topK} candidate numbers MOST RELEVANT to answering`,
        "the question, in descending order of relevance.",
        "",
        "Rules:",
        "- Output ONLY a comma-separated list of numbers. No prose. No explanations.",
        "- Use only numbers that appear in CANDIDATES.",
        "- If fewer than the requested count are useful, list only the useful ones.",
        "- Example output: 3,1,7,2,5",
      ].join("\n"),
    },
    {
      role: "user",
      content: `USER QUESTION: ${question}\n\nCANDIDATES:\n${listing}\n\nRANKING:`,
    },
  ];

  try {
    let out = "";
    for await (const chunk of provider.generateStream(messages, { maxTokens: 80 })) {
      if (chunk.delta) out += chunk.delta;
    }
    // Parse "3, 1, 7, 2, 5" → [3, 1, 7, 2, 5] (and ignore garbage).
    const indices = out
      .replace(/[^\d,]/g, "")
      .split(",")
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= trimmed.length);

    // Empty / unparseable → passthrough.
    if (indices.length === 0) return candidates.slice(0, topK);

    // Build reranked list. Dedupe indices (the model can repeat) and
    // backfill any that the model dropped with the original order so
    // we always return up to topK candidates.
    const seen = new Set<number>();
    const out_chunks: RetrievedChunk[] = [];
    for (const i of indices) {
      if (seen.has(i)) continue;
      seen.add(i);
      out_chunks.push(trimmed[i - 1]!);
      if (out_chunks.length >= topK) break;
    }
    // Backfill: if the model returned fewer than topK, append from the
    // original order (skipping ones already chosen).
    for (let i = 0; i < trimmed.length && out_chunks.length < topK; i++) {
      if (!seen.has(i + 1)) {
        out_chunks.push(trimmed[i]!);
        seen.add(i + 1);
      }
    }
    return out_chunks;
  } catch {
    // Model error, network blip, etc — passthrough.
    return candidates.slice(0, topK);
  }
}
