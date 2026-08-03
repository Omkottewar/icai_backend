import { Router } from "express";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  employers, jobPostings, jobApplications, jobCategories, users, files,
} from "../../schema/index.js";
import { requireUser } from "../middleware/requireUser.js";
import { requireEmployer, type EmployerRequest } from "../middleware/requireEmployer.js";
import { sameOrigin } from "../middleware/sameOrigin.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { dispatchJobAlerts } from "../lib/jobAlerts.js";
import { notify } from "../lib/notify.js";
import { storage } from "../lib/storage.js";

export const employerRouter = Router();

// Every endpoint here requires (a) a valid session, (b) the user has an
// employer_users row pointing to an employer. The middleware attaches the
// employer to req.employer.
employerRouter.use(requireUser, requireEmployer);

// ─── GET /api/employer/me ─────────────────────────────────────────────────
// Returns the employer the current user can act on, plus aggregate counts
// (postings + total views + application funnel across all postings).
employerRouter.get("/me", async (req: EmployerRequest, res, next) => {
  try {
    const emp = req.employer!;
    const fullRows = await db
      .select()
      .from(employers)
      .where(eq(employers.id, emp.id))
      .limit(1);

    // Posting counts + aggregate view count in one round-trip.
    const [postingStats] = await db
      .select({
        total:  sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${jobPostings.status} = 'active')::int`,
        views:  sql<number>`coalesce(sum(${jobPostings.view_count}), 0)::int`,
      })
      .from(jobPostings)
      .where(and(eq(jobPostings.employer_id, emp.id), isNull(jobPostings.deleted_at)));

    // Application funnel across all postings owned by this employer.
    // Filter by status using count(*) filter (where ...) so we get one row
    // regardless of whether any status bucket is empty — cleaner than a
    // GROUP BY + client-side stitching.
    const [funnel] = await db
      .select({
        applied:     sql<number>`count(*) filter (where ${jobApplications.status} = 'applied')::int`,
        shortlisted: sql<number>`count(*) filter (where ${jobApplications.status} = 'shortlisted')::int`,
        interview:   sql<number>`count(*) filter (where ${jobApplications.status} = 'interview')::int`,
        offered:     sql<number>`count(*) filter (where ${jobApplications.status} = 'offered')::int`,
        hired:       sql<number>`count(*) filter (where ${jobApplications.status} = 'hired')::int`,
        rejected:    sql<number>`count(*) filter (where ${jobApplications.status} = 'rejected')::int`,
        withdrawn:   sql<number>`count(*) filter (where ${jobApplications.status} = 'withdrawn')::int`,
        total:       sql<number>`count(*)::int`,
      })
      .from(jobApplications)
      .leftJoin(jobPostings, eq(jobPostings.id, jobApplications.posting_id))
      .where(and(
        eq(jobPostings.employer_id, emp.id),
        isNull(jobPostings.deleted_at),
      ));

    res.json({
      employer: fullRows[0],
      user_role: emp.role,
      stats: {
        total:  postingStats?.total  ?? 0,
        active: postingStats?.active ?? 0,
        views:  postingStats?.views  ?? 0,
        funnel: funnel ?? { applied: 0, shortlisted: 0, interview: 0, offered: 0, hired: 0, rejected: 0, withdrawn: 0, total: 0 },
      },
    });
  } catch (err) { next(err); }
});

// ─── GET /api/employer/postings/_analytics ────────────────────────────────
// Per-posting view + application counts for the employer's list. Cheap
// enough to compute in one query — LEFT JOIN + count(*) filter — so the
// employer sees "how are my postings performing" without a per-row fetch.
employerRouter.get("/postings/_analytics", async (req: EmployerRequest, res, next) => {
  try {
    const emp = req.employer!;
    const rows = await db
      .select({
        posting_id:  jobPostings.id,
        title:       jobPostings.title,
        status:      jobPostings.status,
        view_count:  jobPostings.view_count,
        applied:     sql<number>`count(${jobApplications.id}) filter (where ${jobApplications.status} = 'applied')::int`,
        shortlisted: sql<number>`count(${jobApplications.id}) filter (where ${jobApplications.status} = 'shortlisted')::int`,
        interview:   sql<number>`count(${jobApplications.id}) filter (where ${jobApplications.status} = 'interview')::int`,
        hired:       sql<number>`count(${jobApplications.id}) filter (where ${jobApplications.status} = 'hired')::int`,
        total_apps:  sql<number>`count(${jobApplications.id})::int`,
      })
      .from(jobPostings)
      .leftJoin(jobApplications, eq(jobApplications.posting_id, jobPostings.id))
      .where(and(eq(jobPostings.employer_id, emp.id), isNull(jobPostings.deleted_at)))
      .groupBy(jobPostings.id, jobPostings.title, jobPostings.status, jobPostings.view_count)
      .orderBy(desc(jobPostings.created_at));
    res.json({ items: rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/employer/me ───────────────────────────────────────────────
// Update the employer's profile. Only owners can edit; posters get 403.
employerRouter.patch("/me", sameOrigin, async (req: EmployerRequest, res, next) => {
  try {
    const emp = req.employer!;
    if (emp.role !== "owner") throw new ApiError(403, "Only the owner can edit company details");

    const company_name = need(trim(req.body.company_name), "Company name");
    const gstin   = trim(req.body.gstin).toUpperCase() || null;
    const pan     = trim(req.body.pan).toUpperCase()   || null;
    const website = trim(req.body.website) || null;
    const address = trim(req.body.address) || null;

    if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gstin)) {
      throw new ApiError(400, "GSTIN format looks wrong");
    }
    if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]{1}$/.test(pan)) {
      throw new ApiError(400, "PAN format looks wrong");
    }

    const [row] = await db.update(employers).set({
      company_name, gstin, pan, website, address, updated_at: new Date(),
    }).where(eq(employers.id, emp.id)).returning();

    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Job postings ─────────────────────────────────────────────────────────

const POSTING_TYPES = ["job", "articleship", "assignment"] as const;
type PostingType = typeof POSTING_TYPES[number];

function parsePostingBody(input: any) {
  const type        = POSTING_TYPES.includes(input.type) ? input.type as PostingType : null;
  if (!type) throw new ApiError(400, "Posting type must be job, articleship, or assignment");
  const title       = need(trim(input.title), "Title");
  const description = need(trim(input.description), "Description");
  const seat_count  = Math.max(1, Math.min(50, Number(input.seat_count) || 1));
  // Location defaults to "Nagpur" — this is a Nagpur-branch portal and
  // employers don't submit it from the form. Kept for schema stability and
  // for the rare case where the admin CRUD overrides it explicitly.
  const location    = trim(input.location) || "Nagpur";
  const experience_required = trim(input.experience_required) || null;
  const category_id = trim(input.category_id) || null;

  // Salary range — accepted as rupees on the form for readability, then
  // converted to paise. `null` if the employer omits either end.
  const parseRupees = (v: any): number | null => {
    if (v == null || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new ApiError(400, "Salary must be a non-negative number");
    return Math.round(n * 100);
  };
  const salary_paise_min = parseRupees(input.salary_rupees_min);
  const salary_paise_max = parseRupees(input.salary_rupees_max);
  if (salary_paise_min != null && salary_paise_max != null && salary_paise_min > salary_paise_max) {
    throw new ApiError(400, "Salary minimum can't be higher than the maximum");
  }
  const VALID_PERIODS = new Set(["monthly", "annual", "per_engagement"]);
  const salary_period_input = trim(input.salary_period);
  // Sensible per-type default so the employer doesn't have to pick:
  //   articleship → monthly stipend, job → annual CTC, assignment → per engagement.
  const salary_period = VALID_PERIODS.has(salary_period_input)
    ? salary_period_input
    : (type === "articleship" ? "monthly" : type === "job" ? "annual" : "per_engagement");

  const expires_at_raw = trim(input.expires_at);
  let expires_at: Date | null = null;
  if (expires_at_raw) {
    const d = new Date(expires_at_raw);
    if (Number.isNaN(d.getTime())) throw new ApiError(400, "Invalid expiry date");
    if (d <= new Date()) throw new ApiError(400, "Expiry must be in the future");
    expires_at = d;
  }
  return {
    type, title, description, seat_count, location, experience_required,
    expires_at, category_id,
    salary_paise_min, salary_paise_max, salary_period,
  };
}

// ─── GET /api/employer/postings ───────────────────────────────────────────
employerRouter.get("/postings", async (req: EmployerRequest, res, next) => {
  try {
    const rows = await db.select().from(jobPostings)
      .where(and(eq(jobPostings.employer_id, req.employer!.id), isNull(jobPostings.deleted_at)))
      .orderBy(desc(jobPostings.created_at));
    res.json({ items: rows });
  } catch (err) { next(err); }
});

// ─── GET /api/employer/postings/:id ───────────────────────────────────────
employerRouter.get("/postings/:id", async (req: EmployerRequest, res, next) => {
  try {
    const rows = await db.select().from(jobPostings)
      .where(and(
        eq(jobPostings.id, String(req.params.id)),
        eq(jobPostings.employer_id, req.employer!.id),
        isNull(jobPostings.deleted_at),
      ))
      .limit(1);
    if (!rows[0]) throw new ApiError(404, "Posting not found");
    res.json({ item: rows[0] });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/employer/postings ──────────────────────────────────────────
// Auto-publish (Q2 from plan): new postings go straight to status='active'.
// Server stamps employer_id from session — client cannot spoof it.
employerRouter.post("/postings", sameOrigin, async (req: EmployerRequest, res, next) => {
  try {
    const parsed = parsePostingBody(req.body);
    const [row] = await db.insert(jobPostings).values({
      ...parsed,
      employer_id:    req.employer!.id,
      poster_user_id: req.user!.id,
      status:         "active",
      fee_paise:      0,                // free for v1 (Q3)
    }).returning();
    // Fire per-subscriber instant alerts — safe to await (dispatchJobAlerts
    // never throws) so any DB error inside is logged instead of leaking a
    // 500 back to the poster after the row is already saved.
    await dispatchJobAlerts(row.id);
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/employer/postings/:id ─────────────────────────────────────
employerRouter.patch("/postings/:id", sameOrigin, async (req: EmployerRequest, res, next) => {
  try {
    const parsed = parsePostingBody(req.body);
    const [row] = await db.update(jobPostings)
      .set({ ...parsed, updated_at: new Date() })
      .where(and(
        eq(jobPostings.id, String(req.params.id)),
        eq(jobPostings.employer_id, req.employer!.id),
        isNull(jobPostings.deleted_at),
      ))
      .returning();
    if (!row) throw new ApiError(404, "Posting not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/employer/postings/:id/close ───────────────────────────────
// Sets status='closed' (employer-controlled archive). Distinct from delete.
employerRouter.post("/postings/:id/close", sameOrigin, async (req: EmployerRequest, res, next) => {
  try {
    const [row] = await db.update(jobPostings)
      .set({ status: "closed", updated_at: new Date() })
      .where(and(
        eq(jobPostings.id, String(req.params.id)),
        eq(jobPostings.employer_id, req.employer!.id),
        isNull(jobPostings.deleted_at),
      ))
      .returning();
    if (!row) throw new ApiError(404, "Posting not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/employer/postings/:id ────────────────────────────────────
employerRouter.delete("/postings/:id", sameOrigin, async (req: EmployerRequest, res, next) => {
  try {
    const [row] = await db.update(jobPostings)
      .set({ deleted_at: new Date() })
      .where(and(
        eq(jobPostings.id, String(req.params.id)),
        eq(jobPostings.employer_id, req.employer!.id),
        isNull(jobPostings.deleted_at),
      ))
      .returning();
    if (!row) throw new ApiError(404, "Posting not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Applicants ──────────────────────────────────────────────────────────

async function assertPostingBelongsToEmployer(postingId: string, employerId: string) {
  const [p] = await db.select({ id: jobPostings.id })
    .from(jobPostings)
    .where(and(
      eq(jobPostings.id, postingId),
      eq(jobPostings.employer_id, employerId),
      isNull(jobPostings.deleted_at),
    ))
    .limit(1);
  if (!p) throw new ApiError(404, "Posting not found");
}

const APPLICATION_STATUSES = [
  "applied", "shortlisted", "interview", "offered", "hired", "rejected", "withdrawn",
] as const;
const STATUS_LABEL: Record<typeof APPLICATION_STATUSES[number], string> = {
  applied:     "Received",
  shortlisted: "Shortlisted",
  interview:   "Interview scheduled",
  offered:     "Offered",
  hired:       "Hired",
  rejected:    "Not selected",
  withdrawn:   "Withdrawn",
};

// ─── GET /api/employer/postings/:id/applicants ───────────────────────────
employerRouter.get("/postings/:id/applicants", async (req: EmployerRequest, res, next) => {
  try {
    await assertPostingBelongsToEmployer(String(req.params.id), req.employer!.id);
    const rows = await db
      .select({
        id: jobApplications.id,
        user_id: jobApplications.user_id,
        applicant_name: users.name,
        applicant_email: users.email,
        applicant_phone: users.phone,
        applicant_role: users.primary_role,
        status: jobApplications.status,
        status_note: jobApplications.status_note,
        cover_message: jobApplications.cover_message,
        applicant_snapshot: jobApplications.applicant_snapshot,
        created_at: jobApplications.created_at,
        reviewed_at: jobApplications.reviewed_at,
        withdrawn_at: jobApplications.withdrawn_at,
        resume_file_id: jobApplications.resume_file_id,
      })
      .from(jobApplications)
      .leftJoin(users, eq(users.id, jobApplications.user_id))
      .where(eq(jobApplications.posting_id, String(req.params.id)))
      .orderBy(desc(jobApplications.created_at));
    res.json({ items: rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/employer/applications/:appId/resume ────────────────────────
// Returns a URL for the applicant's snapshot resume. Employer-scoped:
// the application's posting must belong to this employer.
employerRouter.get("/applications/:appId/resume", async (req: EmployerRequest, res, next) => {
  try {
    const [app] = await db
      .select({
        resume_file_id: jobApplications.resume_file_id,
        posting_employer_id: jobPostings.employer_id,
      })
      .from(jobApplications)
      .leftJoin(jobPostings, eq(jobPostings.id, jobApplications.posting_id))
      .where(eq(jobApplications.id, String(req.params.appId)))
      .limit(1);
    if (!app || app.posting_employer_id !== req.employer!.id) {
      throw new ApiError(404, "Application not found");
    }
    if (!app.resume_file_id) throw new ApiError(404, "Resume is no longer available");
    const [f] = await db.select().from(files).where(eq(files.id, app.resume_file_id)).limit(1);
    if (!f) throw new ApiError(404, "Resume is no longer available");
    res.json({ url: storage().url(f.storage_path), name: f.name });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/employer/applications/:appId ─────────────────────────────
// Body: { status, status_note? }
// Employer moves applicants through the pipeline. Every status change
// fires job_application_status_changed to the applicant.
employerRouter.patch("/applications/:appId", sameOrigin, async (req: EmployerRequest, res, next) => {
  try {
    const status = trim(req.body.status);
    if (!APPLICATION_STATUSES.includes(status as any)) {
      throw new ApiError(400, "Invalid status");
    }
    const status_note = trim(req.body.status_note) || null;

    const [existing] = await db
      .select({
        id: jobApplications.id,
        posting_id: jobApplications.posting_id,
        user_id: jobApplications.user_id,
        prev_status: jobApplications.status,
        posting_employer_id: jobPostings.employer_id,
        posting_title: jobPostings.title,
        firm_name: sql<string>`(SELECT name FROM firms WHERE id = ${jobPostings.firm_id})`,
        employer_name: sql<string>`(SELECT company_name FROM employers WHERE id = ${jobPostings.employer_id})`,
      })
      .from(jobApplications)
      .leftJoin(jobPostings, eq(jobPostings.id, jobApplications.posting_id))
      .where(eq(jobApplications.id, String(req.params.appId)))
      .limit(1);

    if (!existing || existing.posting_employer_id !== req.employer!.id) {
      throw new ApiError(404, "Application not found");
    }

    const [row] = await db.update(jobApplications)
      .set({
        status: status as any,
        status_note,
        reviewed_by: req.user!.id,
        reviewed_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(jobApplications.id, String(req.params.appId)))
      .returning();

    // Fire notification if status actually changed (idempotent PATCHes
    // shouldn't blast the applicant with duplicate emails).
    if (existing.prev_status !== status) {
      const applicationsUrl = (process.env.PUBLIC_APP_URL || "https://icainagpur.in").replace(/\/+$/, "")
        + "/dashboard#my-applications";
      const org_name = existing.firm_name || existing.employer_name || "ICAI Nagpur";
      const status_note_block = status_note ? `Note from the employer:\n  ${status_note}\n\n` : "";
      await notify({
        user_id: existing.user_id,
        template_key: "job_application_status_changed",
        link_url: applicationsUrl,
        vars: {
          posting_title: existing.posting_title,
          org_name,
          status_label: STATUS_LABEL[status as keyof typeof STATUS_LABEL] ?? status,
          status_note_block,
          application_url: applicationsUrl,
        },
      });
    }

    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/employer/postings/_meta/lookups ────────────────────────────
// Categories dropdown for the posting form.
employerRouter.get("/postings/_meta/lookups", async (_req, res, next) => {
  try {
    const cats = await db.select({
      id: jobCategories.id, name: jobCategories.name, code: jobCategories.code,
    })
      .from(jobCategories)
      .where(eq(jobCategories.active, true))
      .orderBy(asc(jobCategories.sort_order));
    res.json({ categories: cats });
  } catch (err) { handleApiError(err, res, next); }
});
