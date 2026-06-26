// Admin rooms API — CRUD for bookable spaces (seminar halls, reading room,
// boardroom). Booking lifecycle lives in routes/admin/bookings.ts; this
// router only manages the room records themselves.
//
// Schema lives in schema/rooms.ts. No soft-delete column — we use the
// `active` boolean to retire rooms (existing bookings remain valid).
//
// Mounted at /api/admin/rooms.

import { Router } from "express";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { rooms, roomBookings } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const roomsAdminRouter = Router();

// ─── GET /api/admin/rooms ─────────────────────────────────────────────────
// List with live booking counts. Optional ?active=true|false.
roomsAdminRouter.get("/", async (req, res, next) => {
  try {
    const activeFilter = trim(req.query.active);
    const conds: any[] = [];
    if (activeFilter === "true")  conds.push(eq(rooms.active, true));
    if (activeFilter === "false") conds.push(eq(rooms.active, false));
    const where = conds.length ? and(...conds) : undefined;

    const bookingCount = sql<number>`(
      SELECT count(*)::int FROM ${roomBookings}
      WHERE ${roomBookings.room_id} = ${rooms.id}
        AND ${roomBookings.status} IN ('requested', 'confirmed')
        AND ${roomBookings.slot_end} >= now()
    )`.as("upcoming_bookings");

    const list = await db
      .select({
        id: rooms.id,
        name: rooms.name,
        location: rooms.location,
        capacity: rooms.capacity,
        fee_paise_per_hour: rooms.fee_paise_per_hour,
        active: rooms.active,
        created_at: rooms.created_at,
        upcoming_bookings: bookingCount,
      })
      .from(rooms)
      .where(where)
      .orderBy(asc(rooms.name));

    res.json({ rows: list });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/rooms ────────────────────────────────────────────────
// Create a room. Body: { name, location?, capacity?, fee_paise_per_hour?, active? }
roomsAdminRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const name = need(req.body?.name, "name");
    const location = trim(req.body?.location) || null;
    const capacity = req.body?.capacity != null ? Number(req.body.capacity) : null;
    const fee = req.body?.fee_paise_per_hour != null ? Number(req.body.fee_paise_per_hour) : 0;
    const active = req.body?.active !== false;

    if (capacity != null && (!Number.isFinite(capacity) || capacity < 0)) {
      throw new ApiError(400, "capacity must be a non-negative integer");
    }
    if (!Number.isFinite(fee) || fee < 0) {
      throw new ApiError(400, "fee_paise_per_hour must be a non-negative integer");
    }

    const [row] = await db.insert(rooms).values({
      name,
      location,
      capacity,
      fee_paise_per_hour: fee,
      active,
    }).returning();

    res.status(201).json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/admin/rooms/:id ───────────────────────────────────────────
// Partial update — any field can be omitted.
roomsAdminRouter.patch("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    if (!id) throw new ApiError(400, "id is required");

    const patch: Record<string, unknown> = {};
    if ("name" in req.body)              patch.name = trim(req.body.name) || null;
    if ("location" in req.body)          patch.location = trim(req.body.location) || null;
    if ("capacity" in req.body)          patch.capacity = req.body.capacity == null ? null : Number(req.body.capacity);
    if ("fee_paise_per_hour" in req.body) patch.fee_paise_per_hour = Number(req.body.fee_paise_per_hour);
    if ("active" in req.body)            patch.active = !!req.body.active;

    if (Object.keys(patch).length === 0) {
      throw new ApiError(400, "Provide at least one field to update");
    }
    if (patch.fee_paise_per_hour != null && (!Number.isFinite(patch.fee_paise_per_hour as number) || (patch.fee_paise_per_hour as number) < 0)) {
      throw new ApiError(400, "fee_paise_per_hour must be a non-negative integer");
    }

    const [row] = await db.update(rooms).set(patch).where(eq(rooms.id, id)).returning();
    if (!row) throw new ApiError(404, "Room not found");

    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/admin/rooms/:id ──────────────────────────────────────────
// Hard delete only if no bookings reference it; otherwise refuse and ask
// the admin to toggle `active` instead.
roomsAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = trim(req.params.id);
    if (!id) throw new ApiError(400, "id is required");

    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int`.as("count") })
      .from(roomBookings)
      .where(eq(roomBookings.room_id, id));

    if (count > 0) {
      throw new ApiError(409, `Room has ${count} booking(s) in history — set active=false instead of deleting`);
    }

    const result = await db.delete(rooms).where(eq(rooms.id, id)).returning({ id: rooms.id });
    if (result.length === 0) throw new ApiError(404, "Room not found");

    res.json({ ok: true, id });
  } catch (err) { handleApiError(err, res, next); }
});
