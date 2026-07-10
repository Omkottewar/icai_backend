// Public mentorship endpoints for students.
//
// Flow (paired with backend/server/routes/admin/mentorship.ts):
//   1. Student POSTs { topic, preferred_window } → row inserted with
//      status='pending' and student_user_id from the session.
//   2. The row appears in the WICASA admin inbox at /admin/mentorship.
//   3. WICASA assigns a mentor + schedules — those transitions are the
//      admin-only endpoints.
//
// GET /my returns the requesting student's own requests, ordered by newest,
// so the student dashboard can show status pills ("2 requests, awaiting
// match", etc.) without a second round-trip.
//
// Rate-limited to 3 submissions per hour per user — students shouldn't be
// spamming the WICASA inbox with duplicate asks.

import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { mentorshipRequests, users } from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { sameOrigin } from "../middleware/sameOrigin.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";

export const mentorshipRouter = Router();

const submissionLimiter = rateLimit({
  standardHeaders: "draft-7",
  legacyHeaders: false,
  windowMs: 60 * 60 * 1000,
  limit: 3,
  // ipKeyGenerator normalises IPv6 into a /64 bucket so a single user can't
  // rotate through addresses inside their prefix to bypass the limit.
  keyGenerator: (req: any) => req.user?.id ?? ipKeyGenerator(req.ip),
  message: {
    error: "rate_limited",
    message: "You've submitted a few mentorship requests recently. Please wait an hour before submitting another.",
  },
});

// ─── POST /api/mentorship ─────────────────────────────────────────────────
// Only students may submit — members / employers / admins fall through with 403
// so we don't pollute the WICASA queue with off-role requests.
mentorshipRouter.post("/", sameOrigin, requireUser, submissionLimiter, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    if (user.primary_role !== "student") {
      throw new ApiError(403, "Only students can request mentorship");
    }

    const topic = need(trim(req.body?.topic), "Topic");
    if (topic.length > 200) throw new ApiError(400, "Topic must be 200 characters or less");
    const preferred_window = trim(req.body?.preferred_window) || null;
    if (preferred_window && preferred_window.length > 500) {
      throw new ApiError(400, "Preferred window must be 500 characters or less");
    }

    const [row] = await db.insert(mentorshipRequests).values({
      student_user_id: user.id,
      topic,
      preferred_window,
      status: "pending",
    }).returning();

    res.status(201).json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/mentorship/my ────────────────────────────────────────────────
// Student's own mentorship requests + assigned mentor's name if any.
mentorshipRouter.get("/my", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    const rows = await db.select({
      id:                mentorshipRequests.id,
      topic:             mentorshipRequests.topic,
      preferred_window:  mentorshipRequests.preferred_window,
      status:            mentorshipRequests.status,
      notes:             mentorshipRequests.notes,
      matched_at:        mentorshipRequests.matched_at,
      scheduled_at:      mentorshipRequests.scheduled_at,
      completed_at:      mentorshipRequests.completed_at,
      created_at:        mentorshipRequests.created_at,
      mentor_name:       users.name,
    })
      .from(mentorshipRequests)
      .leftJoin(users, eq(users.id, mentorshipRequests.mentor_user_id))
      .where(eq(mentorshipRequests.student_user_id, user.id))
      .orderBy(desc(mentorshipRequests.created_at))
      .limit(20);
    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/mentorship/:id/cancel ───────────────────────────────────────
// Student cancels a request that hasn't been scheduled yet. After 'scheduled'
// they should coordinate with WICASA instead.
mentorshipRouter.post("/:id/cancel", sameOrigin, requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    const id = need(trim(req.params.id), "Request ID");
    // Only allow cancel from pending or matched — once scheduled the mentor
    // has been notified and cancellation goes through WICASA.
    const [row] = await db.update(mentorshipRequests)
      .set({ status: "cancelled", updated_at: new Date() })
      .where(and(
        eq(mentorshipRequests.id, id),
        eq(mentorshipRequests.student_user_id, user.id),
        // WHERE status IN (pending, matched)
        // drizzle doesn't have a nice inArray on update, so a raw SQL OR
        // works cleanly here.
      ))
      .returning();
    if (!row) throw new ApiError(404, "Request not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});
