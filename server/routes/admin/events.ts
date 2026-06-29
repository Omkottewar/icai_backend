import { Router } from "express";
import { and, asc, desc, eq, ilike, isNull, ne, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../../db/client.js";
import { events, eventRegistrations, committees, branches, files, checklistInstances, checklistInstanceApprovals, eventOverrideLog } from "../../../schema/index.js";

// Same trick as the public route — `files` is joined twice on the GET /:id
// endpoint (banner + speaker photo) so we need an alias to disambiguate.
const speakerFilesAdmin = alias(files, "speaker_files");
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { requireRole } from "../../middleware/requireRole.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { storage } from "../../lib/storage.js";
import { expandRecurrence, specToRrule, type RecurrenceFreq } from "../../lib/recurrence.js";

// ─── Role gates for this router ─────────────────────────────────────────
// Every mutating endpoint (create / edit / delete / publish / cancel) is
// locked to admin + branch_chairman. Other admin-shell roles
// (committee_chairman, branch_treasurer, branch_secretary, branch_manager,
// accountant, etc.) can still SEE the events list — they need that to find
// and fill their checklist tasks — but cannot change event metadata.
// `requireRole` always allows `admin` as a universal override.
const canManageEvents = requireRole(["branch_chairman"]);

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

// ─── GET /api/admin/events ──────────────────────────────────────────────
// Scoping rule: a committee chairman who isn't otherwise branch leadership
// sees only events from the committees they chair. Branch leadership /
// admin / treasurer (etc.) see everything.
eventsAdminRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const q = trim(req.query.q);
    const status = trim(req.query.status);
    const committeeId = trim(req.query.committee_id);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    // Look up the requester's permissions to decide whether to scope.
    const perms = await (await import("../../auth/permissions.js")).loadUserPermissions(req.user!.id);
    const isBranchLevel = perms.isAdmin
      || perms.codes.has("branch_chairman")
      || perms.codes.has("branch_vice_chairman")
      || perms.codes.has("branch_secretary")
      || perms.codes.has("branch_treasurer")
      || perms.codes.has("branch_manager");

    const conds = [isNull(events.deleted_at)];
    if (status && STATUSES.includes(status as any)) conds.push(eq(events.status, status as any));
    if (committeeId) conds.push(eq(events.committee_id, committeeId));
    if (q) conds.push(ilike(events.title, `%${q}%`));

    // Committee chairman without branch-level role → restrict to their committees.
    if (!isBranchLevel && perms.committeeChairmanOf.length > 0) {
      conds.push(sql`${events.committee_id} = ANY(${perms.committeeChairmanOf})`);
    } else if (!isBranchLevel && perms.committeeChairmanOf.length === 0) {
      // No branch-level role AND no committees chaired → see nothing.
      return res.json({ rows: [], total: 0, page, pageSize });
    }

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
        gst_applicable: events.gst_applicable,
        gst_percent: events.gst_percent,
        capacity: events.capacity,
        registered_count: events.registered_count,
        banner_id: events.banner_id,
        created_at: events.created_at,
        instance_id: checklistInstances.id,
        instance_status: checklistInstances.status,
      })
      .from(events)
      .leftJoin(committees, eq(committees.id, events.committee_id))
      .leftJoin(checklistInstances, and(
        eq(checklistInstances.event_id, events.id),
        isNull(checklistInstances.deleted_at),
      ))
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
        banner_path: files.storage_path,
        banner_bucket: files.bucket,
        speaker_photo_path: speakerFilesAdmin.storage_path,
      })
      .from(events)
      .leftJoin(committees, eq(committees.id, events.committee_id))
      .leftJoin(branches, eq(branches.id, events.branch_id))
      .leftJoin(files, eq(files.id, events.banner_id))
      .leftJoin(speakerFilesAdmin, eq(speakerFilesAdmin.id, events.speaker_photo_id))
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
      banner_url: row.banner_path ? storage().url(row.banner_path) : null,
      speaker_photo_url: row.speaker_photo_path ? storage().url(row.speaker_photo_path) : null,
      registrations_total: regs,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/events ──────────────────────────────────────────────
