import { Router } from "express";
import { and, asc, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import {
  jobPostings, firms, employers, users, jobCategories,
} from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { dispatchJobAlerts } from "../../lib/jobAlerts.js";
import { logAudit, saveVersion, actorFromReq } from "../../lib/audit.js";
import { buildCsv, sendCsv } from "../../lib/csv.js";

export const jobsAdminRouter = Router();

const POSTING_TYPES = ["job", "articleship", "assignment"] as const;
const POSTING_STATUSES = ["draft", "pending_payment", "active", "filled", "expired", "closed"] as const;

// Fixed fee per posting type (paise). Payment flow not wired yet — stored for future use.
const FEE_PAISE: Record<typeof POSTING_TYPES[number], number> = {
  job:         100000,  // ₹1,000
  articleship:  50000,  // ₹500
  assignment:  100000,  // ₹1,000 — short-term / freelance engagements for members
};

function pickType(v: unknown): typeof POSTING_TYPES[number] {
  return POSTING_TYPES.includes(v as any) ? (v as typeof POSTING_TYPES[number]) : "job";
}

function parseOptDate(v: unknown, label: string): Date | null {
  const s = trim(v);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new ApiError(400, `${label} is not a valid date`);
  return d;
}

// ─── GET /api/admin/jobs ───────────────────────────────────────────────────────
jobsAdminRouter.get("/", async (req, res, next) => {
  try {
    const q = trim(req.query.q);
    const status = trim(req.query.status);
    const type = trim(req.query.type);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const conds = [isNull(jobPostings.deleted_at)];
    if (status && POSTING_STATUSES.includes(status as any)) conds.push(eq(jobPostings.status, status as any));
    if (type && POSTING_TYPES.includes(type as any)) conds.push(eq(jobPostings.type, type as any));
    if (q) conds.push(ilike(jobPostings.title, `%${q}%`));

    const rows = await db
      .select({
        id: jobPostings.id,
        type: jobPostings.type,
        title: jobPostings.title,
        status: jobPostings.status,
        seat_count: jobPostings.seat_count,
        location: jobPostings.location,
        fee_paise: jobPostings.fee_paise,
        expires_at: jobPostings.expires_at,
        created_at: jobPostings.created_at,
        poster_name: users.name,
        firm_name: firms.name,
        employer_name: employers.company_name,
      })
      .from(jobPostings)
      .leftJoin(users, eq(users.id, jobPostings.poster_user_id))
      .leftJoin(firms, eq(firms.id, jobPostings.firm_id))
      .leftJoin(employers, eq(employers.id, jobPostings.employer_id))
      .where(and(...conds))
      .orderBy(desc(jobPostings.created_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(jobPostings)
      .where(and(...conds));

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/jobs/export.csv ───────────────────────────────────────
// Full-dataset CSV honouring the list filters.
jobsAdminRouter.get("/export.csv", async (req, res, next) => {
  try {
    const q = trim(req.query.q);
    const status = trim(req.query.status);
    const type = trim(req.query.type);
    const conds = [isNull(jobPostings.deleted_at)];
    if (status && POSTING_STATUSES.includes(status as any)) conds.push(eq(jobPostings.status, status as any));
    if (type && POSTING_TYPES.includes(type as any)) conds.push(eq(jobPostings.type, type as any));
    if (q) conds.push(ilike(jobPostings.title, `%${q}%`));

    const rows = await db.select({
      type: jobPostings.type,
      title: jobPostings.title,
      status: jobPostings.status,
      seat_count: jobPostings.seat_count,
      location: jobPostings.location,
      experience_required: jobPostings.experience_required,
      salary_paise_min: jobPostings.salary_paise_min,
      salary_paise_max: jobPostings.salary_paise_max,
      salary_period: jobPostings.salary_period,
      view_count: jobPostings.view_count,
      firm_name: firms.name,
      employer_name: employers.company_name,
      poster_name: users.name,
      created_at: jobPostings.created_at,
      expires_at: jobPostings.expires_at,
    })
      .from(jobPostings)
      .leftJoin(users, eq(users.id, jobPostings.poster_user_id))
      .leftJoin(firms, eq(firms.id, jobPostings.firm_id))
      .leftJoin(employers, eq(employers.id, jobPostings.employer_id))
      .where(and(...conds))
      .orderBy(desc(jobPostings.created_at))
      .limit(20_000);

    const csv = buildCsv(
      ["Type", "Title", "Status", "Seats", "Location", "Experience",
       "Salary min (₹)", "Salary max (₹)", "Period", "Views",
       "Firm", "Employer", "Posted by", "Created", "Expires"],
      rows,
      (r) => [
        r.type, r.title, r.status, r.seat_count, r.location, r.experience_required,
        r.salary_paise_min != null ? Math.round(Number(r.salary_paise_min) / 100) : "",
        r.salary_paise_max != null ? Math.round(Number(r.salary_paise_max) / 100) : "",
        r.salary_period, r.view_count,
        r.firm_name, r.employer_name, r.poster_name,
        r.created_at, r.expires_at,
      ],
    );
    sendCsv(res, "job-postings", csv);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/jobs/_meta/lookups ────────────────────────────────────────
jobsAdminRouter.get("/_meta/lookups", async (_req, res, next) => {
  try {
    const fs = await db
      .select({ id: firms.id, name: firms.name, registration_no: firms.registration_no })
      .from(firms).where(isNull(firms.deleted_at)).orderBy(asc(firms.name));
    const es = await db
      .select({ id: employers.id, name: employers.company_name })
      .from(employers).where(isNull(employers.deleted_at)).orderBy(asc(employers.company_name));
    const cats = await db
      .select({ id: jobCategories.id, name: jobCategories.name, code: jobCategories.code, active: jobCategories.active })
      .from(jobCategories).orderBy(asc(jobCategories.sort_order), asc(jobCategories.name));
    res.json({ firms: fs, employers: es, categories: cats, fee_paise: FEE_PAISE });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/jobs/:id ──────────────────────────────────────────────────
jobsAdminRouter.get("/:id", async (req, res, next) => {
  try {
    const [row] = await db
      .select({
        posting: jobPostings,
        poster_name: users.name,
        firm_name: firms.name,
        employer_name: employers.company_name,
      })
      .from(jobPostings)
      .leftJoin(users, eq(users.id, jobPostings.poster_user_id))
      .leftJoin(firms, eq(firms.id, jobPostings.firm_id))
      .leftJoin(employers, eq(employers.id, jobPostings.employer_id))
      .where(and(eq(jobPostings.id, req.params.id), isNull(jobPostings.deleted_at)))
      .limit(1);
    if (!row) throw new ApiError(404, "Posting not found");
    res.json({ ...row.posting, poster_name: row.poster_name, firm_name: row.firm_name, employer_name: row.employer_name });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/jobs ─────────────────────────────────────────────────────
jobsAdminRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const type = pickType(req.body.type);
    const title = need(trim(req.body.title), "Title");
    const description = need(trim(req.body.description), "Description");
    const seat_count = Math.max(1, Number(req.body.seat_count) || 1);
    const experience_required = trim(req.body.experience_required) || null;
    // Default to "Nagpur" — this is a Nagpur-branch portal and the admin
    // form no longer submits a location. Admins can still override via API.
    const location = trim(req.body.location) || "Nagpur";
    const firm_id = trim(req.body.firm_id) || null;
    const employer_id = trim(req.body.employer_id) || null;
    const category_id = trim(req.body.category_id) || null;
    const expires_at = parseOptDate(req.body.expires_at, "Expiry date");

    // Salary range — accepted as rupees, stored as paise. See employer.ts
    // parsePostingBody for the shared shape.
    const parseRupees = (v: any): number | null => {
      if (v == null || v === "") return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new ApiError(400, "Salary must be a non-negative number");
      return Math.round(n * 100);
    };
    const salary_paise_min = parseRupees(req.body.salary_rupees_min);
    const salary_paise_max = parseRupees(req.body.salary_rupees_max);
    if (salary_paise_min != null && salary_paise_max != null && salary_paise_min > salary_paise_max) {
      throw new ApiError(400, "Salary minimum can't be higher than the maximum");
    }
    const VALID_PERIODS = new Set(["monthly", "annual", "per_engagement"]);
    const salary_period_input = trim(req.body.salary_period);
    const salary_period = VALID_PERIODS.has(salary_period_input)
      ? salary_period_input
      : (type === "articleship" ? "monthly" : type === "job" ? "annual" : "per_engagement");

    const [row] = await db
      .insert(jobPostings)
      .values({
        type,
        title,
        description,
        poster_user_id: req.user!.id,
        firm_id,
        employer_id,
        category_id,
        seat_count,
        experience_required,
        location,
        salary_paise_min,
        salary_paise_max,
        salary_period,
        fee_paise: FEE_PAISE[type],
        expires_at,
        // Admin-created postings auto-publish (mirror of the employer-portal
        // POST behaviour in routes/employer.ts). Admins can demote to draft
        // or close via PATCH if they need staging.
        status: "active",
      })
      .returning();
    // Fan out subscriber alerts. Only fires if category_id is set — a
    // posting without a category has nobody to notify.
    await dispatchJobAlerts(row.id);
    res.status(201).json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/admin/jobs/:id ────────────────────────────────────────────────
jobsAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const [existing] = await db.select().from(jobPostings)
      .where(and(eq(jobPostings.id, id), isNull(jobPostings.deleted_at))).limit(1);
    if (!existing) throw new ApiError(404, "Posting not found");

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (req.body.type !== undefined) {
      patch.type = pickType(req.body.type);
      patch.fee_paise = FEE_PAISE[patch.type as typeof POSTING_TYPES[number]];
    }
    if (req.body.title !== undefined) patch.title = need(trim(req.body.title), "Title");
    if (req.body.description !== undefined) patch.description = need(trim(req.body.description), "Description");
    if (req.body.seat_count !== undefined) patch.seat_count = Math.max(1, Number(req.body.seat_count) || 1);
    if (req.body.experience_required !== undefined) patch.experience_required = trim(req.body.experience_required) || null;
    // PATCH keeps the field editable via API (for admin overrides), but if
    // the admin sends an empty string we treat that as "reset to Nagpur"
    // rather than null so the row stays useful in filters/searches.
    if (req.body.location !== undefined) patch.location = trim(req.body.location) || "Nagpur";
    if (req.body.firm_id !== undefined) patch.firm_id = trim(req.body.firm_id) || null;
    if (req.body.employer_id !== undefined) patch.employer_id = trim(req.body.employer_id) || null;
    if (req.body.category_id !== undefined) patch.category_id = trim(req.body.category_id) || null;
    if (req.body.status !== undefined && POSTING_STATUSES.includes(req.body.status)) patch.status = req.body.status;
    if (req.body.expires_at !== undefined) patch.expires_at = parseOptDate(req.body.expires_at, "Expiry date");

    // Salary — same paise conversion as POST above. Send explicit `null`
    // to clear a field; omit the key to leave the existing value alone.
    const parseRupees = (v: any): number | null => {
      if (v === null) return null;
      if (v === "" || v === undefined) return null;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new ApiError(400, "Salary must be a non-negative number");
      return Math.round(n * 100);
    };
    if (req.body.salary_rupees_min !== undefined) patch.salary_paise_min = parseRupees(req.body.salary_rupees_min);
    if (req.body.salary_rupees_max !== undefined) patch.salary_paise_max = parseRupees(req.body.salary_rupees_max);
    if (req.body.salary_period !== undefined) {
      const p = trim(req.body.salary_period);
      if (!["monthly", "annual", "per_engagement"].includes(p)) {
        throw new ApiError(400, "Salary period must be monthly, annual, or per_engagement");
      }
      patch.salary_period = p;
    }

    const [row] = await db.update(jobPostings).set(patch).where(eq(jobPostings.id, id)).returning();
    // If this PATCH moved a posting from a non-active status to active,
    // fire subscriber alerts. Same behaviour as POST above so admin edits
    // don't silently skip the notification for a re-published posting.
    if (existing.status !== "active" && row.status === "active") {
      await dispatchJobAlerts(row.id);
    }

    // Audit — captures the diff between existing → row so the History
    // tab can render "status: draft → active" clearly. Version snapshot
    // is optional here; edits are frequent + posting bodies large, so we
    // only snapshot on status transitions to keep entity_versions lean.
    const actor = actorFromReq(req as AuthedRequest);
    const statusChanged = existing.status !== row.status;
    await logAudit({
      entity_type: "job_postings",
      entity_id: row.id,
      action: statusChanged ? "status_changed" : "updated",
      actor,
      before: existing,
      after: row,
    });
    if (statusChanged) {
      await saveVersion({
        entity_type: "job_postings",
        entity_id: row.id,
        snapshot: row,
        actor,
        change_note: `Status ${existing.status} → ${row.status}`,
      });
    }

    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/jobs/:id/activate ────────────────────────────────────────
jobsAdminRouter.post("/:id/activate", async (req, res, next) => {
  try {
    const id = req.params.id;
    const [existing] = await db.select().from(jobPostings)
      .where(and(eq(jobPostings.id, id), isNull(jobPostings.deleted_at))).limit(1);
    if (!existing) throw new ApiError(404, "Posting not found");
    if (existing.status === "closed") throw new ApiError(400, "Closed postings cannot be reactivated");
    const [row] = await db.update(jobPostings)
      .set({ status: "active", updated_at: new Date() }).where(eq(jobPostings.id, id)).returning();
    if (existing.status !== "active") {
      await dispatchJobAlerts(row.id);
    }
    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/jobs/:id/close ───────────────────────────────────────────
jobsAdminRouter.post("/:id/close", async (req, res, next) => {
  try {
    const id = req.params.id;
    const [row] = await db.update(jobPostings).set({ status: "closed", updated_at: new Date() })
      .where(and(eq(jobPostings.id, id), isNull(jobPostings.deleted_at))).returning();
    if (!row) throw new ApiError(404, "Posting not found");
    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/admin/jobs/:id ───────────────────────────────────────────────
jobsAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const [row] = await db.update(jobPostings).set({ deleted_at: new Date() })
      .where(and(eq(jobPostings.id, id), isNull(jobPostings.deleted_at))).returning();
    if (!row) throw new ApiError(404, "Posting not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
