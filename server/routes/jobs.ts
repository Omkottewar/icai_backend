import { Router } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { jobPostings, firms, employers } from "../../schema/index.js";
import { handleApiError, trim } from "../lib/apiError.js";

export const publicJobsRouter = Router();

const VALID_TYPES = ["job", "articleship", "assignment"] as const;

// GET /api/jobs?type=job|articleship|assignment
// Returns active postings for the public vacancies page. "assignment" is
// for short-term / freelance / consulting engagements that members pick
// up alongside their regular practice (audit assistance, due-diligence,
// project consulting, etc.) — surfaced on Members → Assignments.
publicJobsRouter.get("/", async (req, res, next) => {
  try {
    const type = trim(req.query.type);
    const conds = [
      isNull(jobPostings.deleted_at),
      eq(jobPostings.status, "active"),
    ];
    if (VALID_TYPES.includes(type as any)) {
      conds.push(eq(jobPostings.type, type as typeof VALID_TYPES[number]));
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
      })
      .from(jobPostings)
      .leftJoin(firms, eq(firms.id, jobPostings.firm_id))
      .leftJoin(employers, eq(employers.id, jobPostings.employer_id))
      .where(and(...conds))
      .orderBy(desc(jobPostings.created_at));

    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});
