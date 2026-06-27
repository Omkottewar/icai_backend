import { Router } from "express";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import {
  studentSuggestions,
  studentSuggestionTopics,
  studentSuggestionVotes,
  users,
  branches,
} from "../../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";

// Admin moderation + topic CRUD for student suggestions.
//
// Routes:
//   GET    /api/admin/student-suggestions?status=pending  — moderation queue
//   POST   /api/admin/student-suggestions/:id/approve
//   POST   /api/admin/student-suggestions/:id/reject  { reason }
//   DELETE /api/admin/student-suggestions/:id          — soft-delete
//
//   GET    /api/admin/student-suggestion-topics        — list all (incl. inactive)
//   POST   /api/admin/student-suggestion-topics        — create
//   PATCH  /api/admin/student-suggestion-topics/:id    — update
//   DELETE /api/admin/student-suggestion-topics/:id    — delete (only if no
//                                                       suggestions reference it)

export const studentSuggestionsAdminRouter = Router();
export const studentSuggestionTopicsAdminRouter = Router();

// ─── Moderation queue ───────────────────────────────────────────────────────

studentSuggestionsAdminRouter.get("/", async (req, res, next) => {
  try {
    const status = trim(req.query.status) || "pending";
    if (!["pending", "approved", "rejected", "archived"].includes(status)) {
      throw new ApiError(400, "Invalid status filter");
    }

    const rows = await db
      .select({
        id:           studentSuggestions.id,
        body:         studentSuggestions.body,
        status:       studentSuggestions.status,
        reject_reason: studentSuggestions.reject_reason,
        created_at:   studentSuggestions.created_at,
        reviewed_at:  studentSuggestions.reviewed_at,
        topic_id:     studentSuggestions.topic_id,
        topic_name:   studentSuggestionTopics.name,
        author_id:    users.id,
        author_name:  users.name,
        author_email: users.email,
        vote_count:   sql<number>`(
          SELECT COUNT(*)::int FROM ${studentSuggestionVotes}
          WHERE ${studentSuggestionVotes.suggestion_id} = ${studentSuggestions.id}
        )`.as("vote_count"),
      })
      .from(studentSuggestions)
      .leftJoin(studentSuggestionTopics, eq(studentSuggestionTopics.id, studentSuggestions.topic_id))
      .leftJoin(users, eq(users.id, studentSuggestions.user_id))
      .where(and(
        eq(studentSuggestions.status, status as any),
        isNull(studentSuggestions.deleted_at),
      ))
      .orderBy(desc(studentSuggestions.created_at));

    // Per-status counters so the admin tabs can show badge numbers
    // without a second round-trip.
    const counts = await db
      .select({ status: studentSuggestions.status, count: sql<number>`COUNT(*)::int` })
      .from(studentSuggestions)
      .where(isNull(studentSuggestions.deleted_at))
      .groupBy(studentSuggestions.status);
    const countsByStatus: Record<string, number> = {};
    for (const c of counts) countsByStatus[c.status] = c.count;

    res.json({ rows, counts: countsByStatus });
  } catch (err) { handleApiError(err, res, next); }
});

