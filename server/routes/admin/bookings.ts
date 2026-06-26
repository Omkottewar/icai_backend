// Admin room-bookings API — approval inbox + status lifecycle.
//
// Schema lives in schema/rooms.ts (roomBookings). EXCLUDE gist constraint
// prevents overlapping bookings for the same room, so when we confirm a
// request the DB will reject conflicts automatically.
//
// Status enum (see schema/enums.ts):
//   requested | confirmed | completed | cancelled
//
// Workflow per requirements (O.2):
//   • FIFO approval (admin reviews requests, confirms or rejects).
//   • ₹500 deposit logic is enforced client-side on the booking form
//     (collected via Razorpay before status='requested' is even created);
//     refund handling on cancel is manual today — admin clicks Cancel and
//     marks the deposit refund externally.
//
// Mounted at /api/admin/bookings.

import { Router } from "express";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { roomBookings, rooms, users } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const bookingsAdminRouter = Router();

const STATUSES = ["requested", "confirmed", "completed", "cancelled"] as const;

// ─── GET /api/admin/bookings ──────────────────────────────────────────────
// List bookings. Filters:
//   ?status=  ?room_id=  ?from=<iso>  ?to=<iso>  ?page=  ?pageSize=
// Default sort: requested-first by slot_start ascending (FIFO).
bookingsAdminRouter.get("/", async (req, res, next) => {
  try {
    const status = trim(req.query.status);
    const room_id = trim(req.query.room_id);
    const from = trim(req.query.from);
    const to = trim(req.query.to);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(5, Number(req.query.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    const conds: any[] = [];
    if (status && (STATUSES as readonly string[]).includes(status)) {
      conds.push(eq(roomBookings.status, status as any));
    }
    if (room_id) conds.push(eq(roomBookings.room_id, room_id));
    if (from)    conds.push(sql`${roomBookings.slot_start} >= ${from}`);
    if (to)      conds.push(sql`${roomBookings.slot_end} <= ${to}`);
    const where = conds.length ? and(...conds) : undefined;

    const list = await db
      .select({
        id: roomBookings.id,
        room_id: roomBookings.room_id,
        room_name: rooms.name,
        user_id: roomBookings.user_id,
        user_name: users.name,
        user_email: users.email,
        slot_start: roomBookings.slot_start,
        slot_end: roomBookings.slot_end,
        purpose: roomBookings.purpose,
        status: roomBookings.status,
        payment_id: roomBookings.payment_id,
        created_at: roomBookings.created_at,
      })
      .from(roomBookings)
      .leftJoin(rooms, eq(rooms.id, roomBookings.room_id))
      .leftJoin(users, eq(users.id, roomBookings.user_id))
      .where(where)
      // FIFO: requested first (alphabetical sort 'c'<'r'<'co'<'ca' but
      // we want requested at top → custom CASE).
      .orderBy(
        sql`CASE ${roomBookings.status} WHEN 'requested' THEN 0 WHEN 'confirmed' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END`,
        asc(roomBookings.slot_start),
      )
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(roomBookings)
      .where(where);

    res.json({ rows: list, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/bookings/_meta/counts ─────────────────────────────────
// Status-count tile data for the page header.
bookingsAdminRouter.get("/_meta/counts", async (_req, res, next) => {
  try {
    const result = (await db.execute(sql`
      SELECT status, count(*)::int AS count
      FROM room_bookings
      GROUP BY status
    `)) as unknown as Array<{ status: string; count: number }>;
    const counts: Record<string, number> = { requested: 0, confirmed: 0, completed: 0, cancelled: 0 };
    for (const r of result) counts[r.status] = Number(r.count);
    res.json(counts);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/bookings/:id/confirm ─────────────────────────────────
// Move 'requested' → 'confirmed'. The DB EXCLUDE constraint on
// (room_id, tstzrange(slot_start, slot_end)) will reject if another
// confirmed booking overlaps.
bookingsAdminRouter.post("/:id/confirm", async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    const [b] = await db.select().from(roomBookings).where(eq(roomBookings.id, id)).limit(1);
    if (!b) throw new ApiError(404, "Booking not found");
    if (b.status !== "requested") {
      throw new ApiError(400, `Cannot confirm a booking in status '${b.status}'`);
    }

    try {
      const [row] = await db.update(roomBookings)
        .set({ status: "confirmed" })
        .where(eq(roomBookings.id, id))
        .returning();
      res.json(row);
    } catch (e: any) {
      // EXCLUDE gist overlap → 23P01 in Postgres.
      if (/exclusion|overlap/i.test(e.message)) {
        throw new ApiError(409, "Another confirmed booking overlaps this slot");
      }
      throw e;
    }
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/bookings/:id/cancel ──────────────────────────────────
// Move to 'cancelled' (regardless of current status, except completed).
// Optional body { reason } stored on purpose suffix.
bookingsAdminRouter.post("/:id/cancel", async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    const reason = trim(req.body?.reason);
    const [b] = await db.select().from(roomBookings).where(eq(roomBookings.id, id)).limit(1);
    if (!b) throw new ApiError(404, "Booking not found");
    if (b.status === "completed") {
      throw new ApiError(400, "Cannot cancel a completed booking");
    }
    if (b.status === "cancelled") {
      return res.json({ ...b, already: true });
    }

    const newPurpose = reason
      ? `${b.purpose ?? ""}${b.purpose ? "\n" : ""}[Cancelled by admin: ${reason}]`
      : b.purpose;

    const [row] = await db.update(roomBookings)
      .set({ status: "cancelled", purpose: newPurpose })
      .where(eq(roomBookings.id, id))
      .returning();
    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/bookings/:id/complete ────────────────────────────────
// Mark a confirmed booking as completed (post-slot bookkeeping).
bookingsAdminRouter.post("/:id/complete", async (req, res, next) => {
  try {
    const id = trim(req.params.id);
    const [b] = await db.select().from(roomBookings).where(eq(roomBookings.id, id)).limit(1);
    if (!b) throw new ApiError(404, "Booking not found");
    if (b.status !== "confirmed") {
      throw new ApiError(400, `Cannot complete a booking in status '${b.status}'`);
    }
    const [row] = await db.update(roomBookings)
      .set({ status: "completed" })
      .where(eq(roomBookings.id, id))
      .returning();
    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});
