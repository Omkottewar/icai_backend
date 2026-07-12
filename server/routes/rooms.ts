// Public + member-facing rooms API.
//
// The admin CRUD lives in routes/admin/rooms.ts and the admin booking
// inbox in routes/admin/bookings.ts; this router is what members and
// students hit from the public booking page.
//
// Workflow per client requirements (Section O):
//   1. Member picks a room + date + slot → POST /api/rooms/:id/book.
//   2. Row is created with status='requested'. registered_count + EXCLUDE
//      gist constraint guarantee no double-booking even under concurrency.
//   3. Admin reviews in /admin/bookings (FIFO) → confirms / rejects.
//   4. Once confirmed, the member sees it in /api/rooms/my-bookings and
//      can cancel until the slot begins.
//
// Deposit (₹500 per O.2) is intentionally NOT collected here in v1 — the
// branch policy collects it offline (cheque) and refunds the same way.
// Wire Razorpay in a follow-up if/when the branch flips the policy.
//
// Mounted at /api/rooms in server/index.ts.

import { Router } from "express";
import { and, asc, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { rooms, roomBookings } from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { bookingWriteLimiter } from "../middleware/rateLimit.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";

export const roomsRouter = Router();

// ─── GET /api/rooms ───────────────────────────────────────────────────────
// Public listing of bookable rooms (active only). The frontend uses this
// to seed the room picker.
roomsRouter.get("/", async (_req, res, next) => {
  try {
    const list = await db
      .select({
        id: rooms.id,
        name: rooms.name,
        location: rooms.location,
        capacity: rooms.capacity,
        fee_paise_per_hour: rooms.fee_paise_per_hour,
      })
      .from(rooms)
      .where(eq(rooms.active, true))
      .orderBy(asc(rooms.name));
    res.json({ rows: list });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/rooms/:id/availability ──────────────────────────────────────
// Returns active bookings for a room on a given date so the frontend can
// disable slots that overlap. Query: ?date=YYYY-MM-DD (defaults to today).
// We only need start + end + status; the frontend computes "is this slot
// blocked" by intersecting against its predefined slot list.
roomsRouter.get("/:id/availability", async (req, res, next) => {
  try {
    const id = trim(req.params.id);
    if (!id) throw new ApiError(400, "Room id is required");

    const dateStr = trim(req.query.date) || new Date().toISOString().slice(0, 10);
    const dayStart = new Date(`${dateStr}T00:00:00Z`);
    if (Number.isNaN(dayStart.getTime())) throw new ApiError(400, "date must be YYYY-MM-DD");
    const dayEnd = new Date(dayStart.getTime() + 24 * 3600 * 1000);

    // Only "live" bookings block a slot — cancelled ones don't matter.
    const bookings = await db
      .select({
        slot_start: roomBookings.slot_start,
        slot_end: roomBookings.slot_end,
        status: roomBookings.status,
      })
      .from(roomBookings)
      .where(and(
        eq(roomBookings.room_id, id),
        gte(roomBookings.slot_start, dayStart),
        lt(roomBookings.slot_start, dayEnd),
        sql`${roomBookings.status} IN ('requested', 'confirmed')`,
      ));

    res.json({ date: dateStr, bookings });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/rooms/:id/book ─────────────────────────────────────────────
// Create a booking request. Body: { slot_start, slot_end, purpose }.
// Status starts as 'requested' — admin confirms it via /admin/bookings.
// The DB EXCLUDE constraint rejects overlaps atomically (race-safe).
//
// Role gate — branch rooms are bookable by ICAI members and CA students
// only (client_answers §O.2). Employers, staff and other roles cannot
// hold a slot. Admin is allowed for support / WICASA pre-checks.
roomsRouter.post("/:id/book", bookingWriteLimiter, requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const role = req.user!.primary_role;
    if (role !== "member" && role !== "student" && role !== "admin") {
      throw new ApiError(403, "Room booking is available to ICAI members and CA students only");
    }

    const id = trim(req.params.id);
    const slotStartStr = need(trim(req.body?.slot_start), "slot_start");
    const slotEndStr   = need(trim(req.body?.slot_end),   "slot_end");
    const purpose      = trim(req.body?.purpose) || null;

    const slotStart = new Date(slotStartStr);
    const slotEnd   = new Date(slotEndStr);
    if (Number.isNaN(slotStart.getTime()) || Number.isNaN(slotEnd.getTime())) {
      throw new ApiError(400, "slot_start and slot_end must be valid ISO timestamps");
    }
    if (slotEnd <= slotStart) {
      throw new ApiError(400, "slot_end must be after slot_start");
    }
    if (slotStart < new Date(Date.now() - 60_000)) {
      throw new ApiError(400, "Cannot book a slot in the past");
    }

    // Reject if room is missing or inactive.
    const [room] = await db
      .select({ id: rooms.id, name: rooms.name, active: rooms.active })
      .from(rooms)
      .where(eq(rooms.id, id))
      .limit(1);
    if (!room) throw new ApiError(404, "Room not found");
    if (!room.active) throw new ApiError(400, "This room is not currently bookable");

    try {
      const [row] = await db.insert(roomBookings).values({
        room_id: id,
        user_id: req.user!.id,
        slot_start: slotStart,
        slot_end: slotEnd,
        purpose,
        status: "requested",
      }).returning();

      // No notification fires here — there's no template_key for room
      // bookings yet. The frontend toast confirms the submission. Add a
      // `room_booking_requested` template via a migration if/when the
      // branch wants an email/SMS receipt for booking requests.
      res.status(201).json({ booking: row, room: { id: room.id, name: room.name } });
    } catch (e: any) {
      // EXCLUDE gist overlap → SQLSTATE 23P01.
      if (/exclusion|overlap/i.test(e.message)) {
        throw new ApiError(409, "Another booking already covers this slot — pick a different time");
      }
      throw e;
    }
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/rooms/my-bookings ───────────────────────────────────────────
// The current user's room bookings — upcoming first. The frontend renders
// these on the member dashboard with a Cancel button.
roomsRouter.get("/my-bookings", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const list = await db
      .select({
        id: roomBookings.id,
        room_id: roomBookings.room_id,
        room_name: rooms.name,
        slot_start: roomBookings.slot_start,
        slot_end: roomBookings.slot_end,
        purpose: roomBookings.purpose,
        status: roomBookings.status,
        created_at: roomBookings.created_at,
      })
      .from(roomBookings)
      .leftJoin(rooms, eq(rooms.id, roomBookings.room_id))
      .where(eq(roomBookings.user_id, req.user!.id))
      .orderBy(desc(roomBookings.slot_start))
      .limit(50);

    res.json({ rows: list });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/rooms/bookings/:id/cancel ──────────────────────────────────
// Member cancels their own booking. Only allowed while the slot hasn't
// started AND status is requested/confirmed.
roomsRouter.post("/bookings/:id/cancel", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    const [b] = await db
      .select()
      .from(roomBookings)
      .where(and(
        eq(roomBookings.id, id),
        eq(roomBookings.user_id, req.user!.id),
      ))
      .limit(1);
    if (!b) throw new ApiError(404, "Booking not found");
    if (b.status === "cancelled") return res.json({ ok: true, already: true });
    if (b.status === "completed") {
      throw new ApiError(400, "This booking is already completed");
    }
    if (new Date(b.slot_start) < new Date()) {
      throw new ApiError(400, "Cannot cancel a booking whose slot has already started");
    }

    const [row] = await db
      .update(roomBookings)
      .set({ status: "cancelled" })
      .where(eq(roomBookings.id, id))
      .returning();
    res.json({ ok: true, booking: row });
  } catch (err) { handleApiError(err, res, next); }
});