studentSuggestionsAdminRouter.post("/:id/approve", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.update(studentSuggestions)
      .set({
        status: "approved",
        reviewed_by: req.user!.id,
        reviewed_at: new Date(),
        reject_reason: null,
        updated_at: new Date(),
      })
      .where(and(eq(studentSuggestions.id, id), isNull(studentSuggestions.deleted_at)))
      .returning();
    if (!row) throw new ApiError(404, "Suggestion not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

studentSuggestionsAdminRouter.post("/:id/reject", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const reason = need(trim(req.body?.reason), "Reason");
    const [row] = await db.update(studentSuggestions)
      .set({
        status: "rejected",
        reviewed_by: req.user!.id,
        reviewed_at: new Date(),
        reject_reason: reason,
        updated_at: new Date(),
      })
      .where(and(eq(studentSuggestions.id, id), isNull(studentSuggestions.deleted_at)))
      .returning();
    if (!row) throw new ApiError(404, "Suggestion not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

studentSuggestionsAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.update(studentSuggestions)
      .set({ deleted_at: new Date() })
      .where(and(eq(studentSuggestions.id, id), isNull(studentSuggestions.deleted_at)))
      .returning();
    if (!row) throw new ApiError(404, "Suggestion not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Topic CRUD ─────────────────────────────────────────────────────────────

function normCode(v: unknown): string {
  return String(v ?? "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 32);
}

studentSuggestionTopicsAdminRouter.get("/", async (_req, res, next) => {
  try {
    const rows = await db
      .select({
        id:           studentSuggestionTopics.id,
        code:         studentSuggestionTopics.code,
        name:         studentSuggestionTopics.name,
        description:  studentSuggestionTopics.description,
        active:       studentSuggestionTopics.active,
        sort_order:   studentSuggestionTopics.sort_order,
        suggestions_count: sql<number>`(
          SELECT COUNT(*)::int FROM ${studentSuggestions}
          WHERE ${studentSuggestions.topic_id} = ${studentSuggestionTopics.id}
            AND ${studentSuggestions.deleted_at} IS NULL
        )`.as("suggestions_count"),
      })
      .from(studentSuggestionTopics)
      .orderBy(asc(studentSuggestionTopics.sort_order), asc(studentSuggestionTopics.name));
    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

studentSuggestionTopicsAdminRouter.post("/", async (req, res, next) => {
  try {
    const code = normCode(req.body?.code);
    const name = need(trim(req.body?.name), "Name");
    if (!code) throw new ApiError(400, "Code must be lowercase letters/digits/underscore");

    // Default to the NGP branch — UI doesn't need to expose branch picker
    // for now (single-branch deployment). If multi-branch later, take from req.
    const [branch] = await db.select({ id: branches.id })
      .from(branches).where(eq(branches.code, "NGP")).limit(1);
    if (!branch) throw new ApiError(400, "Branch NGP not configured yet");

    const description = trim(req.body?.description) || null;
    const sort_order  = Number.isFinite(Number(req.body?.sort_order))
      ? Math.trunc(Number(req.body.sort_order)) : 0;

    try {
      const [row] = await db.insert(studentSuggestionTopics).values({
        branch_id: branch.id, code, name, description, sort_order, active: true,
      }).returning();
      res.status(201).json({ item: row });
    } catch (e: any) {
      if (e?.code === "23505") throw new ApiError(409, "A topic with that code already exists");
      throw e;
    }
  } catch (err) { handleApiError(err, res, next); }
});

studentSuggestionTopicsAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const patch: Record<string, any> = {};
    if (req.body?.name        !== undefined) patch.name        = need(trim(req.body.name), "Name");
    if (req.body?.description !== undefined) patch.description = trim(req.body.description) || null;
    if (req.body?.active      !== undefined) patch.active      = !!req.body.active;
    if (req.body?.sort_order  !== undefined) {
      const n = Number(req.body.sort_order);
      if (!Number.isFinite(n)) throw new ApiError(400, "sort_order must be a number");
      patch.sort_order = Math.trunc(n);
    }
    if (Object.keys(patch).length === 0) throw new ApiError(400, "Nothing to update");

    const [row] = await db.update(studentSuggestionTopics)
      .set(patch)
      .where(eq(studentSuggestionTopics.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Topic not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

studentSuggestionTopicsAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    // Refuse if any suggestions still reference this topic — admin should
    // reassign or soft-delete those first to keep the audit trail clean.
    const [{ count }] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(studentSuggestions)
      .where(and(
        eq(studentSuggestions.topic_id, id),
        isNull(studentSuggestions.deleted_at),
      ));
    if (count > 0) {
      throw new ApiError(400,
        `Cannot delete — ${count} suggestion${count === 1 ? "" : "s"} still use this topic. ` +
        `Mark them as archived first, or set the topic inactive instead.`,
      );
    }
    await db.delete(studentSuggestionTopics).where(eq(studentSuggestionTopics.id, id));
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
