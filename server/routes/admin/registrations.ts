import { Router } from "express";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { eventRegistrations, events, users, committees } from "../../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { buildCsv, sendCsv } from "../../lib/csv.js";

export const registrationsAdminRouter = Router();

const STATUSES = ["registered", "waitlisted", "cancelled", "attended", "no_show"] as const;
const MODES    = ["in_person", "online", "hybrid"] as const;

// Shared filter builder — used by the list and CSV export endpoints so
// filters stay in sync. `event_ids` (comma-separated) is the multi-event
// variant used for combined exports; single `event_id` is kept for
// backwards compatibility.
function buildRegistrationFilters(query: Record<string, unknown>) {
  const q            = trim(query.q);
  const event_id     = trim(query.event_id);
  const event_ids    = trim(query.event_ids); // comma-separated UUIDs
  const user_id      = trim(query.user_id);
  const committee_id = trim(query.committee_id);
  const status       = trim(query.status);
  const mode         = trim(query.mode);
  const attended     = trim(query.attended);            // 'yes' | 'no'
  const fromDate     = trim(query.from);
  const toDate       = trim(query.to);
  const when         = trim(query.when);                // 'upcoming' | 'past'

  const conds: any[] = [isNull(eventRegistrations.deleted_at)];

  // Multi-event takes precedence over single event_id when both are
  // supplied — the multi-select picker on the frontend sends
  // `event_ids=uuid1,uuid2,uuid3`.
  if (event_ids) {
    const ids = event_ids.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length > 0) conds.push(inArray(eventRegistrations.event_id, ids));
  } else if (event_id) {
    conds.push(eq(eventRegistrations.event_id, event_id));
  }

  if (user_id)  conds.push(eq(eventRegistrations.user_id, user_id));
  if (status && STATUSES.includes(status as any)) conds.push(eq(eventRegistrations.status, status as any));
  if (mode && MODES.includes(mode as any)) conds.push(eq(events.mode, mode as any));
  if (committee_id) conds.push(eq(events.committee_id, committee_id));
  if (q) conds.push(or(
    ilike(users.name,  `%${q}%`),
    ilike(users.email, `%${q}%`),
    ilike(events.title, `%${q}%`),
  )!);
  if (attended === "yes") conds.push(sql`${eventRegistrations.attended_at} IS NOT NULL`);
  else if (attended === "no") conds.push(sql`${eventRegistrations.attended_at} IS NULL`);
  if (fromDate) conds.push(sql`${events.starts_at} >= ${fromDate}::timestamptz`);
  if (toDate)   conds.push(sql`${events.starts_at} <  (${toDate}::date + INTERVAL '1 day')`);
  if (when === "upcoming") conds.push(sql`${events.starts_at} >= now()`);
  else if (when === "past") conds.push(sql`${events.starts_at} <  now()`);

  return conds;
}

