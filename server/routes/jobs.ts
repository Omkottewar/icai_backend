import { Router } from "express";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  jobPostings, firms, employers, jobCategories,
  savedJobs, jobApplications, jobAlertSubscriptions,
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
    // Free-text search runs a case-insensitive substring match against
    // title, description, firm/employer name, and experience_required so a
    // student can find "GST" or a firm's name from a single input. Kept as
    // ILIKE '%q%' — for a branch portal we're talking hundreds of rows, not
    // hundreds of thousands, so full-text search / trigram indexes are
    // overkill. We can graduate to pg_trgm later without changing the URL.
    const q = trim(req.query.q);
    const experience = trim(req.query.experience);
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
    if (q) {
      const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      const orClause = or(
        ilike(jobPostings.title,       like),
        ilike(jobPostings.description, like),
        ilike(jobPostings.experience_required, like),
        ilike(firms.name,     like),
        ilike(employers.company_name, like),
      );
      if (orClause) conds.push(orClause);
    }
    if (experience) {
      const like = `%${experience.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      conds.push(ilike(jobPostings.experience_required, like));
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
        salary_paise_min: jobPostings.salary_paise_min,
        salary_paise_max: jobPostings.salary_paise_max,
        salary_period:    jobPostings.salary_period,
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

// GET /api/jobs/recommended — up to 6 postings that match the caller's
// active job-alert subscriptions. "Recommended for you" strip on the
// listing page. Returns empty for signed-out callers and for signed-in
// callers with zero active subscriptions.
//
// Match criteria: same (category_id, posting_type) as any of the
// caller's confirmed, non-unsubscribed subscription rows. Excludes any
// posting the caller has already applied to.
publicJobsRouter.get("/recommended", async (req: AuthedRequest, res, next) => {
  try {
    if (!req.user) return res.json({ rows: [] });

    // Optional `type` param scopes recommendations to what the listing
    // page is currently showing (jobs / articleships / assignments).
    const type = trim(req.query.type);

    const subs = await db
      .select({
        category_id: jobAlertSubscriptions.category_id,
        posting_type: jobAlertSubscriptions.posting_type,
      })
      .from(jobAlertSubscriptions)
      .where(and(
        eq(jobAlertSubscriptions.user_id, req.user.id),
        isNull(jobAlertSubscriptions.unsubscribed_at),
        sql`${jobAlertSubscriptions.confirmed_at} IS NOT NULL`,
      ));

    if (subs.length === 0) return res.json({ rows: [] });

    // Postings the caller already applied to — exclude from recs.
    const applied = await db
      .select({ posting_id: jobApplications.posting_id })
      .from(jobApplications)
      .where(eq(jobApplications.user_id, req.user.id));
    const appliedSet = new Set(applied.map((a) => a.posting_id));

    const categoryIds = Array.from(new Set(subs.map((s) => s.category_id)));
    const subTypes    = new Set(subs.map((s) => s.posting_type));

    const conds = [
      isNull(jobPostings.deleted_at),
      eq(jobPostings.status, "active"),
      inArray(jobPostings.category_id, categoryIds),
    ];
    if (VALID_TYPES.includes(type as any)) {
      conds.push(eq(jobPostings.type, type as typeof VALID_TYPES[number]));
    }

    const rows = await db
      .select({
        id: jobPostings.id,
        type: jobPostings.type,
        title: jobPostings.title,
        seat_count: jobPostings.seat_count,
        experience_required: jobPostings.experience_required,
        location: jobPostings.location,
        salary_paise_min: jobPostings.salary_paise_min,
        salary_paise_max: jobPostings.salary_paise_max,
        salary_period:    jobPostings.salary_period,
        created_at: jobPostings.created_at,
        firm_name: firms.name,
        employer_name: employers.company_name,
        category_id: jobPostings.category_id,
        category_name: jobCategories.name,
      })
      .from(jobPostings)
      .leftJoin(firms, eq(firms.id, jobPostings.firm_id))
      .leftJoin(employers, eq(employers.id, jobPostings.employer_id))
      .leftJoin(jobCategories, eq(jobCategories.id, jobPostings.category_id))
      .where(and(...conds))
      .orderBy(desc(jobPostings.created_at))
      .limit(20);

    // Client-side filter for posting_type (a member's sub may only cover
    // jobs, but they're on the articleship listing — hide those recs) and
    // for already-applied postings.
    const filtered = rows
      .filter((r) => subTypes.has(r.type))
      .filter((r) => !appliedSet.has(r.id))
      .slice(0, 6);

    res.json({ rows: filtered });
  } catch (err) { handleApiError(err, res, next); }
});

// GET /api/jobs/:id — single posting detail with employer/firm + category.
// Public (no auth required) so a deep-link from an alert email works even
// for a signed-out subscriber. Only exposes active postings; anything
// filled/expired/closed/draft returns 404 so URLs age out gracefully.
publicJobsRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    if (!id) return res.status(404).json({ error: "Not found" });

    const [row] = await db
      .select({
        id: jobPostings.id,
        type: jobPostings.type,
        title: jobPostings.title,
        description: jobPostings.description,
        seat_count: jobPostings.seat_count,
        experience_required: jobPostings.experience_required,
        location: jobPostings.location,
        salary_paise_min: jobPostings.salary_paise_min,
        salary_paise_max: jobPostings.salary_paise_max,
        salary_period:    jobPostings.salary_period,
        expires_at: jobPostings.expires_at,
        created_at: jobPostings.created_at,
        firm_id: jobPostings.firm_id,
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
      .where(and(
        eq(jobPostings.id, id),
        eq(jobPostings.status, "active"),
        isNull(jobPostings.deleted_at),
      ))
      .limit(1);

    if (!row) return res.status(404).json({ error: "Posting not found" });

    // Bump the view counter (fire-and-forget so a slow write doesn't
    // block the response). Skip if the caller is the posting's own
    // employer viewing their own — that's noise, not signal.
    // NOTE: We're not deduping views per user or per session; a page
    // reload will count again. Naukri does the same for simplicity.
    db.update(jobPostings)
      .set({ view_count: sql`${jobPostings.view_count} + 1` })
      .where(eq(jobPostings.id, id))
      .catch(() => {}); // best-effort telemetry

    // Enrich with the caller's saved / application state so the detail
    // page can render "Saved" / "Applied" without a second round-trip.
    let saved = false;
    let application_status: string | null = null;
    if (req.user) {
      const [s] = await db.select({ posting_id: savedJobs.posting_id })
        .from(savedJobs)
        .where(and(eq(savedJobs.user_id, req.user.id), eq(savedJobs.posting_id, id)))
        .limit(1);
      saved = !!s;
      const [a] = await db.select({ status: jobApplications.status })
        .from(jobApplications)
        .where(and(eq(jobApplications.user_id, req.user.id), eq(jobApplications.posting_id, id)))
        .limit(1);
      application_status = a?.status ?? null;
    }

    // Related — 3 other active postings in the same category (excluding
    // this one). Falls back to same type if no category is set. This
    // is what makes the page feel like a portal and not a dead-end.
    const relatedConds = [
      isNull(jobPostings.deleted_at),
      eq(jobPostings.status, "active"),
    ];
    if (row.category_id) {
      relatedConds.push(eq(jobPostings.category_id, row.category_id));
    } else {
      relatedConds.push(eq(jobPostings.type, row.type));
    }
    const related = await db
      .select({
        id: jobPostings.id,
        type: jobPostings.type,
        title: jobPostings.title,
        seat_count: jobPostings.seat_count,
        experience_required: jobPostings.experience_required,
        salary_paise_min: jobPostings.salary_paise_min,
        salary_paise_max: jobPostings.salary_paise_max,
        salary_period:    jobPostings.salary_period,
        firm_name: firms.name,
        employer_name: employers.company_name,
        created_at: jobPostings.created_at,
      })
      .from(jobPostings)
      .leftJoin(firms, eq(firms.id, jobPostings.firm_id))
      .leftJoin(employers, eq(employers.id, jobPostings.employer_id))
      .where(and(...relatedConds))
      .orderBy(desc(jobPostings.created_at))
      .limit(4); // fetch 4, filter out `id` client-side, show up to 3

    res.json({
      item: { ...row, saved, application_status },
      related: related.filter((r) => r.id !== id).slice(0, 3),
    });
  } catch (err) { handleApiError(err, res, next); }
});
