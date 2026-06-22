// Pragyaan AI — follow-up question suggestions.
//
// After each answer we ask the model for 3 short, natural follow-up
// questions a user might want to ask next. Rendered as clickable chips
// below the response — replacing the citation chips which were rarely
// useful and confused users into thinking they were buttons.
//
// Cheap: ~200 input + ~80 output tokens per call (≈$0.00006 on
// gpt-4o-mini). Fires AFTER the main answer finished streaming so it
// doesn't delay first-token latency; the user reads the answer while
// the chips populate ~300ms later.
//
// Failure is silent — chips just don't appear, which is fine.

import { getProvider } from "./provider.js";
import type { ChatMsg } from "./provider.js";
import type { Lang } from "./prompt.js";

const LANG_LABELS: Record<Lang, string> = {
  en: "English",
  hi: "Hindi (हिन्दी)",
  mr: "Marathi (मराठी)",
};

// Soft fallback when the model produces an empty / unparseable list.
// Generic enough to nudge any conversation forward without sounding
// like an error message.
const FALLBACK_EN = [
  "What events are coming up?",
  "How do I check my CPE balance?",
  "Show me the latest newsletter.",
];

/**
 * Ask the model for short follow-up questions based on the just-given
 * answer. Returns at most 3 questions, language-matched to the user's.
 * NEVER throws — returns the empty list on any error.
 */
export async function suggestFollowUps(opts: {
  question: string;
  answer: string;
  lang: Lang;
}): Promise<string[]> {
  const provider = getProvider();
  // Dev-echo isn't a real model — return the static fallback so the
  // UI has something to render.
  if (provider.mode === "dev-echo") return FALLBACK_EN.slice(0, 3);
  // Answer was empty (e.g. tool-loop bailed) — no useful follow-ups.
  if (!opts.answer || opts.answer.trim().length < 10) return [];

  const langLabel = LANG_LABELS[opts.lang] ?? LANG_LABELS.en;

  const messages: ChatMsg[] = [
    {
      role: "system",
      content: [
        "You suggest natural follow-up questions for an ICAI Nagpur Branch",
        "Q&A assistant.",
        "",
        "Given the user's question and the assistant's answer, output exactly",
        "three short follow-up questions a real visitor might want to ask next.",
        "",
        "Rules:",
        "- One question per line. No numbering, no bullets, no quotes.",
        "- Keep each under 12 words.",
        `- Reply in ${langLabel}.`,
        "- Stay within ICAI / branch portal topics: events, CPE, members,",
        "  students, committees, resources, newsletters, grievances, etc.",
        "- Vary the questions — explore different facets of the topic.",
        "- Do not repeat the user's question.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `USER QUESTION:\n${opts.question}\n\nANSWER:\n${opts.answer.slice(0, 1200)}`,
    },
  ];

  try {
    let out = "";
    for await (const chunk of provider.generateStream(messages, { maxTokens: 180 })) {
      if (chunk.delta) out += chunk.delta;
    }
    const questions = out
      .split("\n")
      .map((line) => line.trim()
        .replace(/^[-*•\d.)\s]+/, "")     // strip leading bullets / numbering
        .replace(/^["'`]|["'`]$/g, "")    // strip surrounding quotes
        .trim())
      .filter((q) => q.length >= 6 && q.length <= 140)
      .slice(0, 3);

    return questions.length > 0 ? questions : [];
  } catch {
    return [];
  }
}
