import { Router } from "express";
import { aliasedTable, and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { mentorshipRequests, users } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const mentorshipAdminRouter = Router();

const STATUSES = ["pending", "matched", "scheduled", "completed", "cancelled"] as const;
type Status = typeof STATUSES[number];

// ─── GET /api/admin/mentorship ────────────────────────────────────────────
mentorshipAdminRouter.get("/", async (req, res, next) => {
  try {
    const status = trim(req.query.status);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const studentU = aliasedTable(users, "student_u");
    const mentorU  = aliasedTable(users, "mentor_u");

    const conds = [] as any[];
    if (status && STATUSES.includes(status as Status)) conds.push(eq(mentorshipRequests.status, status));

    const rows = await db
      .select({
        id:              mentorshipRequests.id,
        topic:           mentorshipRequests.topic,
        preferred_window: mentorshipRequests.preferred_window,
        status:          mentorshipRequests.status,
        notes:           mentorshipRequests.notes,
        matched_at:      mentorshipRequests.matched_at,
        scheduled_at:    mentorshipRequests.scheduled_at,
        completed_at:    mentorshipRequests.completed_at,
        created_at:      mentorshipRequests.created_at,
        student_user_id: mentorshipRequests.student_user_id,
        student_name:    studentU.name,
        student_email:   studentU.email,
        mentor_user_id:  mentorshipRequests.mentor_user_id,
        mentor_name:     mentorU.name,
        mentor_email:    mentorU.email,
      })
      .from(mentorshipRequests)
      .leftJoin(studentU, eq(studentU.id, mentorshipRequests.student_user_id))
      .leftJoin(mentorU,  eq(mentorU.id,  mentorshipRequests.mentor_user_id))
      .where(conds.length ? and(...conds) : sql`true`)
      .orderBy(desc(mentorshipRequests.created_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(mentorshipRequests)
      .where(conds.length ? and(...conds) : sql`true`);

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/mentorship/:id/assign-mentor ─────────────────────────
mentorshipAdminRouter.post("/:id/assign-mentor", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mentorship request ID");
    const mentor_user_id = need(trim(req.body?.mentor_user_id), "Mentor user ID");

    const [row] = await db.update(mentorshipRequests)
      .set({
        mentor_user_id,
        status: "matched",
        matched_at: new Date(),
        updated_at: new Date(),
      })
      .where(and(eq(mentorshipRequests.id, id), eq(mentorshipRequests.status, "pending")))
      .returning();
    if (!row) throw new ApiError(404, "Request not found or already matched");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/mentorship/:id/schedule ──────────────────────────────
mentorshipAdminRouter.post("/:id/schedule", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mentorship request ID");
    const scheduledAtStr = trim(req.body?.scheduled_at);
    const scheduled_at = scheduledAtStr ? new Date(scheduledAtStr) : new Date();
    if (Number.isNaN(scheduled_at.getTime())) throw new ApiError(400, "Invalid scheduled_at");

    const [row] = await db.update(mentorshipRequests)
      .set({ status: "scheduled", scheduled_at, updated_at: new Date() })
      .where(and(eq(mentorshipRequests.id, id), eq(mentorshipRequests.status, "matched")))
      .returning();
    if (!row) throw new ApiError(404, "Request not found or not in matched state");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/mentorship/:id/complete ──────────────────────────────
mentorshipAdminRouter.post("/:id/complete", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mentorship request ID");
    const notes = trim(req.body?.notes) || null;
    const [row] = await db.update(mentorshipRequests)
      .set({ status: "completed", completed_at: new Date(), notes, updated_at: new Date() })
      .where(eq(mentorshipRequests.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Request not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/mentorship/:id/cancel ────────────────────────────────
mentorshipAdminRouter.post("/:id/cancel", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mentorship request ID");
    const notes = trim(req.body?.notes) || null;
    const [row] = await db.update(mentorshipRequests)
      .set({ status: "cancelled", notes, updated_at: new Date() })
      .where(eq(mentorshipRequests.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Request not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});
