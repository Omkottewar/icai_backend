// Pragyaan AI — prompt assembly + language helpers (FIN-151).
//
// Turns a retrieved-chunk set into the system + user ChatMsg pair handed to the
// provider. The grounding contract lives here (verbatim-ish from
// docs/PRAGYAAN_SPEC.md "Orchestration"): the model answers ONLY from the
// numbered SOURCES, cites `[n]`, replies in the user's language, stays brief,
// and never fabricates — when the answer isn't in the sources it says so and,
// for gated-looking topics, nudges the visitor to log in.
//
// Pure + deterministic: no DB, no provider calls. answer.ts wires retrieval →
// buildMessages → provider.generateStream.

import { pragyaanConfig } from "./config.js";
import type { ChatMsg } from "./provider.js";
import type { RetrievedChunk } from "./retrieval.js";

// The three supported reply languages (mirrors the `locale` enum en/hi/mr).
export type Lang = "en" | "hi" | "mr";

export const SUPPORTED_LANGS: readonly Lang[] = ["en", "hi", "mr"];

// Human-readable names the system prompt uses to instruct the model which
// language to answer in.
const LANG_NAMES: Record<Lang, string> = {
  en: "English",
  hi: "Hindi (हिन्दी)",
  mr: "Marathi (मराठी)",
};

// Localized "I don't have this" line returned on the no-answer path. Each
// variant also hints at logging in, since the most common no-answer cause for
// a visitor is a members-only topic that got scope-filtered out of retrieval.
const NO_ANSWER: Record<Lang, string> = {
  en: "I don't have information on that in my knowledge base yet. If this topic may be members-only, try logging in — I can then search member resources.",
  hi: "मेरे पास अभी इस विषय की जानकारी उपलब्ध नहीं है। यदि यह विषय केवल सदस्यों के लिए हो सकता है, तो कृपया लॉग इन करें — फिर मैं सदस्य संसाधनों में खोज सकता/सकती हूँ।",
  mr: "माझ्याकडे सध्या या विषयाची माहिती उपलब्ध नाही. हा विषय फक्त सदस्यांसाठी असू शकतो — कृपया लॉग इन करा, मग मी सदस्य संसाधनांमध्ये शोध घेऊ शकतो/शकते.",
};

/**
 * Detect the reply language. An explicit, supported `lang` param always wins
 * (the client may carry a UI-selected language). Otherwise we sniff the script:
 * any Devanagari character ⇒ Hindi (the spec's default for Devanagari; Marathi
 * shares the script and is only chosen when explicitly requested), else English.
 */
export function detectLang(text: string, explicit?: string | null): Lang {
  if (explicit && (SUPPORTED_LANGS as readonly string[]).includes(explicit)) {
    return explicit as Lang;
  }
  // Devanagari block U+0900–U+097F. Hindi + Marathi both use it; without an
  // explicit hint we default to Hindi per the spec.
  if (/[ऀ-ॿ]/.test(text)) return "hi";
  return "en";
}

/** The localized no-answer message for a given language. */
export function noAnswerMessage(lang: Lang): string {
  return NO_ANSWER[lang] ?? NO_ANSWER.en;
}

/**
 * Build the numbered SOURCES block from retrieved chunks, capped at
 * PRAGYAAN_MAX_CONTEXT_CHARS. Chunks are taken in similarity order (highest
 * first) until the budget is exhausted; a chunk that would overflow is skipped
 * so the cap is a hard ceiling, never exceeded.
 *
 * Returns the rendered block plus the chunks that actually made it in (in the
 * order they were numbered) so the caller can build citations from exactly the
 * sources the model was shown.
 */
