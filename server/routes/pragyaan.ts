// Pragyaan AI — public chat routes (FIN-151), mounted at /api/pragyaan.
//
// Endpoints (all anon-allowed; the caller's KB scopes are ALWAYS derived
// server-side via resolveRequestScopes — a client can never widen its access):
//
//   POST /chat               — streamed grounded answer (text/event-stream).
//   GET  /starters           — role-keyed suggested questions (static).
//   GET  /conversations/:id  — history, visible to its owner (user or anon).
//   GET  /config             — disclaimer text + supported languages.
//   POST /feedback           — thumbs up/down on an answer (guarded; the
//                              kb_feedback table lands in migration 0038, so a
//                              missing relation returns 503 instead of crashing).
//
// Streaming frame format (SSE over text/event-stream):
//   event: token\n data: {"delta":"…"}\n\n         (one per token slice)
//   event: done\n  data: {"conversationId","messageId","citations","noAnswer","lang"}\n\n
//   event: error\n data: {"error":"…"}\n\n           (on mid-stream failure)
//
// Rate limiting: anon callers are limited by IP at PRAGYAAN_ANON_RATE_PER_MIN;
// authenticated callers get the higher PRAGYAAN_USER_RATE_PER_MIN, keyed by
// user id. One limiter, per-request limit + key (express-rate-limit v8).

import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { asc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { kbConversations, kbMessages } from "../../schema/index.js";
import { SESSION_COOKIE, getUserBySessionToken } from "../auth/jwt.js";
import type { AuthedRequest } from "../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { resolveRequestScopes } from "../lib/pragyaan/scope.js";
import { answerQuestion } from "../lib/pragyaan/answer.js";
import { SUPPORTED_LANGS } from "../lib/pragyaan/prompt.js";
import { pragyaanConfig } from "../lib/pragyaan/config.js";

export const pragyaanRouter = Router();

// ─── disclaimer + language config (also served by GET /config) ──────────────
const DISCLAIMER =
  "Pragyaan is an AI assistant that answers from the ICAI Nagpur Branch knowledge base. " +
  "Responses are general information, not professional, legal, or financial advice, and may be " +
  "incomplete or out of date. Verify important details with the branch before acting.";

// ─── optional auth ──────────────────────────────────────────────────────────
// Anon is allowed everywhere here, but if a valid session cookie is present we
// attach req.user so scope resolution + ownership checks see the real role.
// Never rejects — a bad/absent token simply leaves the caller anonymous.
async function optionalAuth(req: AuthedRequest, _res: unknown, next: (e?: unknown) => void) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) {
      const user = await getUserBySessionToken(token);
      if (user) req.user = user;
    }
  } catch {
    // ignore — treat as anonymous
  }
  next();
}

// ─── rate limiter (anon-by-IP vs authed-by-user) ────────────────────────────
// Runs after optionalAuth so req.user is populated. The per-request `limit`
// and `keyGenerator` switch on whether the caller is authenticated.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  limit: (req) => {
    const authed = !!(req as AuthedRequest).user;
    return authed ? pragyaanConfig.userRatePerMin : pragyaanConfig.anonRatePerMin;
  },
  keyGenerator: (req) => {
    const user = (req as AuthedRequest).user;
    // ipKeyGenerator normalises IPv6 into a /56 subnet key (v8 requirement);
    // authed callers are keyed by their stable user id instead.
    return user ? `u:${user.id}` : `ip:${ipKeyGenerator(req.ip ?? "")}`;
  },
  message: {
    error: "rate_limited",
    message: "Too many requests. Please wait a moment and try again.",
  },
});

// Lighter limiter for feedback — stops a client spamming the chairman review
// queue with thumbs. Keyed like the chat limiter (user id when authed, else IP).
const feedbackLimiter = rateLimit({
  windowMs: 60 * 1000,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  limit: 20,
  keyGenerator: (req) => {
    const user = (req as AuthedRequest).user;
    return user ? `u:${user.id}` : `ip:${ipKeyGenerator(req.ip ?? "")}`;
  },
  message: { error: "rate_limited", message: "Too many feedback submissions. Please wait a moment." },
});

