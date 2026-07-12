// Admin: Reading Room monthly-pass administration.
//
// Endpoints:
//   GET  /api/admin/reading-room/deposits              — list w/ status filter
//   POST /api/admin/reading-room/deposits/:id/verify    — approve
//   POST /api/admin/reading-room/deposits/:id/reject    — with reason
//   POST /api/admin/reading-room/deposits/:id/refund    — flag as refunded
//   DELETE /api/admin/reading-room/deposits/:id         — clean-slate delete
//   GET  /api/admin/reading-room/roster?year=&month=    — monthly roster
//   GET  /api/admin/reading-room/summary                — capacity + usage

import { Router } from "express";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import {
  readingRooms, readingRoomDeposits, readingRoomBookings,
  users,
} from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const readingRoomAdminRouter = Router();

async function totalCapacity() {
  const [row] = await db
    .select({ n: sql<number>`COALESCE(SUM(capacity), 0)::int`.as("n") })
    .from(readingRooms)
    .where(eq(readingRooms.active, true));
  return row?.n ?? 0;
}

// ─── GET /deposits ─────────────────────────────────────────────────────────
readingRoomAdminRouter.get("/deposits", async (req, res, next) => {
  try {
    const status = trim(req.query.status); // 'pending_verification' | 'verified' | 'rejected' | 'refunded'
    const conds: any[] = [];
    if (status) conds.push(eq(readingRoomDeposits.status, status));

    const rows = await db
      .select({
        id:                readingRoomDeposits.id,
        user_id:           readingRoomDeposits.user_id,
        user_name:         users.name,
        user_email:        users.email,
        amount_paise:      readingRoomDeposits.amount_paise,
        utr:               readingRoomDeposits.utr,
        status:            readingRoomDeposits.status,
        submitted_at:      readingRoomDeposits.submitted_at,
        verified_at:       readingRoomDeposits.verified_at,
        rejection_reason:  readingRoomDeposits.rejection_reason,
        refunded_at:       readingRoomDeposits.refunded_at,
        refund_note:       readingRoomDeposits.refund_note,
        created_at:        readingRoomDeposits.created_at,
      })
      .from(readingRoomDeposits)
      .leftJoin(users, eq(users.id, readingRoomDeposits.user_id))
      .where(conds.length ? and(...conds) : sql`TRUE`)
      .orderBy(desc(readingRoomDeposits.created_at))
      .limit(500);

    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /deposits/:id/verify ─────────────────────────────────────────────
readingRoomAdminRouter.post("/deposits/:id/verify", async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    const [row] = await db
      .select()
      .from(readingRoomDeposits)
      .where(eq(readingRoomDeposits.id, id))
      .limit(1);
    if (!row) throw new ApiError(404, "Deposit not found");
    if (row.status === "verified") return res.json({ deposit: row, already: true });

    const [updated] = await db
      .update(readingRoomDeposits)
      .set({
        status: "verified",
        verified_by: req.user!.id,
        verified_at: new Date(),
        rejection_reason: null,
        updated_at: new Date(),
      })
      .where(eq(readingRoomDeposits.id, id))
      .returning();
    res.json({ deposit: updated });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /deposits/:id/reject ─────────────────────────────────────────────
readingRoomAdminRouter.post("/deposits/:id/reject", async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    const reason = need(trim(req.body?.reason), "reason");
    const [updated] = await db
      .update(readingRoomDeposits)
      .set({
        status: "rejected",
        rejection_reason: reason,
        verified_at: null,
        verified_by: null,
        updated_at: new Date(),
      })
      .where(eq(readingRoomDeposits.id, id))
      .returning();
    if (!updated) throw new ApiError(404, "Deposit not found");
    res.json({ deposit: updated });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /deposits/:id/refund ─────────────────────────────────────────────
// Marks the deposit as refunded. Also cancels any future active bookings
// held by that student so the seat opens up for others.
readingRoomAdminRouter.post("/deposits/:id/refund", async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    const note = trim(req.body?.note) || null;
    const [dep] = await db
      .select()
      .from(readingRoomDeposits)
      .where(eq(readingRoomDeposits.id, id))
      .limit(1);
    if (!dep) throw new ApiError(404, "Deposit not found");

    const now = new Date();
    const [updated] = await db
      .update(readingRoomDeposits)
      .set({
        status: "refunded",
        refunded_at: now,
        refund_note: note,
        updated_at: now,
      })
      .where(eq(readingRoomDeposits.id, id))
      .returning();

    // Cancel any future active bookings for this student.
    const y = now.getFullYear(); const m = now.getMonth() + 1;
    await db
      .update(readingRoomBookings)
      .set({ cancelled_at: now })
      .where(and(
        eq(readingRoomBookings.user_id, dep.user_id),
        isNull(readingRoomBookings.cancelled_at),
        sql`(${readingRoomBookings.year} > ${y} OR (${readingRoomBookings.year} = ${y} AND ${readingRoomBookings.month} > ${m}))`,
      ));

    res.json({ deposit: updated });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /deposits/:id ──────────────────────────────────────────────────
// Hard-delete — used when admin wants the student to be able to start a
// completely fresh enrolment. Cascade drops any bookings.
readingRoomAdminRouter.delete("/deposits/:id", async (req, res, next) => {
  try {
    const id = trim(req.params.id);
    const [dep] = await db.select().from(readingRoomDeposits)
      .where(eq(readingRoomDeposits.id, id)).limit(1);
    if (!dep) throw new ApiError(404, "Deposit not found");
    // Cancel any future bookings the student holds so a follow-on re-book
    // doesn't inherit them (they can't be automatically re-attributed).
    const now = new Date();
    await db.update(readingRoomBookings)
      .set({ cancelled_at: now })
      .where(and(
        eq(readingRoomBookings.user_id, dep.user_id),
        isNull(readingRoomBookings.cancelled_at),
      ));
    await db.delete(readingRoomDeposits).where(eq(readingRoomDeposits.id, id));
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /roster?year=&month=&room_id= ─────────────────────────────────────
// Roster listing per month. Optional room_id filter — omit to see the
// combined roster across all rooms.
readingRoomAdminRouter.get("/roster", async (req, res, next) => {
  try {
    const now = new Date();
    const year  = Number.parseInt(trim(req.query.year)  || String(now.getFullYear()), 10);
    const month = Number.parseInt(trim(req.query.month) || String(now.getMonth() + 1), 10);
    const roomId = trim(req.query.room_id);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      throw new ApiError(400, "year and month must be valid");
    }

    const conds: any[] = [
      eq(readingRoomBookings.year, year),
      eq(readingRoomBookings.month, month),
      isNull(readingRoomBookings.cancelled_at),
    ];
    if (roomId) conds.push(eq(readingRoomBookings.room_id, roomId));

    const rows = await db
      .select({
        id:         readingRoomBookings.id,
        user_id:    readingRoomBookings.user_id,
        user_name:  users.name,
        user_email: users.email,
        room_id:    readingRoomBookings.room_id,
        room_name:  readingRooms.name,
        created_at: readingRoomBookings.created_at,
      })
      .from(readingRoomBookings)
      .leftJoin(users, eq(users.id, readingRoomBookings.user_id))
      .leftJoin(readingRooms, eq(readingRooms.id, readingRoomBookings.room_id))
      .where(and(...conds))
      .orderBy(readingRooms.name, readingRoomBookings.created_at);

    const capacity = await totalCapacity();
    res.json({ year, month, room_id: roomId || null, capacity, count: rows.length, rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Rooms CRUD ────────────────────────────────────────────────────────────

// GET /rooms — active + inactive both, sorted by sort_order.
readingRoomAdminRouter.get("/rooms", async (_req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(readingRooms)
      .orderBy(asc(readingRooms.sort_order), asc(readingRooms.name));
    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// POST /rooms — create.
readingRoomAdminRouter.post("/rooms", async (req, res, next) => {
  try {
    const name        = need(trim(req.body?.name), "name");
    const description = trim(req.body?.description) || null;
    const location    = trim(req.body?.location) || null;
    const capacity    = Number.parseInt(String(req.body?.capacity ?? ""), 10);
    const active      = req.body?.active !== false;
    const sort_order  = Number.parseInt(String(req.body?.sort_order ?? "0"), 10) || 0;

    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new ApiError(400, "capacity must be a positive integer");
    }

    const [row] = await db.insert(readingRooms).values({
      name, description, location, capacity, active, sort_order,
    }).returning();
    res.status(201).json({ room: row });
  } catch (err) { handleApiError(err, res, next); }
});

// PATCH /rooms/:id — update any subset of the fields.
readingRoomAdminRouter.patch("/rooms/:id", async (req, res, next) => {
  try {
    const id = trim(req.params.id);
    const patch: Record<string, unknown> = { updated_at: new Date() };

    if (req.body?.name        !== undefined) patch.name        = trim(req.body.name);
    if (req.body?.description !== undefined) patch.description = trim(req.body.description) || null;
    if (req.body?.location    !== undefined) patch.location    = trim(req.body.location) || null;
    if (req.body?.active      !== undefined) patch.active      = !!req.body.active;
    if (req.body?.sort_order  !== undefined) patch.sort_order  = Number.parseInt(String(req.body.sort_order), 10) || 0;
    if (req.body?.capacity    !== undefined) {
      const c = Number.parseInt(String(req.body.capacity), 10);
      if (!Number.isFinite(c) || c <= 0) throw new ApiError(400, "capacity must be a positive integer");
      // Don't allow shrinking below the count already booked for the
      // upcoming month — otherwise those students would silently lose
      // their seat.
      const now = new Date();
      const nxtY = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
      const nxtM = now.getMonth() === 11 ? 1 : now.getMonth() + 2;
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int`.as("n") })
        .from(readingRoomBookings)
        .where(and(
          eq(readingRoomBookings.room_id, id),
          eq(readingRoomBookings.year, nxtY),
          eq(readingRoomBookings.month, nxtM),
          isNull(readingRoomBookings.cancelled_at),
        ));
      if (c < n) {
        throw new ApiError(400, `Can't shrink capacity below ${n} — next month already has ${n} bookings for this room`);
      }
      patch.capacity = c;
    }

    const [row] = await db.update(readingRooms).set(patch).where(eq(readingRooms.id, id)).returning();
    if (!row) throw new ApiError(404, "Room not found");
    res.json({ room: row });
  } catch (err) { handleApiError(err, res, next); }
});

// DELETE /rooms/:id — hard-delete when the room has no bookings; otherwise
// admin should just toggle `active=false` instead.
readingRoomAdminRouter.delete("/rooms/:id", async (req, res, next) => {
  try {
    const id = trim(req.params.id);
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int`.as("n") })
      .from(readingRoomBookings)
      .where(eq(readingRoomBookings.room_id, id));
    if (n > 0) {
      throw new ApiError(400, `This room has ${n} historical bookings — deactivate it instead of deleting.`);
    }
    await db.delete(readingRooms).where(eq(readingRooms.id, id));
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /summary ──────────────────────────────────────────────────────────
readingRoomAdminRouter.get("/summary", async (_req, res, next) => {
  try {
    const capacity = await totalCapacity();
    const [{ n: room_count }] = await db
      .select({ n: sql<number>`count(*)::int`.as("n") })
      .from(readingRooms)
      .where(eq(readingRooms.active, true));
    const now = new Date();
    const cur = { year: now.getFullYear(), month: now.getMonth() + 1 };
    const nxt = cur.month === 12
      ? { year: cur.year + 1, month: 1 }
      : { year: cur.year, month: cur.month + 1 };

    const [pending] = await db
      .select({ n: sql<number>`count(*)::int`.as("n") })
      .from(readingRoomDeposits)
      .where(eq(readingRoomDeposits.status, "pending_verification"));

    const [verified] = await db
      .select({ n: sql<number>`count(*)::int`.as("n") })
      .from(readingRoomDeposits)
      .where(eq(readingRoomDeposits.status, "verified"));

    const [curBooked] = await db
      .select({ n: sql<number>`count(*)::int`.as("n") })
      .from(readingRoomBookings)
      .where(and(
        eq(readingRoomBookings.year, cur.year),
        eq(readingRoomBookings.month, cur.month),
        isNull(readingRoomBookings.cancelled_at),
      ));

    const [nxtBooked] = await db
      .select({ n: sql<number>`count(*)::int`.as("n") })
      .from(readingRoomBookings)
      .where(and(
        eq(readingRoomBookings.year, nxt.year),
        eq(readingRoomBookings.month, nxt.month),
        isNull(readingRoomBookings.cancelled_at),
      ));

    res.json({
      capacity,
      room_count,
      pending_deposits: pending.n,
      verified_students: verified.n,
      current_month: { ...cur, booked: curBooked.n },
      next_month:    { ...nxt, booked: nxtBooked.n },
    });
  } catch (err) { handleApiError(err, res, next); }
});