// ─── GET /api/admin/registrations ────────────────────────────────────────
// Filters (all optional):
//   q            — attendee name / email / event title (ILIKE)
//   event_id     — exact event (single)
//   event_ids    — comma-separated UUIDs for multi-event filter
//   user_id      — exact user
//   committee_id — filter by the event's committee
//   status       — registration status
//   mode         — event mode (in_person / online / hybrid)
//   attended     — 'yes' → attended_at IS NOT NULL, 'no' → IS NULL
//   from / to    — event.starts_at date range (yyyy-mm-dd)
//   when         — 'upcoming' / 'past' shortcut on event.starts_at
// Sort:
//   sort  — registered_at | attended_at | event_starts_at | user_name | event_title | status
//   dir   — asc | desc
registrationsAdminRouter.get("/", async (req, res, next) => {
  try {
    const sort         = trim(req.query.sort) || "registered_at";
    const dir          = trim(req.query.dir).toLowerCase() === "asc" ? "asc" : "desc";
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(5, Number(req.query.pageSize) || 50));

    const conds = buildRegistrationFilters(req.query as any);

    // Whitelisted sort column → SQL expression. Anything unknown falls
    // back to registered_at so a URL tweak can't 500 the endpoint.
    const orderExpr = (() => {
      const isAsc = dir === "asc";
      switch (sort) {
        case "event_starts_at": return isAsc ? asc(events.starts_at)             : desc(events.starts_at);
        case "user_name":       return isAsc ? asc(users.name)                    : desc(users.name);
        case "event_title":     return isAsc ? asc(events.title)                  : desc(events.title);
        case "status":          return isAsc ? asc(eventRegistrations.status)     : desc(eventRegistrations.status);
        case "attended_at":     return isAsc ? asc(eventRegistrations.attended_at): desc(eventRegistrations.attended_at);
        default:                return isAsc ? asc(eventRegistrations.registered_at) : desc(eventRegistrations.registered_at);
      }
    })();

    const rows = await db
      .select({
        id: eventRegistrations.id,
        event_id: eventRegistrations.event_id,
        event_title: events.title,
        event_slug:  events.slug,
        event_starts_at: events.starts_at,
        event_venue: events.venue,
        event_mode:  events.mode,
        event_committee_id:   events.committee_id,
        event_committee_name: committees.name,
        user_id: eventRegistrations.user_id,
        user_name: users.name,
        user_email: users.email,
        status: eventRegistrations.status,
        registered_at: eventRegistrations.registered_at,
        attended_at: eventRegistrations.attended_at,
      })
      .from(eventRegistrations)
      .leftJoin(events, eq(events.id, eventRegistrations.event_id))
      .leftJoin(committees, eq(committees.id, events.committee_id))
      .leftJoin(users, eq(users.id, eventRegistrations.user_id))
      .where(and(...conds))
      .orderBy(orderExpr)
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(eventRegistrations)
      .leftJoin(events, eq(events.id, eventRegistrations.event_id))
      .leftJoin(users, eq(users.id, eventRegistrations.user_id))
      .where(and(...conds));

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/registrations/_meta/events ────────────────────────────
// Lightweight event list for the multi-select event picker on this page.
// Ordered newest-event first, capped at 500 (the branch runs ~200/year).
// Returns id, title, starts_at, registered_count so the picker chip can
// render "Event title (Nov 12, 42 regs)".
registrationsAdminRouter.get("/_meta/events", async (_req, res, next) => {
  try {
    const rows = await db.select({
      id:               events.id,
      title:            events.title,
      starts_at:        events.starts_at,
      registered_count: events.registered_count,
      committee_name:   committees.name,
    })
      .from(events)
      .leftJoin(committees, eq(committees.id, events.committee_id))
      .where(isNull(events.deleted_at))
      .orderBy(desc(events.starts_at))
      .limit(500);
    res.json({ events: rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/registrations/export.csv ─────────────────────────────
// Full-dataset CSV dump — honours the same filters as the list endpoint
// including `event_ids` for multi-event combined exports. NOT paginated:
// the admin explicitly asks for "everything matching these filters".
//
// Guard-rail: cap at 20,000 rows so a bad filter can't stream unbounded
// data. In practice the branch has < 5k registrations across all events.
registrationsAdminRouter.get("/export.csv", async (req, res, next) => {
  try {
    const conds = buildRegistrationFilters(req.query as any);

    const rows = await db
      .select({
        user_name:            users.name,
        user_email:           users.email,
        event_title:          events.title,
        event_starts_at:      events.starts_at,
        event_committee_name: committees.name,
        event_venue:          events.venue,
        event_mode:           events.mode,
        status:               eventRegistrations.status,
        registered_at:        eventRegistrations.registered_at,
        attended_at:          eventRegistrations.attended_at,
      })
      .from(eventRegistrations)
      .leftJoin(events, eq(events.id, eventRegistrations.event_id))
      .leftJoin(committees, eq(committees.id, events.committee_id))
      .leftJoin(users, eq(users.id, eventRegistrations.user_id))
      .where(and(...conds))
      .orderBy(desc(events.starts_at), desc(eventRegistrations.registered_at))
      .limit(20_000);

    const csv = buildCsv(
      ["User", "Email", "Event", "Event date", "Committee", "Venue", "Mode",
       "Status", "Registered at", "Attended at"],
      rows,
      (r) => [
        r.user_name,
        r.user_email,
        r.event_title,
        r.event_starts_at,
        r.event_committee_name,
        r.event_venue,
        r.event_mode,
        r.status,
        r.registered_at,
        r.attended_at,
      ],
    );

    sendCsv(res, "registrations", csv);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/registrations ────────────────────────────────────────
// Admin manually enrolls a user. Wrapped in a transaction so the registered_count
// stays consistent with the registration row (the schema has a CHECK constraint).
registrationsAdminRouter.post("/", async (req, res, next) => {
  try {
    const event_id = need(trim(req.body.event_id), "Event ID");
    const user_id = need(trim(req.body.user_id), "User ID");
    const status = STATUSES.includes(req.body.status) ? req.body.status : "registered";

    const row = await db.transaction(async (tx) => {
      const [event] = await tx.select().from(events).where(and(eq(events.id, event_id), isNull(events.deleted_at))).limit(1);
      if (!event) throw new ApiError(404, "Event not found");
      if (event.capacity !== null && event.registered_count >= event.capacity && status === "registered") {
        throw new ApiError(400, "Event is at capacity. Use status='waitlisted' instead.");
      }

      const [existing] = await tx
        .select()
        .from(eventRegistrations)
        .where(and(
          eq(eventRegistrations.event_id, event_id),
          eq(eventRegistrations.user_id, user_id),
          isNull(eventRegistrations.deleted_at),
        ))
        .limit(1);
      if (existing) throw new ApiError(409, "User is already registered for this event");

      const [inserted] = await tx.insert(eventRegistrations).values({
        event_id, user_id, status,
      }).returning();

      if (status === "registered" || status === "attended") {
        await tx.update(events).set({
          registered_count: sql`${events.registered_count} + 1`,
          updated_at: new Date(),
        }).where(eq(events.id, event_id));
      }

      return inserted;
    });

    res.status(201).json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ PATCH /api/admin/registrations/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
registrationsAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    if (!STATUSES.includes(req.body.status)) throw new ApiError(400, "Invalid status");
    const newStatus = req.body.status as typeof STATUSES[number];

    const row = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(eventRegistrations)
        .where(and(eq(eventRegistrations.id, id), isNull(eventRegistrations.deleted_at)))
        .limit(1);
      if (!existing) throw new ApiError(404, "Registration not found");
      if (existing.status === newStatus) return existing;

      const wasCounted = existing.status === "registered" || existing.status === "attended";
      const willBeCounted = newStatus === "registered" || newStatus === "attended";
      const delta = (willBeCounted ? 1 : 0) - (wasCounted ? 1 : 0);

      const patch: Record<string, any> = { status: newStatus };
      if (newStatus === "attended" && !existing.attended_at) patch.attended_at = new Date();

      const [updated] = await tx.update(eventRegistrations).set(patch).where(eq(eventRegistrations.id, id)).returning();

      if (delta !== 0) {
        await tx.update(events).set({
          registered_count: sql`greatest(0, ${events.registered_count} + ${delta})`,
          updated_at: new Date(),
        }).where(eq(events.id, existing.event_id));
      }
      return updated;
    });

    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ POST /api/admin/registrations/bulk-attended â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Body: { ids: string[] } â€” mark a batch of registrations as attended.
registrationsAdminRouter.post("/bulk-attended", async (req, res, next) => {
  try {
    const ids: string[] = Array.isArray(req.body.ids) ? req.body.ids.filter((s: any) => typeof s === "string") : [];
    if (ids.length === 0) throw new ApiError(400, "No registration IDs provided");

    const updated = await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(eventRegistrations)
        .where(and(isNull(eventRegistrations.deleted_at)));
      const targets = rows.filter((r) => ids.includes(r.id) && r.status !== "attended" && r.status !== "cancelled" && r.status !== "no_show");

      // Tally count adjustments per event_id (only "registered" â†’ "attended" doesn't change count).
      const now = new Date();
      let count = 0;
      for (const r of targets) {
        const patch: Record<string, any> = { status: "attended" as const, attended_at: now };
        await tx.update(eventRegistrations).set(patch).where(eq(eventRegistrations.id, r.id));
        // both "registered" and "attended" count toward registered_count, so no delta needed
        // for the common case (registered â†’ attended). If status was "waitlisted",
        // moving to attended means +1.
        if (r.status === "waitlisted") {
          await tx.update(events).set({
            registered_count: sql`${events.registered_count} + 1`,
            updated_at: now,
          }).where(eq(events.id, r.event_id));
        }
        count++;
      }
      return count;
    });

    res.json({ ok: true, updated });
  } catch (err) { handleApiError(err, res, next); }
});
