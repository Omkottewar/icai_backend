import { Router } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { employers, jobPostings } from "../../schema/index.js";
import { requireUser } from "../middleware/requireUser.js";
import { requireEmployer, type EmployerRequest } from "../middleware/requireEmployer.js";
import { sameOrigin } from "../middleware/sameOrigin.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";

export const employerRouter = Router();

// Every endpoint here requires (a) a valid session, (b) the user has an
// employer_users row pointing to an employer. The middleware attaches the
// employer to req.employer.
employerRouter.use(requireUser, requireEmployer);

// ─── GET /api/employer/me ─────────────────────────────────────────────────
// Returns the employer the current user can act on, plus aggregate counts.
employerRouter.get("/me", async (req: EmployerRequest, res, next) => {
  try {
    const emp = req.employer!;
    const fullRows = await db
      .select()
      .from(employers)
      .where(eq(employers.id, emp.id))
      .limit(1);

    const counts = await db
      .select({
        total: sql<number>`count(*)::int`,
        active: sql<number>`count(*) filter (where ${jobPostings.status} = 'active')::int`,
      })
      .from(jobPostings)
      .where(and(eq(jobPostings.employer_id, emp.id), isNull(jobPostings.deleted_at)));

    res.json({
      employer: fullRows[0],
      user_role: emp.role,
      stats: counts[0] ?? { total: 0, active: 0 },
    });
  } catch (err) { next(err); }
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
  const location    = trim(input.location) || null;
  const experience_required = trim(input.experience_required) || null;

  const expires_at_raw = trim(input.expires_at);
  let expires_at: Date | null = null;
  if (expires_at_raw) {
    const d = new Date(expires_at_raw);
    if (Number.isNaN(d.getTime())) throw new ApiError(400, "Invalid expiry date");
    if (d <= new Date()) throw new ApiError(400, "Expiry must be in the future");
    expires_at = d;
  }
  return { type, title, description, seat_count, location, experience_required, expires_at };
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
        eq(jobPostings.id, req.params.id),
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
        eq(jobPostings.id, req.params.id),
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
        eq(jobPostings.id, req.params.id),
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
        eq(jobPostings.id, req.params.id),
        eq(jobPostings.employer_id, req.employer!.id),
        isNull(jobPostings.deleted_at),
      ))
      .returning();
    if (!row) throw new ApiError(404, "Posting not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