// Create gate: admin + branch_chairman only.
eventsAdminRouter.post("/", canManageEvents, async (req: AuthedRequest, res, next) => {
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
    const gst_applicable = Boolean(req.body.gst_applicable);
    const gst_percent_n = req.body.gst_percent === undefined || req.body.gst_percent === ""
      ? 18
      : Number(req.body.gst_percent);
    if (!Number.isFinite(gst_percent_n) || gst_percent_n < 0 || gst_percent_n > 28) {
      throw new ApiError(400, "GST percent must be between 0 and 28");
    }
    const capacity = parseOptInt(req.body.capacity, "Capacity");
    const program_type = trim(req.body.program_type) || null;
    const highlights = parseHighlights(req.body.highlights);
    const banner_id = trim(req.body.banner_id) || null;
    const recurrence_rrule = trim(req.body.recurrence_rrule) || null;
    const speaker_name     = trim(req.body.speaker_name) || null;
    const speaker_bio      = trim(req.body.speaker_bio)  || null;
    const speaker_photo_id = trim(req.body.speaker_photo_id) || null;

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
        gst_applicable,
        gst_percent: gst_percent_n.toFixed(2),
        capacity,
        status: "draft",
        banner_id,
        recurrence_rrule,
        highlights,
        program_type,
        speaker_name,
        speaker_bio,
        speaker_photo_id,
        created_by: req.user!.id,
      })
      .returning();

    res.status(201).json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/admin/events/:id ─────────────────────────────────────────
