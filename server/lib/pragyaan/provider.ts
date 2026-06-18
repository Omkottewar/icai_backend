// Pragyaan AI — LLM provider abstraction (FIN-151).
//
// Two drivers ship:
//
//   OpenAIProvider   — real embeddings + streamed chat via the `openai` SDK.
//   DevEchoProvider  — used when OPENAI_API_KEY is blank. Deterministic
//                      hash-based pseudo-embeddings (stable per input text)
//                      and a canned grounded answer that quotes the supplied
//                      context. Lets the full retrieval/answer/log pipeline
//                      run offline with zero API spend.
//
// getProvider() picks the driver by env and is a module singleton — the
// "which mode" log line fires exactly once per process. Callers never
// instantiate a driver directly.

import OpenAI from "openai";
import { pragyaanConfig } from "./config.js";

// A single chat turn handed to the model. Mirrors the chat_role enum
// (user | assistant | system) used by kb_messages.
export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

// One streamed step. `delta` is an incremental token slice; `usage` (if
// present, typically on the final step) reports token counts so the caller
// can persist tokens_in / tokens_out on the assistant message.
export interface GenerateChunk {
  delta?: string;
  usage?: { in: number; out: number };
}

export interface PragyaanProvider {
  /** Embed a batch of texts (e.g. chunks at ingest). Order preserved. */
  embedTexts(texts: string[]): Promise<number[][]>;
  /** Embed a single query string at retrieval time. */
  embedQuery(text: string): Promise<number[]>;
  /** Stream a chat completion as incremental token deltas. */
  generateStream(
    messages: ChatMsg[],
    opts?: { maxTokens?: number },
  ): AsyncIterable<GenerateChunk>;
  /** Which driver is active. */
  readonly mode: "openai" | "dev-echo";
  /** The chat model id in use (echoed onto kb_messages.model). */
  readonly chatModel: string;
}

// ─── OpenAI driver ──────────────────────────────────────────────────────────
class OpenAIProvider implements PragyaanProvider {
  readonly mode = "openai" as const;
  readonly chatModel: string;
  private client: OpenAI;
  private embeddingModel: string;
  private dimensions: number;

  constructor() {
    this.client = new OpenAI({ apiKey: pragyaanConfig.openaiApiKey });
    this.chatModel = pragyaanConfig.chatModel;
    this.embeddingModel = pragyaanConfig.embeddingModel;
    this.dimensions = pragyaanConfig.embeddingDimensions;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.client.embeddings.create({
      model: this.embeddingModel,
      input: texts,
      dimensions: this.dimensions,
    });
    // The API returns one datum per input; sort by index defensively so the
    // returned order always matches the input order.
    return res.data
      .slice()
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding as number[]);
  }

  async embedQuery(text: string): Promise<number[]> {
    const [vec] = await this.embedTexts([text]);
    return vec ?? [];
  }

  async *generateStream(
    messages: ChatMsg[],
    opts?: { maxTokens?: number },
  ): AsyncIterable<GenerateChunk> {
    const stream = await this.client.chat.completions.create({
      model: this.chatModel,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(opts?.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    });

    for await (const part of stream) {
      const delta = part.choices?.[0]?.delta?.content;
      if (delta) yield { delta };
      // Usage arrives on the trailing chunk when include_usage is set.
      const usage = part.usage;
      if (usage) {
        yield {
          usage: {
            in: usage.prompt_tokens ?? 0,
            out: usage.completion_tokens ?? 0,
          },
        };
      }
    }
  }
}

// ─── Dev-echo driver ──────────────────────────────────────────────────────────
// Deterministic, offline, zero-spend stand-in. Embeddings are a stable
// pseudo-random vector seeded by the input text; identical text ⇒ identical
// vector (so retrieval is reproducible across runs). The answer extracts and
// quotes the supplied SOURCES so the grounding/citation pipeline can be
// exercised, or emits the no-answer line when no context was provided.

const DEV_NO_ANSWER =
  "I don't have information on that yet. If this topic may be members-only, try logging in. (dev-echo mode — set OPENAI_API_KEY for real answers.)";

class DevEchoProvider implements PragyaanProvider {
  readonly mode = "dev-echo" as const;
  readonly chatModel = "dev-echo";
  private dimensions: number;

  constructor() {
    this.dimensions = pragyaanConfig.embeddingDimensions;
  }

  async embedTexts(texts: string[]): Promise<number[][]> {
    return texts.map((t) => pseudoEmbedding(t, this.dimensions));
  }

  async embedQuery(text: string): Promise<number[]> {
    return pseudoEmbedding(text, this.dimensions);
  }

  async *generateStream(messages: ChatMsg[]): AsyncIterable<GenerateChunk> {
    // The orchestrator packs the numbered SOURCES into the user message; the
    // last user turn carries the assembled context. Quote the first source
    // line so the answer is visibly grounded, else return the no-answer line.
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const context = extractContext(lastUser?.content ?? "");

    const answer = context
      ? `Based on the available sources: "${context}" [1]`
      : DEV_NO_ANSWER;

    // Stream word-by-word so the SSE/stream-reader path is exercised exactly
    // as it would be for a real model.
    const words = answer.split(/(\s+)/);
    let outChars = 0;
    for (const w of words) {
      outChars += w.length;
      if (w) yield { delta: w };
    }
    // Rough token estimate (chars / 4) so kb_messages.tokens_* get populated.
    const inChars = messages.reduce((n, m) => n + m.content.length, 0);
    yield { usage: { in: Math.ceil(inChars / 4), out: Math.ceil(outChars / 4) } };
  }
}

// Pull a short, quotable excerpt out of the numbered-SOURCES block the
// orchestrator builds (`[n] <title>\n<content>`). Falls back to the first
// non-empty content line; returns "" when nothing usable is present.
function extractContext(prompt: string): string {
  const marker = prompt.indexOf("[1]");
  const region = marker >= 0 ? prompt.slice(marker) : prompt;
  for (const rawLine of region.split("\n")) {
    const line = rawLine.replace(/^\s*\[\d+\]\s*/, "").trim();
    if (line.length >= 12) return line.slice(0, 240);
  }
  return "";
}

// Deterministic pseudo-embedding: a small xorshift PRNG seeded from a stable
// hash of the text, producing an L2-normalised vector of `dim` floats. Not
// semantically meaningful — just stable and well-shaped for cosine search.
function pseudoEmbedding(text: string, dim: number): number[] {
  let h = 2166136261 >>> 0; // FNV-1a seed
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let state = h || 1;
  const next = () => {
    // xorshift32
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;  state >>>= 0;
    return state / 0xffffffff; // 0..1
  };

  const vec = new Array<number>(dim);
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    const v = next() * 2 - 1; // -1..1
    vec[i] = v;
    norm += v * v;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) vec[i] = vec[i] / norm;
  return vec;
}

// ─── Singleton selection ──────────────────────────────────────────────────────
let _provider: PragyaanProvider | null = null;

export function getProvider(): PragyaanProvider {
  if (_provider) return _provider;

  if (pragyaanConfig.openaiApiKey) {
    _provider = new OpenAIProvider();
    // eslint-disable-next-line no-console
    console.log(`Pragyaan: OpenAI mode (chat=${pragyaanConfig.chatModel || "<unset OPENAI_CHAT_MODEL>"}, embed=${pragyaanConfig.embeddingModel})`);
  } else {
    _provider = new DevEchoProvider();
    // eslint-disable-next-line no-console
    console.log("Pragyaan: DEV-ECHO mode (set OPENAI_API_KEY for real answers)");
  }
  return _provider;
}