function buildSourcesBlock(
  sources: RetrievedChunk[],
  maxChars: number,
): { block: string; used: RetrievedChunk[] } {
  const parts: string[] = [];
  const used: RetrievedChunk[] = [];
  let total = 0;

  for (const c of sources) {
    const n = used.length + 1;
    const entry = `[${n}] ${c.title}\n${c.content}`;
    // +2 for the blank line separator we join with (except before the first).
    const cost = entry.length + (parts.length > 0 ? 2 : 0);
    if (total + cost > maxChars) {
      // Skip oversized entries but keep scanning — a later, smaller chunk may
      // still fit. (In practice they arrive largest-relevance first.)
      if (used.length === 0) {
        // Nothing fits at all: include a hard-truncated first chunk so the
        // model has something to ground on rather than an empty block.
        const room = Math.max(0, maxChars - `[1] ${c.title}\n`.length);
        if (room > 0) {
          parts.push(`[1] ${c.title}\n${c.content.slice(0, room)}`);
          used.push(c);
          total = maxChars;
        }
      }
      continue;
    }
    parts.push(entry);
    used.push(c);
    total += cost;
  }

  return { block: parts.join("\n\n"), used };
}

export interface BuildMessagesInput {
  /** The user's question, verbatim. */
  question: string;
  /** Reply language (already resolved via detectLang). */
  lang: Lang;
  /** Retrieved chunks, most-similar first. May be empty (caller handles no-answer). */
  sources: RetrievedChunk[];
}

export interface BuildMessagesResult {
  /** system + user turns for the provider. */
  messages: ChatMsg[];
  /** The chunks actually packed into the context (post-cap), in numbering order. */
  usedSources: RetrievedChunk[];
}

/**
 * Assemble the system + user messages for a grounded answer.
 *
 * The system message carries Pragyaan's identity, the strict-grounding +
 * citation + language + brevity + disclaimer rules. The user message carries
 * the numbered SOURCES block followed by the question.
 */
export function buildMessages(input: BuildMessagesInput): BuildMessagesResult {
  const { question, lang, sources } = input;
  const { block, used } = buildSourcesBlock(sources, pragyaanConfig.maxContextChars);

  const langName = LANG_NAMES[lang] ?? LANG_NAMES.en;

  const system = [
    "You are Pragyaan, the AI assistant for the ICAI Nagpur Branch portal.",
    "",
    "GROUNDING (strict): Answer using the numbered SOURCES provided in the user message AND, when needed, " +
      "data you fetch via the available tools. Do not use outside knowledge for branch-specific facts. " +
      "If neither the SOURCES nor a tool can answer, say you don't know — never guess or fabricate. " +
      "If the question looks like it may concern members-only / gated material, " +
      "suggest that the user log in so gated resources can be searched.",
    "TOOLS: When the user asks about live data (what they're registered for, " +
      "upcoming events, who's in a committee, finding a specific paper), prefer calling a tool over " +
      "guessing from SOURCES — the SOURCES may be stale snapshots. After the tool returns, summarize the " +
      "result naturally; do not paste raw JSON. Tools you cannot see are not available — never claim to call " +
      "a tool that wasn't listed.",
    "CITATIONS: After each claim drawn from a SOURCE, cite it inline as [n], where n is the source number. " +
      "Cite every source you rely on; do not invent source numbers. Tool results do NOT need citations — " +
      "they are live data, not document sources.",
    `LANGUAGE: Reply in ${langName}. Match the user's language even if the sources are in another language.`,
    "STYLE: Be concise and direct. Prefer short paragraphs or bullet points. Do not repeat the question. " +
      "When tool results include URLs, surface them as clickable links (markdown format: [label](url)).",
    "DISCLAIMER: You provide general information from the branch knowledge base, not professional, legal, " +
      "or financial advice. Do not append a disclaimer to every answer — the interface shows one — but never " +
      "present guidance as authoritative professional advice.",
  ].join("\n");

  // No usable context ⇒ an empty SOURCES block. The model is still instructed
  // (and the dev-echo provider is wired) to emit the don't-know line; answer.ts
  // additionally short-circuits the retrieval-level no-answer before we get here.
  const user = block
    ? `SOURCES:\n${block}\n\nQUESTION: ${question}`
    : `SOURCES:\n(none)\n\nQUESTION: ${question}`;

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    usedSources: used,
  };
}
