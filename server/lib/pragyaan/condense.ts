// Pragyaan AI — multi-turn query rewriting.
//
// The single-shot retrieval has a glaring weakness: a follow-up like
// "and what's the fee?" embeds with no reference to whatever the user was
// just asking about ("the GST workshop"). The vector search returns
// generic fee-mentioning chunks, the model answers with no grounding for
// the user's real intent, and the experience feels stupid.
//
// We fix this with a "condense" step BEFORE retrieval:
//
//   condenseQuestion("and what's the fee?", [
//     { role: "user", content: "Tell me about the GST workshop on the 15th" },
//     { role: "assistant", content: "The GST workshop on Aug 15 ..." },
//   ])
//   → "What is the fee for the GST workshop on the 15th?"
//
// The rewritten question goes to the embedder; the ORIGINAL question is
// still passed to the answer prompt so the model's voice stays natural.
//
// Implementation: one cheap chat-completion call with a tight system
// prompt. We deliberately skip this when:
//   - There's no prior turn (nothing to condense against)
//   - The current question is already self-contained (>= 10 words and
//     no resolvable pronouns / discourse markers like "and", "what
//     about…", "his/her/their")
//
// Cost: ~250 input + ~30 output tokens per follow-up — cheap on
// gpt-4o-mini (~$0.00006), and we cache the result so repeated turns
// in the same conversation don't pay twice.

import { getProvider } from "./provider.js";
import type { ChatMsg } from "./provider.js";

export interface PriorTurn {
  role: "user" | "assistant";
  content: string;
}

// Heuristic: does the question look like it stands alone? If yes, skip
// the LLM call entirely. The patterns flag explicit follow-ups; long
// well-formed questions with no anaphora pass through unchanged.
function looksSelfContained(question: string): boolean {
  const q = question.trim();
  if (q.length < 12) return false; // probably a short follow-up

  // Discourse markers that imply continuation.
  if (/^\s*(and|also|or|so|then|but|what about|how about|what if|why|because)\b/i.test(q)) return false;

  // Bare pronouns / referring expressions that need a referent.
  if (/^\s*(it|this|that|they|them|those|these|he|she|him|her|his|hers)\b/i.test(q)) return false;
  if (/\b(his|her|their|its)\s+\w/i.test(q)) return false;

  // "the X" without any prior anchor — heuristic only; we let through
  // questions that mention a year, person name, or all-caps token (likely
  // an acronym like GST / ITR / CPE) because those tend to be self-anchoring.
  return /[A-Z]{2,}|\b(19|20)\d{2}\b|[A-Z][a-z]+/.test(q) || q.split(/\s+/).length >= 10;
}

// Per-conversation cache. Keyed on conversation id + question text so a
// retried identical follow-up doesn't re-call the model. Limited size to
// stop unbounded growth on long-lived processes.
interface CacheEntry { rewritten: string; ts: number; }
const REWRITE_CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS  = 30 * 60_000; // 30 min — conversations rarely span longer
const CACHE_MAX     = 500;

function cacheGet(key: string): string | null {
  const hit = REWRITE_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    REWRITE_CACHE.delete(key);
    return null;
  }
  return hit.rewritten;
}
function cacheSet(key: string, rewritten: string) {
  if (REWRITE_CACHE.size >= CACHE_MAX) {
    // Evict the oldest entry.
    const oldestKey = REWRITE_CACHE.keys().next().value;
    if (oldestKey) REWRITE_CACHE.delete(oldestKey);
  }
  REWRITE_CACHE.set(key, { rewritten, ts: Date.now() });
}

/**
 * Rewrite `question` into a self-contained query using the most recent
 * conversation turns. Returns the rewritten text on success, or the
 * original question unchanged when there's nothing to condense (no prior
 * turns, dev-echo provider, looks self-contained, or the model call fails).
 *
 * NEVER throws — condensation is an optimization, not a correctness step.
 */
export async function condenseQuestion(
  question: string,
  priorTurns: PriorTurn[],
  conversationId?: string | null,
): Promise<string> {
  const trimmed = question.trim();
  if (!trimmed) return question;
  if (priorTurns.length === 0) return trimmed;
  if (looksSelfContained(trimmed)) return trimmed;

  const cacheKey = `${conversationId ?? "anon"}::${trimmed}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // The dev-echo provider can't usefully rewrite — its generateStream
  // emits a canned quoted reply, not an obedient instruction-follower.
  // Fall back to the original question.
  const provider = getProvider();
  if (provider.mode === "dev-echo") return trimmed;

  // Keep the last 6 turns max — older context rarely affects condensation
  // and bloats input tokens.
  const recent = priorTurns.slice(-6);
  const history = recent.map((t) => `${t.role === "user" ? "USER" : "ASSISTANT"}: ${t.content}`).join("\n");

  const messages: ChatMsg[] = [
    {
      role: "system",
      content: [
        "You rewrite a follow-up question into a single self-contained question",
        "that can be understood without the conversation history.",
        "",
        "Rules:",
        "- Output ONLY the rewritten question. No preamble, no explanation, no quotes.",
        "- Preserve the user's original intent and language (English / Hindi / Marathi).",
        "- Resolve pronouns (it / they / that) using the most recent relevant turn.",
        "- Keep proper nouns, dates, numbers, and named entities verbatim.",
        "- If the question is already self-contained, return it unchanged.",
        "- Keep it short — one sentence.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `CONVERSATION SO FAR:\n${history}\n\nFOLLOW-UP: ${trimmed}\n\nREWRITTEN QUESTION:`,
    },
  ];

  try {
    let out = "";
    for await (const chunk of provider.generateStream(messages, { maxTokens: 120 })) {
      if (chunk.delta) out += chunk.delta;
      // The condensation prompt has no need for usage info; bail as soon
      // as we have enough text. The model usually completes in one chunk.
    }
    const rewritten = out.trim()
      // Strip surrounding quotes / "REWRITTEN: " prefixes the model
      // sometimes adds despite the instruction.
      .replace(/^(?:rewritten[^:]*:|>|")\s*/i, "")
      .replace(/^["']|["']$/g, "")
      .trim();

    // Sanity: if the model returned nothing or a 1-word fragment, bail.
    if (rewritten.length < 4 || rewritten.split(/\s+/).length < 2) {
      return trimmed;
    }
    cacheSet(cacheKey, rewritten);
    return rewritten;
  } catch {
    // Network blip or model error — never let condensation block retrieval.
    return trimmed;
  }
}