// Edit gate: admin + branch_chairman only.
eventsAdminRouter.patch("/:id", canManageEvents, async (req, res, next) => {
  try {
    const id = String(req.params.id);
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
    if (req.body.gst_applicable !== undefined) patch.gst_applicable = Boolean(req.body.gst_applicable);
    if (req.body.gst_percent !== undefined) {
      const n = req.body.gst_percent === "" ? 18 : Number(req.body.gst_percent);
      if (!Number.isFinite(n) || n < 0 || n > 28) throw new ApiError(400, "GST percent must be between 0 and 28");
      patch.gst_percent = n.toFixed(2);
    }
    if (req.body.capacity !== undefined) patch.capacity = parseOptInt(req.body.capacity, "Capacity");
    if (req.body.program_type !== undefined) patch.program_type = trim(req.body.program_type) || null;
    if (req.body.highlights !== undefined) patch.highlights = parseHighlights(req.body.highlights);
    if (req.body.banner_id !== undefined) patch.banner_id = trim(req.body.banner_id) || null;
    if (req.body.recurrence_rrule !== undefined) patch.recurrence_rrule = trim(req.body.recurrence_rrule) || null;
    if (req.body.speaker_name !== undefined)     patch.speaker_name     = trim(req.body.speaker_name) || null;
    if (req.body.speaker_bio !== undefined)      patch.speaker_bio      = trim(req.body.speaker_bio)  || null;
    if (req.body.speaker_photo_id !== undefined) patch.speaker_photo_id = trim(req.body.speaker_photo_id) || null;

    // Status changes go through dedicated endpoints (publish/cancel).
    delete patch.status;

    const startsAt = patch.starts_at ?? existing.starts_at;
    const endsAt = patch.ends_at ?? existing.ends_at;
    if (endsAt <= startsAt) throw new ApiError(400, "End time must be after start time");

    const [row] = await db.update(events).set(patch).where(eq(events.id, id)).returning();
    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/events/:id/publish ──────────────────────────────────
// Branch chairman / admin only (gated by canManageEvents).
//
// Two paths:
//   1. Happy path: there's an attached checklist instance AND it's in
//      'approved' status. The endpoint just flips events.status to
//      'published'. (Note: the auto-publish trigger from migration 0012
//      already does this on checklist approval, so reaching here usually
//      means an event without a checklist OR a re-publish.)
//   2. Override path: the caller passes ?override=true. The event publishes
//      EVEN IF the checklist isn't fully approved. We record a row in
//      event_override_log with a JSON snapshot of stage states + the
//      optional reason text. This is the audit trail the chairman has to
//      account for at the next committee meeting.
//
// Without ?override=true AND with an incomplete checklist, the endpoint
// returns 400 — forcing the chairman to make an explicit decision rather
// than silently rubber-stamping.
eventsAdminRouter.post("/:id/publish", canManageEvents, async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const override = String(req.query.override ?? "") === "true";
    const reason = trim(req.body?.reason) || null;

    // All reads + writes happen inside a single transaction with a row lock
    // on the event. Without this, two admins clicking Publish at the same
    // moment both pass the "not yet published" check and both insert an
    // override audit row — producing duplicate audit entries (possibly with
    // contradictory reasons) for a single publish.
    const row = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(events)
        .where(and(eq(events.id, id), isNull(events.deleted_at)))
        .for("update")
        .limit(1);

      if (!existing) throw new ApiError(404, "Event not found");
      if (existing.status === "cancelled") throw new ApiError(400, "Cancelled events cannot be republished");
      // Idempotent: another concurrent caller already published. Return the
      // current state and skip the override-audit insert so we never write
      // a duplicate audit row.
      if (existing.status === "published") return existing;

      // Look for an attached checklist instance. Only one per event in
      // practice; we pick the most recent non-deleted one.
      const [inst] = await tx
        .select({ id: checklistInstances.id, status: checklistInstances.status })
        .from(checklistInstances)
        .where(and(eq(checklistInstances.event_id, id), isNull(checklistInstances.deleted_at)))
        .orderBy(desc(checklistInstances.created_at))
        .limit(1);

      if (inst && inst.status !== "approved" && !override) {
        throw new ApiError(400,
          "Checklist is not fully approved. To publish anyway, retry with ?override=true and optionally a reason in the body.",
        );
      }

      // Override audit row — only written if override path was used AND we
      // actually need to publish (i.e. status wasn't already 'published').
      if (override) {
        const stages = inst ? await tx
          .select({ stage_code: checklistInstanceApprovals.stage_code, status: checklistInstanceApprovals.status })
          .from(checklistInstanceApprovals)
          .where(eq(checklistInstanceApprovals.instance_id, inst.id))
          : [];
        const stateSnapshot: Record<string, string> = {};
        for (const s of stages) stateSnapshot[s.stage_code] = s.status;
        stateSnapshot._instance_status = inst?.status ?? "(no checklist)";

        await tx.insert(eventOverrideLog).values({
          event_id: id,
          actor_id: req.user?.id ?? null,
          reason,
          checklist_state: stateSnapshot,
        });
      }

      const [updated] = await tx.update(events)
        .set({ status: "published", updated_at: new Date() })
        .where(eq(events.id, id))
        .returning();
      return updated;
    });

    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ POST /api/admin/events/:id/cancel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
eventsAdminRouter.post("/:id/cancel", canManageEvents, async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [existing] = await db.select().from(events).where(and(eq(events.id, id), isNull(events.deleted_at))).limit(1);
    if (!existing) throw new ApiError(404, "Event not found");
    if (existing.status === "cancelled") return res.json(existing);
    const [row] = await db.update(events).set({ status: "cancelled", updated_at: new Date() }).where(eq(events.id, id)).returning();
    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ DELETE /api/admin/events/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
eventsAdminRouter.delete("/:id", canManageEvents, async (req, res, next) => {
  try {
    const id = String(req.params.id);
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

// ─── GET /api/admin/events/:id/comparables ──────────────────────────────
// Returns up to 5 past events from the same committee with attendance +
// fee data so the chairman has context when approving / publishing. This
// powers the "comparable events" panel in the event drawer.
//
// Comparable = same committee, status='completed' OR past starts_at,
// ordered by starts_at DESC. We also project registered_count and
// attended count so the approver can eyeball capacity / no-show rates.
eventsAdminRouter.get("/:id/comparables", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [target] = await db
      .select({ id: events.id, committee_id: events.committee_id })
      .from(events)
      .where(and(eq(events.id, id), isNull(events.deleted_at)))
      .limit(1);
    if (!target) throw new ApiError(404, "Event not found");
    if (!target.committee_id) return res.json({ rows: [], summary: null });

    const rows = await db
      .select({
        id:               events.id,
        title:            events.title,
        starts_at:        events.starts_at,
        capacity:         events.capacity,
        fee_paise:        events.fee_paise,
        registered_count: events.registered_count,
        attended_count: sql<number>`(
          SELECT COUNT(*)::int FROM event_registrations er
          WHERE er.event_id = ${events.id}
            AND er.status = 'attended'
            AND er.deleted_at IS NULL
        )`.as("attended_count"),
      })
      .from(events)
      .where(and(
        eq(events.committee_id, target.committee_id),
        ne(events.id, id),
        isNull(events.deleted_at),
        sql`${events.starts_at} < NOW()`,
      ))
      .orderBy(desc(events.starts_at))
      .limit(5);

    // Aggregate quick numbers for the panel headline.
    const summary = rows.length > 0 ? {
      avg_registered: Math.round(rows.reduce((s, r) => s + (r.registered_count ?? 0), 0) / rows.length),
      avg_attended:   Math.round(rows.reduce((s, r) => s + (r.attended_count ?? 0), 0) / rows.length),
      avg_fee_paise:  Math.round(rows.reduce((s, r) => s + (r.fee_paise ?? 0), 0) / rows.length),
      sample_size:    rows.length,
    } : null;

    res.json({ rows, summary });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/events/:id/repeat ────────────────────────────────────
// Materialise N follow-on occurrences from a "seed" event. Each occurrence
// is a real events row that inherits the seed's metadata except dates;
// children are linked via recurrence_parent_id so the series can be
// queried + edited as a group later.
//
// Body: { freq: 'DAILY'|'WEEKLY'|'MONTHLY', interval?: int, count?: int, until?: iso }
// Provide one of count/until. Hard cap: 52 children per call.
eventsAdminRouter.post("/:id/repeat", canManageEvents, async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    const freq = trim(req.body?.freq);
    if (!["DAILY", "WEEKLY", "MONTHLY"].includes(freq)) {
      throw new ApiError(400, "freq must be one of DAILY, WEEKLY, MONTHLY");
    }
    const interval = req.body?.interval != null ? Math.max(1, Number(req.body.interval)) : 1;
    const count = req.body?.count != null ? Math.min(52, Math.max(2, Number(req.body.count))) : null;
    const until = req.body?.until ? new Date(req.body.until) : null;
    if (!count && !until) throw new ApiError(400, "Provide either 'count' or 'until'");

    const [seed] = await db
      .select()
      .from(events)
      .where(and(eq(events.id, id), isNull(events.deleted_at)))
      .limit(1);
    if (!seed) throw new ApiError(404, "Event not found");
    if (seed.recurrence_parent_id) {
      throw new ApiError(400, "This event is already a child of another series — expand from the parent");
    }

    const occurrences = expandRecurrence(seed.starts_at, seed.ends_at, {
      freq: freq as RecurrenceFreq,
      interval,
      count: count ?? undefined,
      until,
    });

    // First occurrence is the seed itself — write the rrule onto it.
    const rrule = specToRrule({ freq: freq as RecurrenceFreq, interval, count: count ?? undefined, until });
    await db.update(events)
      .set({ recurrence_rrule: rrule, updated_at: new Date() })
      .where(eq(events.id, seed.id));

    // Build child rows from index 1 onwards.
    const children = occurrences.slice(1);
    const inserted: Array<{ id: string; slug: string; starts_at: Date }> = [];
    let i = 2;
    for (const occ of children) {
      // Suffix slug with the occurrence's date so each is unique + readable.
      const dateTag = occ.start.toISOString().slice(0, 10);
      const baseSlug = `${seed.slug.replace(/-\d{4}-\d{2}-\d{2}$/, "")}-${dateTag}`;
      const slug = await uniqueSlug(baseSlug);

      const [row] = await db.insert(events).values({
        slug,
        title: seed.title,
        description: seed.description,
        committee_id: seed.committee_id,
        branch_id: seed.branch_id,
        audience: seed.audience,
        mode: seed.mode,
        venue: seed.venue,
        online_url: seed.online_url,
        starts_at: occ.start,
        ends_at: occ.end,
        cpe_hours: seed.cpe_hours,
        fee_paise: seed.fee_paise,
        capacity: seed.capacity,
        registered_count: 0,
        status: seed.status,
        banner_id: seed.banner_id,
        recurrence_parent_id: seed.id,
        recurrence_rrule: rrule,
        highlights: seed.highlights,
        program_type: seed.program_type,
        created_by: req.user!.id,
      }).returning({ id: events.id, slug: events.slug, starts_at: events.starts_at });
      inserted.push(row);
      i++;
    }

    res.status(201).json({
      seed_id: seed.id,
      rrule,
      occurrences: occurrences.length,
      created: inserted.length,
      children: inserted,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/events/:id/series ─────────────────────────────────────
// Return the full series this event belongs to (seed + every child). Used
// by the admin UI's "Edit series" flow to choose between "this occurrence"
// and "all occurrences".
eventsAdminRouter.get("/:id/series", async (req, res, next) => {
  try {
    const id = trim(req.params.id);
    const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!event) throw new ApiError(404, "Event not found");

    const seedId = event.recurrence_parent_id ?? event.id;
    const series = await db
      .select({
        id: events.id,
        slug: events.slug,
        title: events.title,
        starts_at: events.starts_at,
        ends_at: events.ends_at,
        status: events.status,
        registered_count: events.registered_count,
        is_seed: sql<boolean>`${events.id} = ${seedId}`.as("is_seed"),
      })
      .from(events)
      .where(and(
        sql`(${events.id} = ${seedId} OR ${events.recurrence_parent_id} = ${seedId})`,
        isNull(events.deleted_at),
      ))
      .orderBy(asc(events.starts_at));

    res.json({ seed_id: seedId, rows: series });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/admin/events/:id/series ───────────────────────────────────
// Apply a patch to every event in the series (or to future occurrences
// only via ?from=future). Body shape is the same as PATCH /:id — only
// fields you include get updated. Useful for "rename the whole series"
// or "change the venue from next week onwards".
eventsAdminRouter.patch("/:id/series", canManageEvents, async (req, res, next) => {
  try {
    const id = trim(req.params.id);
    const scope = trim(req.query.from) === "future" ? "future" : "all";

    const [event] = await db.select().from(events).where(eq(events.id, id)).limit(1);
    if (!event) throw new ApiError(404, "Event not found");
    const seedId = event.recurrence_parent_id ?? event.id;

    const patch: Record<string, unknown> = {};
    if ("title" in req.body)        patch.title = trim(req.body.title);
    if ("description" in req.body)  patch.description = trim(req.body.description) || null;
    if ("venue" in req.body)        patch.venue = trim(req.body.venue) || null;
    if ("online_url" in req.body)   patch.online_url = trim(req.body.online_url) || null;
    if ("audience" in req.body)     patch.audience = pickAudience(req.body.audience);
    if ("mode" in req.body)         patch.mode = pickMode(req.body.mode);
    if ("fee_paise" in req.body)    patch.fee_paise = parseOptInt(req.body.fee_paise, "fee_paise") ?? 0;
    if ("capacity" in req.body)     patch.capacity = parseOptInt(req.body.capacity, "capacity");
    if ("highlights" in req.body)   patch.highlights = parseHighlights(req.body.highlights);
    if (Object.keys(patch).length === 0) throw new ApiError(400, "Provide at least one field to update");
    patch.updated_at = new Date();

    const conds: any[] = [
      sql`(${events.id} = ${seedId} OR ${events.recurrence_parent_id} = ${seedId})`,
      isNull(events.deleted_at),
    ];
    if (scope === "future") {
      conds.push(sql`${events.starts_at} >= ${event.starts_at}`);
    }

    const result = await db.update(events).set(patch as any).where(and(...conds)).returning({ id: events.id });
    res.json({ ok: true, updated: result.length, scope });
  } catch (err) { handleApiError(err, res, next); }
});


