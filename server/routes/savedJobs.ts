// Saved / bookmarked jobs — toggle-based per-user list.
//
// Endpoints:
//   POST   /api/saved-jobs/:posting_id/toggle  — auth — flip saved state
//   GET    /api/saved-jobs                     — auth — my saved postings

import { Router } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { savedJobs, jobPostings, firms, employers } from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { sameOrigin } from "../middleware/sameOrigin.js";
import { ApiError, handleApiError } from "../lib/apiError.js";

export const savedJobsRouter = Router();

// ─── POST /api/saved-jobs/:posting_id/toggle ─────────────────────────────
savedJobsRouter.post("/:posting_id/toggle", requireUser, sameOrigin, async (req: AuthedRequest, res, next) => {
  try {
    const posting_id = String(req.params.posting_id);

    const [posting] = await db.select({ id: jobPostings.id })
      .from(jobPostings)
      .where(and(eq(jobPostings.id, posting_id), isNull(jobPostings.deleted_at)))
      .limit(1);
    if (!posting) throw new ApiError(404, "Posting not found");

    const [existing] = await db.select()
      .from(savedJobs)
      .where(and(
        eq(savedJobs.user_id, req.user!.id),
        eq(savedJobs.posting_id, posting_id),
      ))
      .limit(1);

    if (existing) {
      await db.delete(savedJobs)
        .where(and(
          eq(savedJobs.user_id, req.user!.id),
          eq(savedJobs.posting_id, posting_id),
        ));
      return res.json({ saved: false });
    }
    await db.insert(savedJobs).values({
      user_id: req.user!.id,
      posting_id,
    });
    res.json({ saved: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/saved-jobs ─────────────────────────────────────────────────
savedJobsRouter.get("/", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db
      .select({
        posting_id: savedJobs.posting_id,
        saved_at: savedJobs.created_at,
        title: jobPostings.title,
        type: jobPostings.type,
        status: jobPostings.status,
        location: jobPostings.location,
        salary_paise_min: jobPostings.salary_paise_min,
        salary_paise_max: jobPostings.salary_paise_max,
        salary_period:    jobPostings.salary_period,
        expires_at: jobPostings.expires_at,
        firm_name: firms.name,
        employer_name: employers.company_name,
      })
      .from(savedJobs)
      .leftJoin(jobPostings, eq(jobPostings.id, savedJobs.posting_id))
      .leftJoin(firms, eq(firms.id, jobPostings.firm_id))
      .leftJoin(employers, eq(employers.id, jobPostings.employer_id))
      .where(eq(savedJobs.user_id, req.user!.id))
      .orderBy(desc(savedJobs.created_at));
    res.json({ items: rows });
  } catch (err) { handleApiError(err, res, next); }
});
