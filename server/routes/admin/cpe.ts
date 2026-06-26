// Admin CPE credits API.
//
// Lets branch admin issue and review CPE credits for members. The
// member-facing dashboard reads from cpe_credits already (see
// routes/dashboard.ts); this router is the write surface that was missing.
//
// Three flows:
//   1. List + filter credits (by user, year, type, source).
//   2. Issue a single credit (manual — e.g. external CPE programmes the
//      branch wants to recognise).
//   3. Bulk-issue from a past event — pulls every 'attended' registrant
//      and grants them the event's cpe_hours. Idempotent: NOT EXISTS
//      guard against the existing (user_id, event_id) pair.
//   4. Soft-delete a credit (sets deleted_at) so accidental issues can be
//      revoked without losing the audit trail.
//
// ICAI compliance is computed client-side from the list endpoint — see
// frontend/src/pages/admin/CpeAdminPage.jsx. Rules: 120 hrs / 3-year
// block for full-time practitioners (90 structured + 30 unstructured min),
// 60 hrs / 3-year block for others. Current block is 2023–2025.
//
// Mounted at /api/admin/cpe (see routes/admin/index.ts). The parent
// adminRouter already applies requireUser + requireAdmin.

import { Router } from "express";
import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { cpeCredits, users, events } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const cpeAdminRouter = Router();

const TYPES = ["structured", "unstructured"] as const;

