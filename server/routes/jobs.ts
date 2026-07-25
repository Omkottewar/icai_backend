import { Router } from "express";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  jobPostings, firms, employers, jobCategories,
  savedJobs, jobApplications,
} from "../../schema/index.js";
import { handleApiError, trim } from "../lib/apiError.js";
import { optionalUser, type AuthedRequest } from "../middleware/requireUser.js";

export const publicJobsRouter = Router();

// Attach req.user opportunistically — the /api/jobs listing enriches each
// row with the caller's saved + application state when signed in.
publicJobsRouter.use(optionalUser);

const VALID_TYPES = ["job", "articleship", "assignment"] as const;

// GET /api/jobs?type=job|articleship|assignment
// Returns active postings for the public vacancies page. "assignment" is
// for short-term / freelance / consulting engagements that members pick
// up alongside their regular practice (audit assistance, due-diligence,
// project consulting, etc.) — surfaced on Members → Assignments.
publicJobsRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const type = trim(req.query.type);
    const category = trim(req.query.category);
    const conds = [
      isNull(jobPostings.deleted_at),
      eq(jobPostings.status, "active"),
    ];
    if (VALID_TYPES.includes(type as any)) {
      conds.push(eq(jobPostings.type, type as typeof VALID_TYPES[number]));
    }
    if (category) {
      conds.push(eq(jobPostings.category_id, category));
    }

    const rows = await db
      .select({
        id: jobPostings.id,
        type: jobPostings.type,
        title: jobPostings.title,
        description: jobPostings.description,
        seat_count: jobPostings.seat_count,
        experience_required: jobPostings.experience_required,
        location: jobPostings.location,
        expires_at: jobPostings.expires_at,
        created_at: jobPostings.created_at,
        firm_name: firms.name,
        employer_name: employers.company_name,
        category_id: jobPostings.category_id,
        category_name: jobCategories.name,
        category_code: jobCategories.code,
      })
      .from(jobPostings)
      .leftJoin(firms, eq(firms.id, jobPostings.firm_id))
      .leftJoin(employers, eq(employers.id, jobPostings.employer_id))
      .leftJoin(jobCategories, eq(jobCategories.id, jobPostings.category_id))
      .where(and(...conds))
      .orderBy(desc(jobPostings.created_at));

    // Enrich each row with the caller's saved + application state so the
    // client can render the correct "Saved" / "Applied" pill in one round-
    // trip. Skipped entirely for anonymous callers — cheaper for the CDN
    // to serve and safer (no session-scoped data on a cacheable response).
    if (req.user && rows.length > 0) {
      const postingIds = rows.map((r) => r.id);
      const [saved, apps] = await Promise.all([
        db.select({ posting_id: savedJobs.posting_id })
          .from(savedJobs)
          .where(and(
            eq(savedJobs.user_id, req.user.id),
            inArray(savedJobs.posting_id, postingIds),
          )),
        db.select({ posting_id: jobApplications.posting_id, status: jobApplications.status })
          .from(jobApplications)
          .where(and(
            eq(jobApplications.user_id, req.user.id),
            inArray(jobApplications.posting_id, postingIds),
          )),
      ]);
      const savedSet = new Set(saved.map((s) => s.posting_id));
      const appMap = new Map(apps.map((a) => [a.posting_id, a.status]));
      const enriched = rows.map((r) => ({
        ...r,
        saved: savedSet.has(r.id),
        application_status: appMap.get(r.id) ?? null,
      }));
      return res.json({ rows: enriched });
    }

    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});
