import { Router } from "express";
import { and, asc, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { events, eventRegistrations, committees, branches, files, eventChecklists } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const eventsAdminRouter = Router();

// â”€â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const AUDIENCES = ["members", "students", "all"] as const;
const MODES = ["in_person", "online", "hybrid"] as const;
const STATUSES = ["draft", "pending_approval", "approved", "published", "cancelled", "completed"] as const;

function slugify(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

async function uniqueSlug(base: string, excludeId?: string): Promise<string> {
  let slug = base || "event";
  let i = 1;
  while (true) {
    const candidate = i === 1 ? slug : `${slug}-${i}`;
    const rows = await db.select({ id: events.id }).from(events).where(eq(events.slug, candidate)).limit(1);
    if (!rows[0] || rows[0].id === excludeId) return candidate;
    i++;
    if (i > 50) throw new ApiError(500, "Could not generate a unique slug");
  }
}

function pickAudience(v: unknown) {
  return AUDIENCES.includes(v as any) ? (v as typeof AUDIENCES[number]) : "members";
}
function pickMode(v: unknown) {
  return MODES.includes(v as any) ? (v as typeof MODES[number]) : "in_person";
}

function parseDate(v: unknown, label: string): Date {
  const s = trim(v);
  if (!s) throw new ApiError(400, `${label} is required`);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new ApiError(400, `${label} is not a valid date`);
  return d;
}

function parseOptInt(v: unknown, label: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, `${label} must be a non-negative number`);
  return Math.floor(n);
}

function parseHighlights(v: unknown): string[] | null {
  if (!v) return null;
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === "string") return v.split("\n").map((x) => x.trim()).filter(Boolean);
  return null;
}

