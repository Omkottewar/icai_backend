import { Router } from "express";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  studentSuggestions,
  studentSuggestionTopics,
  studentSuggestionVotes,
  users,
} from "../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { optionalUser, requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { sameOrigin } from "../middleware/sameOrigin.js";

// Public + authed surface for the student-suggestions feature.
//
// Routes:
//   GET    /api/student-suggestions/topics         (public)
//   GET    /api/student-suggestions/top            (public)  — N most-upvoted approved
//   GET    /api/student-suggestions                (public)  — paginated, filterable
//   POST   /api/student-suggestions                (authed)  — submit a new suggestion
//   POST   /api/student-suggestions/:id/vote       (authed)  — upvote (idempotent)
//   DELETE /api/student-suggestions/:id/vote       (authed)  — remove vote
//   GET    /api/student-suggestions/mine           (authed)  — my submissions + status
//
// Admin endpoints (moderation, topic CRUD) live in routes/admin/studentSuggestions.ts.

export const studentSuggestionsRouter = Router();

// ─── Helpers ────────────────────────────────────────────────────────────────

const SUBMISSIONS_PER_WEEK_CAP = 3;
const MAX_BODY_CHARS = 280;

/**
 * Subquery that yields each suggestion's net vote count + the requesting
 * user's vote state. Used everywhere we render suggestions for the UI so
 * the upvote pill knows whether to show as "active".
 */
function suggestionSelectFields(viewerId: string | null) {
  return {
    id:         studentSuggestions.id,
    body:       studentSuggestions.body,
    status:     studentSuggestions.status,
    created_at: studentSuggestions.created_at,
    reviewed_at: studentSuggestions.reviewed_at,
    reject_reason: studentSuggestions.reject_reason,
    topic_id:   studentSuggestions.topic_id,
    topic_code: studentSuggestionTopics.code,
    topic_name: studentSuggestionTopics.name,
    author_name: users.name,
    vote_count: sql<number>`(
      SELECT COUNT(*)::int FROM ${studentSuggestionVotes}
      WHERE ${studentSuggestionVotes.suggestion_id} = ${studentSuggestions.id}
    )`.as("vote_count"),
    my_vote: viewerId
      ? sql<boolean>`EXISTS (
          SELECT 1 FROM ${studentSuggestionVotes}
          WHERE ${studentSuggestionVotes.suggestion_id} = ${studentSuggestions.id}
            AND ${studentSuggestionVotes.user_id} = ${viewerId}
        )`.as("my_vote")
      : sql<boolean>`false`.as("my_vote"),
  };
}

// ─── GET /topics ────────────────────────────────────────────────────────────

