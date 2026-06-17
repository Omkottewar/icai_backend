// Pragyaan AI — answer orchestration (FIN-151).
//
// The single entry point routes call to answer a question. It ties the
// pipeline together:
//
//   retrieve (scope-filtered ANN)  →  buildMessages (grounded prompt)
//     →  provider.generateStream (token deltas)  →  persist + citations
//
// `answerQuestion` returns an async generator that yields token deltas as they
// arrive, then `return`s a final summary ({conversationId, messageId,
// citations, noAnswer}). The route drains the generator to stream SSE frames
// and uses the return value for the trailing `done` frame.
//
// Persistence: upsert the kb_conversation, insert the user + assistant
// kb_messages (with citations / model / tokens / latency), and — when the
// analytics table exists (migration 0038) — a kb_query_log row. The query-log
// insert is guarded: until 0038 is applied the relation is missing, so we
// swallow the "undefined_table" error and carry on. The conversation +
// messages are the durable record; analytics is best-effort.

import { sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { kbConversations, kbMessages } from "../../../schema/index.js";
import { getProvider } from "./provider.js";
import { retrieve } from "./retrieval.js";
import type { RetrievedChunk } from "./retrieval.js";
import { buildMessages, detectLang, noAnswerMessage } from "./prompt.js";
import type { Lang } from "./prompt.js";
import type { KbScope } from "./scope.js";

/** A citation surfaced to the client and stored on the assistant message. */
export interface Citation {
  /** kb_sources.id — dedupe key, also the citation's identity. */
  source_id: string;
  /** Source title (chip label). */
  title: string;
  /** Source URL deep-link, if any. */
  url: string | null;
  /** kb_chunks.id of the best-matching chunk for this source (deep-link hint). */
  chunk_id: string;
}

export interface AnswerInput {
  /** The user's question. */
  question: string;
  /** Caller's allowed scopes (from resolveRequestScopes — NEVER client-supplied). */
  scopes: Set<KbScope>;
  /** Authenticated user id, or null for an anonymous caller. */
  userId?: string | null;
  /** Stable anonymous id (client-persisted) for anon conversation ownership. */
  anonId?: string | null;
  /** Existing conversation to append to; a new one is created when absent. */
  conversationId?: string | null;
  /** Explicit reply language; detected from the question when omitted. */
  lang?: string | null;
  /** Role label for analytics (kb_query_log.role_label). */
  roleLabel?: string | null;
}

/** The generator's final return value — drives the SSE `done` frame. */
export interface AnswerResult {
  conversationId: string;
  messageId: string;
  citations: Citation[];
  noAnswer: boolean;
  lang: Lang;
}

/**
 * Dedupe retrieved chunks into citations, one per source, keeping the
 * highest-similarity chunk as the representative. `sources` arrives in
 * similarity order, so the first time we see a source_id is its best chunk.
 */
function toCitations(sources: RetrievedChunk[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of sources) {
    if (seen.has(c.sourceId)) continue;
    seen.add(c.sourceId);
    out.push({ source_id: c.sourceId, title: c.title, url: c.url, chunk_id: c.id });
  }
  return out;
}

/** Postgres "undefined_table" — the relation does not exist yet. */
function isMissingRelation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "42P01") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /relation .* does not exist/i.test(msg);
}

/**
 * Insert a kb_query_log analytics row. Guarded: the table only exists after
 * migration 0038, so a missing-relation error is swallowed (logged once at
 * debug level) rather than failing the answer. Any other error is logged but
 * also non-fatal — analytics must never break the chat path.
 */
async function logQuery(row: {
  conversationId: string;
  question: string;
  lang: Lang;
  roleLabel: string;
  scopeSet: KbScope[];
  noAnswer: boolean;
  topSimilarity: number | null;
  citationCount: number;
  model: string;
}): Promise<void> {
  try {
    await db.execute(sql`
      INSERT INTO kb_query_log
        (conversation_id, question, lang, role_label, scope_set,
         no_answer, top_similarity, citation_count, model)
      VALUES (
        ${row.conversationId},
        ${row.question},
        ${row.lang},
        ${row.roleLabel},
        ${row.scopeSet},
        ${row.noAnswer},
        ${row.topSimilarity},
        ${row.citationCount},
        ${row.model}
      )
    `);
  } catch (err) {
    if (isMissingRelation(err)) return; // kb_query_log not migrated yet — skip.
    // eslint-disable-next-line no-console
    console.error("[pragyaan] kb_query_log insert failed (non-fatal)", err);
  }
}

/**
 * Upsert the conversation row: reuse an existing one the caller owns, else
 * create a fresh one. Ownership is enforced — a conversationId that belongs to
 * a different user/anon is ignored and a new conversation is started, so a
 * caller can never write into someone else's thread.
 */