// â”€â”€â”€ GET /api/admin/events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
eventsAdminRouter.get("/", async (req, res, next) => {
  try {
    const q = trim(req.query.q);
    const status = trim(req.query.status);
    const committeeId = trim(req.query.committee_id);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const conds = [isNull(events.deleted_at)];
    if (status && STATUSES.includes(status as any)) conds.push(eq(events.status, status as any));
    if (committeeId) conds.push(eq(events.committee_id, committeeId));
    if (q) conds.push(ilike(events.title, `%${q}%`));

    const rows = await db
      .select({
        id: events.id,
        slug: events.slug,
        title: events.title,
        starts_at: events.starts_at,
        ends_at: events.ends_at,
        committee_id: events.committee_id,
        committee_name: committees.name,
        audience: events.audience,
        mode: events.mode,
        venue: events.venue,
        status: events.status,
        cpe_hours: events.cpe_hours,
        fee_paise: events.fee_paise,
        capacity: events.capacity,
        registered_count: events.registered_count,
        banner_id: events.banner_id,
        created_at: events.created_at,
        checklist_id: eventChecklists.id,
        checklist_status: eventChecklists.status,
      })
      .from(events)
      .leftJoin(committees, eq(committees.id, events.committee_id))
      .leftJoin(eventChecklists, eq(eventChecklists.event_id, events.id))
      .where(and(...conds))
      .orderBy(desc(events.starts_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(events)
      .where(and(...conds));

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ GET /api/admin/events/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
eventsAdminRouter.get("/:id", async (req, res, next) => {
  try {
    const [row] = await db
      .select({
        event: events,
        committee_name: committees.name,
        branch_name: branches.name,
        banner_path: files.storagePath,
        banner_bucket: files.bucket,
      })
      .from(events)
      .leftJoin(committees, eq(committees.id, events.committee_id))
      .leftJoin(branches, eq(branches.id, events.branch_id))
      .leftJoin(files, eq(files.id, events.banner_id))
      .where(and(eq(events.id, req.params.id), isNull(events.deleted_at)))
      .limit(1);
    if (!row) throw new ApiError(404, "Event not found");

    const [{ regs }] = await db
      .select({ regs: sql<number>`count(*)::int`.as("regs") })
      .from(eventRegistrations)
      .where(and(eq(eventRegistrations.event_id, req.params.id), isNull(eventRegistrations.deleted_at)));

    res.json({
      ...row.event,
      committee_name: row.committee_name,
      branch_name: row.branch_name,
      banner_url: row.banner_path ? `/uploads/${row.banner_path}` : null,
      registrations_total: regs,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ POST /api/admin/events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
eventsAdminRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const title = need(trim(req.body.title), "Title");
    const committee_id = need(trim(req.body.committee_id), "Committee");
    const starts_at = parseDate(req.body.starts_at, "Start time");
    const ends_at = parseDate(req.body.ends_at, "End time");
    if (ends_at <= starts_at) throw new ApiError(400, "End time must be after start time");

    const audience = pickAudience(req.body.audience);
    const mode = pickMode(req.body.mode);
    const venue = trim(req.body.venue) || null;
    const online_url = trim(req.body.online_url) || null;
    if (mode === "online" && !online_url) throw new ApiError(400, "Online URL is required for online events");
    if (mode !== "online" && !venue) throw new ApiError(400, "Venue is required for in-person/hybrid events");

    const description = trim(req.body.description) || null;
    const branch_id = trim(req.body.branch_id) || null;
    const cpe_hours_n = req.body.cpe_hours === undefined || req.body.cpe_hours === "" ? 0 : Number(req.body.cpe_hours);
    if (!Number.isFinite(cpe_hours_n) || cpe_hours_n < 0) throw new ApiError(400, "CPE hours must be a non-negative number");
    const fee_paise = parseOptInt(req.body.fee_paise, "Fee") ?? 0;
    const capacity = parseOptInt(req.body.capacity, "Capacity");
    const program_type = trim(req.body.program_type) || null;
    const highlights = parseHighlights(req.body.highlights);
    const banner_id = trim(req.body.banner_id) || null;
    const recurrence_rrule = trim(req.body.recurrence_rrule) || null;

    const slug = await uniqueSlug(trim(req.body.slug) ? slugify(trim(req.body.slug)) : slugify(title));

    const [row] = await db
      .insert(events)
      .values({
        slug,
        title,
        description,
        committee_id,
        branch_id,
        audience,
        mode,
        venue,
        online_url,
        starts_at,
        ends_at,
        cpe_hours: cpe_hours_n.toFixed(1),
        fee_paise,
        capacity,
        status: "draft",
        banner_id,
        recurrence_rrule,
        highlights,
        program_type,
        created_by: req.user!.id,
      })
      .returning();

    res.status(201).json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ PATCH /api/admin/events/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
eventsAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const [existing] = await db.select().from(events).where(and(eq(events.id, id), isNull(events.deleted_at))).limit(1);
    if (!existing) throw new ApiError(404, "Event not found");

    const patch: Record<string, any> = { updated_at: new Date() };

    if (req.body.title !== undefined) {
      const title = need(trim(req.body.title), "Title");
      patch.title = title;
    }
    if (req.body.slug !== undefined) {
      const desired = slugify(trim(req.body.slug));
      patch.slug = await uniqueSlug(desired || slugify(existing.title), id);
    }
    if (req.body.description !== undefined) patch.description = trim(req.body.description) || null;
    if (req.body.committee_id !== undefined) patch.committee_id = need(trim(req.body.committee_id), "Committee");
    if (req.body.branch_id !== undefined) patch.branch_id = trim(req.body.branch_id) || null;
    if (req.body.audience !== undefined) patch.audience = pickAudience(req.body.audience);
    if (req.body.mode !== undefined) patch.mode = pickMode(req.body.mode);
    if (req.body.venue !== undefined) patch.venue = trim(req.body.venue) || null;
    if (req.body.online_url !== undefined) patch.online_url = trim(req.body.online_url) || null;
    if (req.body.starts_at !== undefined) patch.starts_at = parseDate(req.body.starts_at, "Start time");
    if (req.body.ends_at !== undefined) patch.ends_at = parseDate(req.body.ends_at, "End time");
    if (req.body.cpe_hours !== undefined) {
      const n = Number(req.body.cpe_hours);
      if (!Number.isFinite(n) || n < 0) throw new ApiError(400, "CPE hours must be a non-negative number");
      patch.cpe_hours = n.toFixed(1);
    }
    if (req.body.fee_paise !== undefined) patch.fee_paise = parseOptInt(req.body.fee_paise, "Fee") ?? 0;
    if (req.body.capacity !== undefined) patch.capacity = parseOptInt(req.body.capacity, "Capacity");
    if (req.body.program_type !== undefined) patch.program_type = trim(req.body.program_type) || null;
    if (req.body.highlights !== undefined) patch.highlights = parseHighlights(req.body.highlights);
    if (req.body.banner_id !== undefined) patch.banner_id = trim(req.body.banner_id) || null;
    if (req.body.recurrence_rrule !== undefined) patch.recurrence_rrule = trim(req.body.recurrence_rrule) || null;

    // Status changes go through dedicated endpoints (publish/cancel).
    delete patch.status;

    const startsAt = patch.starts_at ?? existing.starts_at;
    const endsAt = patch.ends_at ?? existing.ends_at;
    if (endsAt <= startsAt) throw new ApiError(400, "End time must be after start time");

    const [row] = await db.update(events).set(patch).where(eq(events.id, id)).returning();
    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ POST /api/admin/events/:id/publish â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
eventsAdminRouter.post("/:id/publish", async (req, res, next) => {
  try {
    const id = req.params.id;
    const [existing] = await db.select().from(events).where(and(eq(events.id, id), isNull(events.deleted_at))).limit(1);
    if (!existing) throw new ApiError(404, "Event not found");
    if (existing.status === "cancelled") throw new ApiError(400, "Cancelled events cannot be republished");
    if (existing.status === "published") return res.json(existing);
    const [row] = await db.update(events).set({ status: "published", updated_at: new Date() }).where(eq(events.id, id)).returning();
    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ POST /api/admin/events/:id/cancel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
eventsAdminRouter.post("/:id/cancel", async (req, res, next) => {
  try {
    const id = req.params.id;
    const [existing] = await db.select().from(events).where(and(eq(events.id, id), isNull(events.deleted_at))).limit(1);
    if (!existing) throw new ApiError(404, "Event not found");
    if (existing.status === "cancelled") return res.json(existing);
    const [row] = await db.update(events).set({ status: "cancelled", updated_at: new Date() }).where(eq(events.id, id)).returning();
    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ DELETE /api/admin/events/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
eventsAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const [row] = await db.update(events).set({ deleted_at: new Date() }).where(and(eq(events.id, id), isNull(events.deleted_at))).returning();
    if (!row) throw new ApiError(404, "Event not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ GET /api/admin/events/_meta/lookups â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns committee + branch dropdown options for the create/edit form.
eventsAdminRouter.get("/_meta/lookups", async (_req, res, next) => {
  try {
    const cs = await db.select({ id: committees.id, code: committees.code, name: committees.name }).from(committees).where(eq(committees.active, true)).orderBy(asc(committees.name));
    const bs = await db.select({ id: branches.id, code: branches.code, name: branches.name }).from(branches).where(eq(branches.active, true)).orderBy(asc(branches.name));
    res.json({ committees: cs, branches: bs });
  } catch (err) { handleApiError(err, res, next); }
});