studentSuggestionsRouter.get("/topics", async (_req, res, next) => {
  try {
    const rows = await db
      .select({
        id:          studentSuggestionTopics.id,
        code:        studentSuggestionTopics.code,
        name:        studentSuggestionTopics.name,
        description: studentSuggestionTopics.description,
      })
      .from(studentSuggestionTopics)
      .where(eq(studentSuggestionTopics.active, true))
      .orderBy(asc(studentSuggestionTopics.sort_order), asc(studentSuggestionTopics.name));
    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /top — for the home WICASA card ────────────────────────────────────

studentSuggestionsRouter.get("/top", optionalUser, async (req: AuthedRequest, res, next) => {
  try {
    const limit = Math.min(10, Math.max(1, Number(req.query.limit) || 3));
    const viewerId = req.user?.id ?? null;

    const rows = await db
      .select(suggestionSelectFields(viewerId))
      .from(studentSuggestions)
      .leftJoin(studentSuggestionTopics, eq(studentSuggestionTopics.id, studentSuggestions.topic_id))
      .leftJoin(users, eq(users.id, studentSuggestions.user_id))
      .where(and(
        eq(studentSuggestions.status, "approved"),
        isNull(studentSuggestions.deleted_at),
      ))
      .orderBy(desc(sql`vote_count`), desc(studentSuggestions.created_at))
      .limit(limit);

    // Cache for 60 s — home page hits this often. Cache key is viewer-aware
    // via the cookie so my-vote stays correct per user.
    if (!viewerId) res.set("cache-control", "public, max-age=60");
    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET / — paginated browse (with filter + sort) ──────────────────────────

studentSuggestionsRouter.get("/", optionalUser, async (req: AuthedRequest, res, next) => {
  try {
    const viewerId = req.user?.id ?? null;
    const topicCode = trim(req.query.topic);
    const sortKey   = trim(req.query.sort) || "votes"; // 'votes' | 'recent'
    const q         = trim(req.query.q);
    const page      = Math.max(1, Number(req.query.page) || 1);
    const pageSize  = Math.min(50, Math.max(10, Number(req.query.pageSize) || 20));
    const offset    = (page - 1) * pageSize;

    const conds: any[] = [
      eq(studentSuggestions.status, "approved"),
      isNull(studentSuggestions.deleted_at),
    ];
    if (topicCode) conds.push(eq(studentSuggestionTopics.code, topicCode));
    if (q) conds.push(ilike(studentSuggestions.body, `%${q}%`));

    const where = and(...conds);

    const orderBy = sortKey === "recent"
      ? [desc(studentSuggestions.created_at)]
      : [desc(sql`vote_count`), desc(studentSuggestions.created_at)];

    const [rows, [{ total }]] = await Promise.all([
      db.select(suggestionSelectFields(viewerId))
        .from(studentSuggestions)
        .leftJoin(studentSuggestionTopics, eq(studentSuggestionTopics.id, studentSuggestions.topic_id))
        .leftJoin(users, eq(users.id, studentSuggestions.user_id))
        .where(where)
        .orderBy(...orderBy)
        .limit(pageSize)
        .offset(offset),
      db.select({ total: sql<number>`COUNT(*)::int` })
        .from(studentSuggestions)
        .leftJoin(studentSuggestionTopics, eq(studentSuggestionTopics.id, studentSuggestions.topic_id))
        .where(where),
    ]);

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST / — submit a new suggestion ───────────────────────────────────────

studentSuggestionsRouter.post("/", requireUser, sameOrigin, async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.user!.id;

    const topic_id = need(trim(req.body?.topic_id), "Topic");
    const body     = need(trim(req.body?.body), "Body");
    if (body.length > MAX_BODY_CHARS) {
      throw new ApiError(400, `Suggestion is too long (max ${MAX_BODY_CHARS} characters).`);
    }

    // Validate the topic exists + is active so a stale UI can't submit
    // against a topic the admin just disabled.
    const [topic] = await db.select({ id: studentSuggestionTopics.id })
      .from(studentSuggestionTopics)
      .where(and(eq(studentSuggestionTopics.id, topic_id), eq(studentSuggestionTopics.active, true)))
      .limit(1);
    if (!topic) throw new ApiError(400, "That topic is no longer available. Pick another.");

    // Rate-limit: at most N suggestions per rolling 7-day window per user.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [{ recent }] = await db
      .select({ recent: sql<number>`COUNT(*)::int` })
      .from(studentSuggestions)
      .where(and(
        eq(studentSuggestions.user_id, userId),
        gt(studentSuggestions.created_at, sevenDaysAgo),
      ));
    if (recent >= SUBMISSIONS_PER_WEEK_CAP) {
      throw new ApiError(429, `You've submitted ${recent} suggestions in the last 7 days. ` +
        `Limit is ${SUBMISSIONS_PER_WEEK_CAP} per week.`);
    }

    const [row] = await db.insert(studentSuggestions).values({
      topic_id,
      user_id: userId,
      body,
      status: "pending",
    }).returning();

    res.status(201).json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /:id/vote — upvote (idempotent) ───────────────────────────────────

studentSuggestionsRouter.post("/:id/vote", requireUser, sameOrigin, async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const id = String(req.params.id);

    // Only approved, non-deleted suggestions accept votes — prevents
    // upvoting your own pending row before moderation, and prevents
    // votes piling up on rejected items.
    const [target] = await db.select({ id: studentSuggestions.id })
      .from(studentSuggestions)
      .where(and(
        eq(studentSuggestions.id, id),
        eq(studentSuggestions.status, "approved"),
        isNull(studentSuggestions.deleted_at),
      ))
      .limit(1);
    if (!target) throw new ApiError(404, "Suggestion not available for voting");

    await db.insert(studentSuggestionVotes)
      .values({ suggestion_id: id, user_id: userId })
      .onConflictDoNothing();

    const [{ count }] = await db.select({ count: sql<number>`COUNT(*)::int` })
      .from(studentSuggestionVotes)
      .where(eq(studentSuggestionVotes.suggestion_id, id));

    res.json({ ok: true, voted: true, vote_count: count });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /:id/vote — remove vote ─────────────────────────────────────────

studentSuggestionsRouter.delete("/:id/vote", requireUser, sameOrigin, async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const id = String(req.params.id);
    await db.delete(studentSuggestionVotes).where(and(
      eq(studentSuggestionVotes.suggestion_id, id),
      eq(studentSuggestionVotes.user_id, userId),
    ));
    const [{ count }] = await db.select({ count: sql<number>`COUNT(*)::int` })
      .from(studentSuggestionVotes)
      .where(eq(studentSuggestionVotes.suggestion_id, id));
    res.json({ ok: true, voted: false, vote_count: count });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /mine — my submissions including pending/rejected ─────────────────

studentSuggestionsRouter.get("/mine", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const rows = await db
      .select({
        id:           studentSuggestions.id,
        body:         studentSuggestions.body,
        status:       studentSuggestions.status,
        topic_id:     studentSuggestions.topic_id,
        topic_code:   studentSuggestionTopics.code,
        topic_name:   studentSuggestionTopics.name,
        reject_reason: studentSuggestions.reject_reason,
        reviewed_at:  studentSuggestions.reviewed_at,
        created_at:   studentSuggestions.created_at,
        vote_count:   sql<number>`(
          SELECT COUNT(*)::int FROM ${studentSuggestionVotes}
          WHERE ${studentSuggestionVotes.suggestion_id} = ${studentSuggestions.id}
        )`.as("vote_count"),
      })
      .from(studentSuggestions)
      .leftJoin(studentSuggestionTopics, eq(studentSuggestionTopics.id, studentSuggestions.topic_id))
      .where(and(
        eq(studentSuggestions.user_id, userId),
        isNull(studentSuggestions.deleted_at),
      ))
      .orderBy(desc(studentSuggestions.created_at));
    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});
