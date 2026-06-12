import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { articleshipMatches, users, events, firms } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const articleshipMatchesAdminRouter = Router();

const STATUSES = ["submitted", "matched", "placed", "cancelled"] as const;
type Status = typeof STATUSES[number];

// ─── GET /api/admin/articleship-matches ───────────────────────────────────
articleshipMatchesAdminRouter.get("/", async (req, res, next) => {
  try {
    const status = trim(req.query.status);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const conds = [] as any[];
    if (status && STATUSES.includes(status as Status)) conds.push(eq(articleshipMatches.status, status));

    const rows = await db
      .select({
        id:                       articleshipMatches.id,
        status:                   articleshipMatches.status,
        preferred_specialisations: articleshipMatches.preferred_specialisations,
        preferred_location:       articleshipMatches.preferred_location,
        preferred_firm_size:      articleshipMatches.preferred_firm_size,
        expected_stipend_paise:   articleshipMatches.expected_stipend_paise,
        recommended_firm_ids:     articleshipMatches.recommended_firm_ids,
        placed_firm_id:           articleshipMatches.placed_firm_id,
        notes:                    articleshipMatches.notes,
        created_at:               articleshipMatches.created_at,
        student_user_id:          articleshipMatches.student_user_id,
        student_name:             users.name,
        student_email:            users.email,
        seminar_event_id:         articleshipMatches.seminar_event_id,
        seminar_event_title:      events.title,
        placed_firm_name:         firms.name,
      })
      .from(articleshipMatches)
      .leftJoin(users,  eq(users.id, articleshipMatches.student_user_id))
      .leftJoin(events, eq(events.id, articleshipMatches.seminar_event_id))
      .leftJoin(firms,  eq(firms.id,  articleshipMatches.placed_firm_id))
      .where(conds.length ? and(...conds) : sql`true`)
      .orderBy(desc(articleshipMatches.created_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(articleshipMatches)
      .where(conds.length ? and(...conds) : sql`true`);

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/articleship-matches/:id/recommend ────────────────────
// WICASA reviews the submission, optionally adjusts the recommended firm list,
// and flips status to 'matched'.
articleshipMatchesAdminRouter.post("/:id/recommend", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Match ID");
    const firms = Array.isArray(req.body?.recommended_firm_ids) ? req.body.recommended_firm_ids : null;
    if (!firms || firms.length === 0) throw new ApiError(400, "Provide at least one recommended firm");
    const notes = trim(req.body?.notes) || null;

    const [row] = await db.update(articleshipMatches)
      .set({
        status: "matched",
        recommended_firm_ids: firms,
        notes,
        updated_at: new Date(),
      })
      .where(and(eq(articleshipMatches.id, id), eq(articleshipMatches.status, "submitted")))
      .returning();
    if (!row) throw new ApiError(404, "Match not found or not in submitted state");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/articleship-matches/:id/placed ───────────────────────
articleshipMatchesAdminRouter.post("/:id/placed", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Match ID");
    const placed_firm_id = need(trim(req.body?.placed_firm_id), "Placed firm ID");

    const [row] = await db.update(articleshipMatches)
      .set({
        status: "placed",
        placed_firm_id,
        updated_at: new Date(),
      })
      .where(and(eq(articleshipMatches.id, id), eq(articleshipMatches.status, "matched")))
      .returning();
    if (!row) throw new ApiError(404, "Match not found or not in matched state");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/articleship-matches/:id/cancel ───────────────────────
articleshipMatchesAdminRouter.post("/:id/cancel", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Match ID");
    const notes = trim(req.body?.notes) || null;
    const [row] = await db.update(articleshipMatches)
      .set({ status: "cancelled", notes, updated_at: new Date() })
      .where(eq(articleshipMatches.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Match not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});