// ─── role-keyed starter questions (static; no table — P1-2) ─────────────────
// Keyed by the coarse role the frontend already knows. The route returns the
// matching bucket plus the shared "common" set so every visitor sees something.
const STARTERS: Record<string, string[]> = {
  common: [
    "What CPE events are coming up at the Nagpur branch?",
    "How do I register for a branch event?",
    "Where can I find the latest branch newsletter?",
    "How do I contact the branch office?",
  ],
  student: [
    "What are the articleship registration steps?",
    "When are the next CA exam dates?",
    "What student resources does the branch offer?",
    "How do I get my CPE/ITT details?",
  ],
  member: [
    "How do I claim CPE hours for an attended event?",
    "What member benefits does the branch provide?",
    "How do I update my membership details?",
    "Where are the latest professional standards circulars?",
  ],
  employer: [
    "How can my firm post a job opening?",
    "How do I recruit articled assistants through the branch?",
    "What employer services does the branch offer?",
  ],
};

// ─── SSE helpers ────────────────────────────────────────────────────────────
function sseFrame(res: import("express").Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ─── POST /chat ──────────────────────────────────────────────────────────────
// Body: { message, conversationId?, anonId?, lang? }. Streams the answer as SSE.
pragyaanRouter.post("/chat", optionalAuth, chatLimiter, async (req: AuthedRequest, res, next) => {
  // Validate before opening the stream so input errors return a normal JSON
  // 4xx (not a half-open event-stream).
  let question: string;
  let lang: string | null;
  let conversationId: string | null;
  let anonId: string | null;
  try {
    question = need(trim(req.body?.message), "message");
    if (question.length > 4000) throw new ApiError(400, "Message is too long (max 4000 chars)");
    lang = trim(req.body?.lang) || null;
    conversationId = trim(req.body?.conversationId) || null;
    anonId = trim(req.body?.anonId) || null;
  } catch (err) {
    return handleApiError(err, res, next);
  }

  let scopes;
  let roleLabel: string;
  try {
    ({ scopes, roleLabel } = await resolveRequestScopes(req));
  } catch (err) {
    return handleApiError(err, res, next);
  }

  // Open the event stream. Disable proxy buffering so tokens flush promptly.
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  try {
    const gen = answerQuestion({
      question,
      scopes,
      userId: req.user?.id ?? null,
      anonId,
      conversationId,
      lang,
      roleLabel,
    });

    let result;
    while (true) {
      const step = await gen.next();
      if (step.done) {
        result = step.value;
        break;
      }
      sseFrame(res, "token", { delta: step.value.delta });
    }

    sseFrame(res, "done", {
      conversationId: result.conversationId,
      messageId: result.messageId,
      citations: result.citations,
      follow_ups: result.followUps,
      noAnswer: result.noAnswer,
      lang: result.lang,
    });
    res.end();
  } catch (err) {
    // Headers are already sent — surface the failure as an SSE error frame
    // rather than throwing into the (now-useless) JSON error handler.
    // eslint-disable-next-line no-console
    console.error("[pragyaan] /chat stream failed", err);
    sseFrame(res, "error", { error: "generation_failed" });
    res.end();
  }
});

// ─── GET /starters ────────────────────────────────────────────────────────────
// Role-based suggested questions. The role hint comes from the session (server
// derived); visitors get the common set only.
pragyaanRouter.get("/starters", optionalAuth, async (req: AuthedRequest, res, next) => {
  try {
    const role = req.user?.primary_role ?? null;
    const bucket = (role && STARTERS[role]) || [];
    res.set("cache-control", "public, max-age=300");
    res.json({ role: role ?? "visitor", starters: [...STARTERS.common, ...bucket] });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /conversations/:id ────────────────────────────────────────────────────
// History for one conversation, visible only to its owner: the authenticated
// user whose id matches, or an anonymous caller supplying the matching anonId
// (?anonId=… query param). Anything else is 404 (don't leak existence).
pragyaanRouter.get("/conversations/:id", optionalAuth, async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    if (!id) throw new ApiError(400, "conversation id is required");

    const [conv] = await db
      .select({
        id: kbConversations.id,
        user_id: kbConversations.user_id,
        anon_id: kbConversations.anon_id,
        lang: kbConversations.lang,
        title: kbConversations.title,
        started_at: kbConversations.started_at,
        last_activity_at: kbConversations.last_activity_at,
      })
      .from(kbConversations)
      .where(eq(kbConversations.id, id))
      .limit(1);

    if (!conv) throw new ApiError(404, "Conversation not found");

    const anonId = trim(req.query.anonId) || null;
    const ownedByUser = req.user != null && conv.user_id === req.user.id;
    const ownedByAnon = req.user == null && anonId != null && conv.anon_id === anonId;
    if (!ownedByUser && !ownedByAnon) {
      throw new ApiError(404, "Conversation not found");
    }

    const messages = await db
      .select({
        id: kbMessages.id,
        role: kbMessages.role,
        content: kbMessages.content,
        citations: kbMessages.citations,
        created_at: kbMessages.created_at,
      })
      .from(kbMessages)
      .where(eq(kbMessages.conversation_id, id))
      .orderBy(asc(kbMessages.created_at));

    res.json({
      conversation: {
        id: conv.id,
        lang: conv.lang,
        title: conv.title,
        started_at: conv.started_at,
        last_activity_at: conv.last_activity_at,
      },
      messages,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /config ──────────────────────────────────────────────────────────────
// Disclaimer text + supported languages for the chat UI.
pragyaanRouter.get("/config", (_req, res, next) => {
  try {
    res.set("cache-control", "public, max-age=300");
    res.json({
      disclaimer: DISCLAIMER,
      languages: [...SUPPORTED_LANGS],
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /feedback ────────────────────────────────────────────────────────────
// { messageId, rating:'up'|'down', comment? } → kb_feedback. The table is
// created in migration 0038; until then the insert hits a missing relation,
// which we translate into a 503 "not yet available" rather than a crash.
pragyaanRouter.post("/feedback", optionalAuth, feedbackLimiter, async (req: AuthedRequest, res, next) => {
  try {
    const messageId = need(trim(req.body?.messageId), "messageId");
    const rating = trim(req.body?.rating);
    if (rating !== "up" && rating !== "down") {
      throw new ApiError(400, "rating must be 'up' or 'down'");
    }
    const comment = trim(req.body?.comment) || null;
    if (comment && comment.length > 2000) {
      throw new ApiError(400, "Comment is too long (max 2000 chars)");
    }

    try {
      await db.execute(sqlFeedbackInsert(messageId, rating, comment, req.user?.id ?? null));
    } catch (err) {
      if (isMissingRelation(err)) {
        throw new ApiError(503, "Feedback is not available yet. Please try again later.");
      }
      throw err;
    }

    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// Build the kb_feedback insert as raw SQL — the Drizzle model lands with
// migration 0038, so we don't import it here. Parameters are bound (no
// interpolation), so this is injection-safe.
function sqlFeedbackInsert(messageId: string, rating: string, comment: string | null, userId: string | null) {
  return sql`
    INSERT INTO kb_feedback (message_id, rating, comment, user_id)
    VALUES (${messageId}, ${rating}, ${comment}, ${userId})
  `;
}

/** Postgres "undefined_table" (relation does not exist) — table not migrated yet. */
function isMissingRelation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "42P01") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /relation .* does not exist/i.test(msg);
}