// ─── GET /api/admin/cpe ───────────────────────────────────────────────────
// List credits with optional filters:
//   ?user_id=<uuid>  ?year=<int>  ?type=structured|unstructured
//   ?source=<text>   ?q=<user name/email/MRN substring>
//   ?page=  ?pageSize=
cpeAdminRouter.get("/", async (req, res, next) => {
  try {
    const user_id = trim(req.query.user_id);
    const year = Number(req.query.year);
    const type = trim(req.query.type);
    const source = trim(req.query.source);
    const q = trim(req.query.q);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(5, Number(req.query.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    const conds: any[] = [isNull(cpeCredits.deleted_at)];
    if (user_id) conds.push(eq(cpeCredits.user_id, user_id));
    if (Number.isFinite(year)) conds.push(eq(cpeCredits.year, year));
    if (type && (TYPES as readonly string[]).includes(type)) conds.push(eq(cpeCredits.type, type as any));
    if (source) conds.push(eq(cpeCredits.source, source));
    if (q) conds.push(sql`(${users.name} ILIKE ${`%${q}%`} OR ${users.email} ILIKE ${`%${q}%`})`);

    const rows = await db
      .select({
        id: cpeCredits.id,
        user_id: cpeCredits.user_id,
        user_name: users.name,
        user_email: users.email,
        event_id: cpeCredits.event_id,
        event_title: events.title,
        hours: cpeCredits.hours,
        type: cpeCredits.type,
        year: cpeCredits.year,
        source: cpeCredits.source,
        issued_at: cpeCredits.issued_at,
        certificate_file_id: cpeCredits.certificate_file_id,
      })
      .from(cpeCredits)
      .leftJoin(users, eq(users.id, cpeCredits.user_id))
      .leftJoin(events, eq(events.id, cpeCredits.event_id))
      .where(and(...conds))
      .orderBy(desc(cpeCredits.issued_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(cpeCredits)
      .leftJoin(users, eq(users.id, cpeCredits.user_id))
      .where(and(...conds));

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/cpe/compliance/:user_id ───────────────────────────────
// Returns a member's structured / unstructured / total CPE hours for the
// current 3-year compliance block (default 2023–2025; configurable via
// ?from_year=&to_year=). The frontend shows a progress bar against the
// 120hr target for full-time practitioners.
cpeAdminRouter.get("/compliance/:user_id", async (req, res, next) => {
  try {
    const userId = trim(req.params.user_id);
    if (!userId) throw new ApiError(400, "user_id is required");

    const fromYear = Number(req.query.from_year) || (new Date().getFullYear() - 2);
    const toYear = Number(req.query.to_year) || new Date().getFullYear();

    const rows = await db
      .select({
        year: cpeCredits.year,
        type: cpeCredits.type,
        hours: sql<string>`coalesce(sum(${cpeCredits.hours}), 0)::text`.as("hours"),
      })
      .from(cpeCredits)
      .where(and(
        eq(cpeCredits.user_id, userId),
        isNull(cpeCredits.deleted_at),
        gte(cpeCredits.year, fromYear),
        lt(cpeCredits.year, toYear + 1),
      ))
      .groupBy(cpeCredits.year, cpeCredits.type);

    const byYear: Record<number, { structured: number; unstructured: number; total: number }> = {};
    let totalStructured = 0;
    let totalUnstructured = 0;
    for (const r of rows) {
      const yr = r.year;
      const h = Number(r.hours);
      if (!byYear[yr]) byYear[yr] = { structured: 0, unstructured: 0, total: 0 };
      if (r.type === "structured") { byYear[yr].structured += h; totalStructured += h; }
      else { byYear[yr].unstructured += h; totalUnstructured += h; }
      byYear[yr].total += h;
    }

    res.json({
      user_id: userId,
      from_year: fromYear,
      to_year: toYear,
      by_year: byYear,
      total: {
        structured: totalStructured,
        unstructured: totalUnstructured,
        all: totalStructured + totalUnstructured,
      },
      // ICAI thresholds — full-time CA in practice
      threshold: { total: 120, structured_min: 90 },
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/cpe ──────────────────────────────────────────────────
// Issue a single CPE credit manually.
// Body: { user_id, event_id?, hours, type, year, source? }
cpeAdminRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const user_id = need(req.body?.user_id, "user_id");
    const hours = Number(req.body?.hours);
    if (!Number.isFinite(hours) || hours <= 0 || hours > 40) {
      throw new ApiError(400, "hours must be a positive number ≤ 40");
    }
    const type = trim(req.body?.type);
    if (!(TYPES as readonly string[]).includes(type)) {
      throw new ApiError(400, `type must be one of: ${TYPES.join(", ")}`);
    }
    const year = Number(req.body?.year) || new Date().getFullYear();
    const event_id = trim(req.body?.event_id) || null;
    const source = trim(req.body?.source) || (event_id ? "branch_event" : "admin_issued");

    const [row] = await db
      .insert(cpeCredits)
      .values({
        user_id,
        event_id,
        hours: String(hours),
        type: type as any,
        year,
        source,
      })
      .returning();

    res.status(201).json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/cpe/bulk-issue-from-event/:event_id ──────────────────
// Bulk-issue credits to every 'attended' registrant of a past event.
// Idempotent — skips users who already have a credit for (user_id, event_id).
//
// Returns: { event_id, event_title, cpe_hours, eligible: N, issued: M, skipped: N-M }
cpeAdminRouter.post("/bulk-issue-from-event/:event_id", async (req: AuthedRequest, res, next) => {
  try {
    const eventId = trim(req.params.event_id);
    if (!eventId) throw new ApiError(400, "event_id is required");

    const [event] = await db
      .select({
        id: events.id,
        title: events.title,
        cpe_hours: events.cpe_hours,
        starts_at: events.starts_at,
      })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1);
    if (!event) throw new ApiError(404, "Event not found");
    if (Number(event.cpe_hours) <= 0) {
      throw new ApiError(400, "This event has no CPE hours configured — nothing to issue");
    }

    const year = new Date(event.starts_at).getFullYear();
    // Find attended registrants who don't already have a CPE row for this event.
    const eligible = (await db.execute(sql`
      SELECT er.user_id
      FROM event_registrations er
      WHERE er.event_id = ${eventId}
        AND er.status = 'attended'
        AND er.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM cpe_credits c
          WHERE c.user_id = er.user_id AND c.event_id = ${eventId} AND c.deleted_at IS NULL
        )
    `)) as unknown as Array<{ user_id: string }>;

    const eligibleCount = eligible.length;
    if (eligibleCount === 0) {
      return res.json({ event_id: eventId, event_title: event.title, cpe_hours: event.cpe_hours, eligible: 0, issued: 0, skipped: 0 });
    }

    // Bulk insert. Chunk in case the event had thousands of attendees.
    const BATCH = 500;
    let issued = 0;
    for (let off = 0; off < eligible.length; off += BATCH) {
      const chunk = eligible.slice(off, off + BATCH).map((r) => ({
        user_id: r.user_id,
        event_id: eventId,
        hours: String(event.cpe_hours),
        type: "structured" as const,
        year,
        source: "branch_event",
      }));
      const result = await db.insert(cpeCredits).values(chunk).returning({ id: cpeCredits.id });
      issued += result.length;
    }

    res.json({
      event_id: eventId,
      event_title: event.title,
      cpe_hours: event.cpe_hours,
      eligible: eligibleCount,
      issued,
      skipped: eligibleCount - issued,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/admin/cpe/:id ────────────────────────────────────────────
// Soft-revoke a CPE credit. Keeps the row for audit; member CPE totals
// exclude soft-deleted rows.
cpeAdminRouter.delete("/:id", async (_req, res, next) => {
  try {
    const [row] = await db
      .update(cpeCredits)
      .set({ deleted_at: new Date() })
      .where(and(eq(cpeCredits.id, _req.params.id), isNull(cpeCredits.deleted_at)))
      .returning({ id: cpeCredits.id });
    if (!row) throw new ApiError(404, "CPE credit not found or already revoked");
    res.json({ ok: true, id: row.id });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/cpe/_meta/events ──────────────────────────────────────
// Lightweight event picker for the "bulk-issue" modal — only past events
// with cpe_hours > 0 are useful. Returns max 100 most-recent matches.
cpeAdminRouter.get("/_meta/events", async (req, res, next) => {
  try {
    const q = trim(req.query.q);
    const conds: any[] = [
      isNull(events.deleted_at),
      sql`${events.cpe_hours} > 0`,
      sql`${events.starts_at} <= now()`,
    ];
    if (q) conds.push(sql`${events.title} ILIKE ${`%${q}%`}`);

    const rows = await db
      .select({
        id: events.id,
        title: events.title,
        starts_at: events.starts_at,
        cpe_hours: events.cpe_hours,
        registered_count: events.registered_count,
      })
      .from(events)
      .where(and(...conds))
      .orderBy(desc(events.starts_at))
      .limit(100);

    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});
