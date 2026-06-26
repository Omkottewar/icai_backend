import { Router } from "express";
import { and, asc, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { jobPostings, firms, employers, users } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const jobsAdminRouter = Router();

const POSTING_TYPES = ["job", "articleship"] as const;
const POSTING_STATUSES = ["draft", "pending_payment", "active", "filled", "expired", "closed"] as const;

// Fixed fee per posting type (paise). Payment flow not wired yet — stored for future use.
const FEE_PAISE: Record<typeof POSTING_TYPES[number], number> = {
  job: 100000,         // ₹1,000
  articleship: 50000,  // ₹500
  // assignment: 100000,   ₹1,000
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

// ─── GET /api/admin/jobs/_meta/lookups ────────────────────────────────────────
jobsAdminRouter.get("/_meta/lookups", async (_req, res, next) => {
  try {
    const fs = await db
      .select({ id: firms.id, name: firms.name, registration_no: firms.registration_no })
      .from(firms).where(isNull(firms.deleted_at)).orderBy(asc(firms.name));
    const es = await db
      .select({ id: employers.id, name: employers.company_name })
      .from(employers).where(isNull(employers.deleted_at)).orderBy(asc(employers.company_name));
    res.json({ firms: fs, employers: es, fee_paise: FEE_PAISE });
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
    const location = trim(req.body.location) || null;
    const firm_id = trim(req.body.firm_id) || null;
    const employer_id = trim(req.body.employer_id) || null;
    const expires_at = parseOptDate(req.body.expires_at, "Expiry date");

    const [row] = await db
      .insert(jobPostings)
      .values({
        type,
        title,
        description,
        poster_user_id: req.user!.id,
        firm_id,
        employer_id,
        seat_count,
        experience_required,
        location,
        fee_paise: FEE_PAISE[type],
        expires_at,
        // Admin-created postings auto-publish (mirror of the employer-portal
        // POST behaviour in routes/employer.ts). Admins can demote to draft
        // or close via PATCH if they need staging.
        status: "active",
      })
      .returning();
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
    if (req.body.location !== undefined) patch.location = trim(req.body.location) || null;
    if (req.body.firm_id !== undefined) patch.firm_id = trim(req.body.firm_id) || null;
    if (req.body.employer_id !== undefined) patch.employer_id = trim(req.body.employer_id) || null;
    if (req.body.status !== undefined && POSTING_STATUSES.includes(req.body.status)) patch.status = req.body.status;
    if (req.body.expires_at !== undefined) patch.expires_at = parseOptDate(req.body.expires_at, "Expiry date");

    const [row] = await db.update(jobPostings).set(patch).where(eq(jobPostings.id, id)).returning();
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