async function ensureConversation(input: {
  conversationId?: string | null;
  userId?: string | null;
  anonId?: string | null;
  lang: Lang;
  roleLabel: string;
}): Promise<string> {
  const { conversationId, userId, anonId, lang, roleLabel } = input;

  if (conversationId) {
    const [existing] = await db
      .select({ id: kbConversations.id, user_id: kbConversations.user_id, anon_id: kbConversations.anon_id })
      .from(kbConversations)
      .where(sql`${kbConversations.id} = ${conversationId}`)
      .limit(1);

    if (existing) {
      const ownedByUser = userId != null && existing.user_id === userId;
      const ownedByAnon = userId == null && anonId != null && existing.anon_id === anonId;
      if (ownedByUser || ownedByAnon) {
        await db
          .update(kbConversations)
          .set({ last_activity_at: new Date() })
          .where(sql`${kbConversations.id} = ${conversationId}`);
        return existing.id;
      }
      // Falls through to create a new conversation when ownership doesn't match.
    }
  }

  const [created] = await db
    .insert(kbConversations)
    .values({
      user_id: userId ?? null,
      anon_id: userId ? null : anonId ?? null,
      role_at_time: roleLabel,
      lang,
    })
    .returning({ id: kbConversations.id });
  return created!.id;
}

/**
 * Orchestrate a single answer turn. Returns an async generator that yields
 * `{ delta }` token slices as the model streams, then returns an AnswerResult.
 *
 * Flow:
 *   1. Resolve language, retrieve scope-filtered chunks.
 *   2. Ensure the conversation row + persist the user message.
 *   3a. No-answer (retrieval below threshold) → stream the localized line,
 *       persist it with empty citations, log, and return noAnswer=true.
 *   3b. Otherwise → buildMessages, stream the provider, accumulate the answer
 *       text + usage, persist the assistant message with citations + tokens +
 *       latency, log, and return the citations.
 */
export async function* answerQuestion(
  input: AnswerInput,
): AsyncGenerator<{ delta: string }, AnswerResult, void> {
  const started = Date.now();
  const provider = getProvider();
  const question = input.question.trim();
  const lang = detectLang(question, input.lang);
  const roleLabel = input.roleLabel ?? (input.userId ? "user" : "visitor");
  const scopeSet = [...input.scopes];

  const { chunks, topSimilarity, noAnswer } = await retrieve(question, input.scopes);

  const conversationId = await ensureConversation({
    conversationId: input.conversationId,
    userId: input.userId,
    anonId: input.anonId,
    lang,
    roleLabel,
  });

  // Persist the user's turn first so the thread reads in order even if
  // generation fails partway.
  await db.insert(kbMessages).values({
    conversation_id: conversationId,
    role: "user",
    content: question,
  });

  // ─── No-answer path ─────────────────────────────────────────────────────
  if (noAnswer || chunks.length === 0) {
    const message = noAnswerMessage(lang);
    yield { delta: message };

    const [assistant] = await db
      .insert(kbMessages)
      .values({
        conversation_id: conversationId,
        role: "assistant",
        content: message,
        citations: [],
        model: provider.chatModel,
        latency_ms: Date.now() - started,
      })
      .returning({ id: kbMessages.id });

    await logQuery({
      conversationId,
      question,
      lang,
      roleLabel,
      scopeSet,
      noAnswer: true,
      topSimilarity,
      citationCount: 0,
      model: provider.chatModel,
    });

    return { conversationId, messageId: assistant!.id, citations: [], noAnswer: true, lang };
  }

  // ─── Grounded answer path ───────────────────────────────────────────────
  const { messages, usedSources } = buildMessages({ question, lang, sources: chunks });
  const citations = toCitations(usedSources);

  let answerText = "";
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;

  for await (const part of provider.generateStream(messages)) {
    if (part.delta) {
      answerText += part.delta;
      yield { delta: part.delta };
    }
    if (part.usage) {
      tokensIn = part.usage.in;
      tokensOut = part.usage.out;
    }
  }

  const [assistant] = await db
    .insert(kbMessages)
    .values({
      conversation_id: conversationId,
      role: "assistant",
      content: answerText,
      citations,
      model: provider.chatModel,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      latency_ms: Date.now() - started,
    })
    .returning({ id: kbMessages.id });

  await logQuery({
    conversationId,
    question,
    lang,
    roleLabel,
    scopeSet,
    noAnswer: false,
    topSimilarity,
    citationCount: citations.length,
    model: provider.chatModel,
  });

  return { conversationId, messageId: assistant!.id, citations, noAnswer: false, lang };
}
