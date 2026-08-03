// Admin endpoints for the grievance inbox and the subject → email routing map.
//
// Mounted at /api/admin/grievances (inbox + per-ticket actions) and
// /api/admin/grievance-routes (the editable routing table).
//
// All routes are gated by requireAdmin via the parent router.

import { Router } from "express";
import { and, desc, eq, ilike, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import {
  grievances,
  grievanceSubjectRoutes,
  users,
} from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { buildCsv, sendCsv } from "../../lib/csv.js";

export const grievancesAdminRouter = Router();
export const grievanceRoutesAdminRouter = Router();

const STATUSES = ["open", "in_review", "resolved", "closed"] as const;
type Status = (typeof STATUSES)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ─── GET /api/admin/grievances ──────────────────────────────────────────────
// Inbox listing. Filters: ?status=, ?subject=, ?ticket_no= (exact match used
// by the "open in admin" deep-link from the routed admin email).
// Shared filter builder for the list, count, and CSV export endpoints so
// filters stay in sync. Supports status, subject, ticket_no, and free-
// text search on name / email.
function buildGrievanceFilters(query: Record<string, unknown>) {
  const status = STATUSES.includes(query.status as Status) ? (query.status as Status) : null;
  const subject = trim(query.subject) || null;
  const ticket_no = trim(query.ticket_no) || null;
  const q = trim(query.q);

  const filters: any[] = [];
  if (status)    filters.push(eq(grievances.status, status));
  if (subject)   filters.push(eq(grievances.subject, subject));
  if (ticket_no) filters.push(eq(grievances.ticket_no, ticket_no));
  if (q) {
    filters.push(or(
      ilike(grievances.name, `%${q}%`),
      ilike(grievances.email, `%${q}%`),
      ilike(grievances.ticket_no, `%${q}%`),
    )!);
  }
  return filters;
}

grievancesAdminRouter.get("/", async (req, res, next) => {
  try {
    const filters = buildGrievanceFilters(req.query as any);
    const page     = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(5, Number(req.query.pageSize) || 50));
    const offset   = (page - 1) * pageSize;

    const whereExpr = filters.length ? and(...filters) : undefined as any;

    const rows = await db
      .select({
        id: grievances.id,
        ticket_no: grievances.ticket_no,
        name: grievances.name,
        email: grievances.email,
        phone: grievances.phone,
        subject: grievances.subject,
        against_type: grievances.against_type,
        against_ref: grievances.against_ref,
        message: grievances.message,
        status: grievances.status,
        assigned_to: grievances.assigned_to,
        assigned_to_name: users.name,
        resolution_note: grievances.resolution_note,
        resolved_at: grievances.resolved_at,
        feature_in_newsletter: grievances.feature_in_newsletter,
        newsletter_approved_at: grievances.newsletter_approved_at,
        created_at: grievances.created_at,
      })
      .from(grievances)
      .leftJoin(users, eq(users.id, grievances.assigned_to))
      .where(whereExpr)
      .orderBy(desc(grievances.created_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(grievances)
      .where(whereExpr);

    // Legacy callers used `items`; keep that key + add `rows`/`total`/`page`
    // so the frontend can migrate to standard pagination without breaking
    // anything reading `items`.
    res.json({ items: rows, rows, total, page, pageSize });
  } catch (err) { next(err); }
});

// ─── GET /api/admin/grievances/export.csv ─────────────────────────────────
grievancesAdminRouter.get("/export.csv", async (req, res, next) => {
  try {
    const filters = buildGrievanceFilters(req.query as any);
    const whereExpr = filters.length ? and(...filters) : undefined as any;
    const rows = await db.select({
      ticket_no: grievances.ticket_no,
      created_at: grievances.created_at,
      name: grievances.name,
      email: grievances.email,
      phone: grievances.phone,
      subject: grievances.subject,
      against_type: grievances.against_type,
      against_ref: grievances.against_ref,
      status: grievances.status,
      assigned_to_name: users.name,
      resolution_note: grievances.resolution_note,
      resolved_at: grievances.resolved_at,
      message: grievances.message,
    })
      .from(grievances)
      .leftJoin(users, eq(users.id, grievances.assigned_to))
      .where(whereExpr)
      .orderBy(desc(grievances.created_at))
      .limit(20_000);

    const csv = buildCsv(
      ["Ticket", "Raised", "Name", "Email", "Phone", "Subject", "Against",
       "Reference", "Status", "Assigned to", "Resolution note", "Resolved at", "Message"],
      rows,
      (r) => [
        r.ticket_no, r.created_at, r.name, r.email, r.phone,
        r.subject, r.against_type, r.against_ref, r.status,
        r.assigned_to_name, r.resolution_note, r.resolved_at, r.message,
      ],
    );
    sendCsv(res, "grievances", csv);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/grievances/stats ────────────────────────────────────────
// Counts per status — drives the inbox tab badges.
grievancesAdminRouter.get("/stats", async (_req, res, next) => {
  try {
    const result = await db.execute(sql`
      SELECT status, COUNT(*)::int AS n
      FROM grievances
      GROUP BY status
    `);
    const out: Record<string, number> = { open: 0, in_review: 0, resolved: 0, closed: 0 };
    for (const r of Array.from(result as Iterable<{ status: string; n: number }>)) {
      out[r.status] = r.n;
    }
    res.json(out);
  } catch (err) { next(err); }
});

// ─── PATCH /api/admin/grievances/:id ────────────────────────────────────────
// Edit any subset of: status, assigned_to, resolution_note,
// feature_in_newsletter. Setting status='resolved' or 'closed' stamps
// resolved_at; flipping feature_in_newsletter on stamps the chairperson's
// approval (the gating role is enforced by the calling user being admin —
// the spec says CP's discretion, and admin-CP overlap is fine for now).
grievancesAdminRouter.patch("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const body = req.body ?? {};
    const patch: Partial<typeof grievances.$inferInsert> = { updated_at: new Date() };

    if (body.status !== undefined) {
      if (!STATUSES.includes(body.status)) throw new ApiError(400, "Invalid status");
      patch.status = body.status;
      if (body.status === "resolved" || body.status === "closed") {
        patch.resolved_at = new Date();
      } else {
        patch.resolved_at = null;
      }
    }

    if (body.assigned_to !== undefined) {
      patch.assigned_to = body.assigned_to || null;
    }

    if (body.resolution_note !== undefined) {
      const note = trim(body.resolution_note);
      patch.resolution_note = note.length > 5000
        ? (() => { throw new ApiError(400, "Resolution note too long"); })()
        : note || null;
    }

    if (body.feature_in_newsletter !== undefined) {
      patch.feature_in_newsletter = Boolean(body.feature_in_newsletter);
      patch.newsletter_approved_by = patch.feature_in_newsletter ? (req.user?.id ?? null) : null;
      patch.newsletter_approved_at = patch.feature_in_newsletter ? new Date() : null;
    }

    const [row] = await db.update(grievances)
      .set(patch)
      .where(eq(grievances.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Grievance not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/grievances/newsletter-digest?from=…&to=… ────────────────
// Aggregate used by the monthly newsletter compile: counts raised + resolved
// in the date window, plus the list of chairperson-approved case-study
// grievances to embed verbatim.
grievancesAdminRouter.get("/newsletter-digest", async (req, res, next) => {
  try {
    const fromS = trim(req.query.from);
    const toS   = trim(req.query.to);
    if (!fromS || !toS) throw new ApiError(400, "from and to are required (YYYY-MM-DD)");
    const from = new Date(fromS);
    const to   = new Date(toS);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new ApiError(400, "from and to must be valid dates");
    }

    const raisedResult = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM grievances
      WHERE created_at >= ${from} AND created_at < ${to}
    `);
    const resolvedResult = await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM grievances
      WHERE resolved_at >= ${from} AND resolved_at < ${to}
    `);
    const featured = await db
      .select({
        ticket_no: grievances.ticket_no,
        subject: grievances.subject,
        message: grievances.message,
        resolution_note: grievances.resolution_note,
        resolved_at: grievances.resolved_at,
      })
      .from(grievances)
      .where(and(
        eq(grievances.feature_in_newsletter, true),
        isNotNull(grievances.newsletter_approved_at),
      ))
      .orderBy(desc(grievances.newsletter_approved_at))
      .limit(20);

    const raised   = Array.from(raisedResult   as Iterable<{ n: number }>)[0]?.n ?? 0;
    const resolved = Array.from(resolvedResult as Iterable<{ n: number }>)[0]?.n ?? 0;
    res.json({ raised, resolved, featured });
  } catch (err) { handleApiError(err, res, next); }
});

// ════════════════════════════════════════════════════════════════════════════
// Subject → email routes
// ════════════════════════════════════════════════════════════════════════════

grievanceRoutesAdminRouter.get("/", async (_req, res, next) => {
  try {
    const rows = await db.select().from(grievanceSubjectRoutes).orderBy(grievanceSubjectRoutes.subject);
    res.json({ items: rows });
  } catch (err) { next(err); }
});

grievanceRoutesAdminRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const subject     = need(trim(req.body?.subject).toLowerCase().replace(/[^a-z0-9_]/g, "_"), "Subject key");
    const label       = need(trim(req.body?.label), "Label");
    const route_email = need(trim(req.body?.route_email).toLowerCase(), "Route email");
    if (!EMAIL_RE.test(route_email)) throw new ApiError(400, "Route email is invalid");
    const active = req.body?.active === false ? false : true;

    const [row] = await db.insert(grievanceSubjectRoutes).values({
      subject, label, route_email, active,
      updated_by: req.user?.id ?? null,
      updated_at: new Date(),
    }).onConflictDoUpdate({
      target: grievanceSubjectRoutes.subject,
      set: { label, route_email, active, updated_by: req.user?.id ?? null, updated_at: new Date() },
    }).returning();
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

grievanceRoutesAdminRouter.patch("/:subject", async (req: AuthedRequest, res, next) => {
  try {
    const subject = String(req.params.subject);
    const patch: Partial<typeof grievanceSubjectRoutes.$inferInsert> = {
      updated_by: req.user?.id ?? null,
      updated_at: new Date(),
    };
    if (req.body?.label !== undefined)       patch.label = need(trim(req.body.label), "Label");
    if (req.body?.route_email !== undefined) {
      const email = trim(req.body.route_email).toLowerCase();
      if (!EMAIL_RE.test(email)) throw new ApiError(400, "Route email is invalid");
      patch.route_email = email;
    }
    if (req.body?.active !== undefined) patch.active = Boolean(req.body.active);

    const [row] = await db.update(grievanceSubjectRoutes)
      .set(patch)
      .where(eq(grievanceSubjectRoutes.subject, subject))
      .returning();
    if (!row) throw new ApiError(404, "Route not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

grievanceRoutesAdminRouter.delete("/:subject", async (req, res, next) => {
  try {
    const subject = String(req.params.subject);
    // Don't allow removing the "other" fallback — submissions to unknown
    // subjects rely on it as a safety net (see public POST).
    if (subject === "other") throw new ApiError(400, "Cannot delete the 'other' fallback route");
    const [row] = await db.delete(grievanceSubjectRoutes)
      .where(eq(grievanceSubjectRoutes.subject, subject))
      .returning();
    if (!row) throw new ApiError(404, "Route not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
