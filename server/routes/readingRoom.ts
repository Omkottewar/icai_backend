// Reading Room monthly-pass — public + student endpoints.
//
// Access model (migration 0090):
//   1. Student pays a one-time refundable ₹500 deposit (UPI QR, admin
//      verifies UTR). Once verified, the student is "enrolled" and can
//      book any single upcoming month.
//   2. Booking window for month M+1 opens on the 25th of month M.
//   3. Only students see this page — other roles hit a 403.
//   4. Capacity + deposit amount + master open/closed flag live in
//      site_settings.
//
// Mounted at /api/reading-room in server/index.ts.

import { Router } from "express";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  readingRooms, readingRoomDeposits, readingRoomBookings,
  siteSettings, users,
} from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { bookingWriteLimiter } from "../middleware/rateLimit.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";

export const readingRoomRouter = Router();

// ─── Helpers ───────────────────────────────────────────────────────────────

// Effective config from site_settings — falls back to sane defaults if a
// key is missing (fresh install before the migration seeds the row).
// After 0091, per-room capacity lives on reading_rooms.capacity; the
// legacy `reading_room_capacity` key stays around only as the default
// used when admin seeds a new room from the UI.
async function loadConfig() {
  const rows = await db.select({ key: siteSettings.key, value: siteSettings.value })
    .from(siteSettings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  const depositPaise = Number.parseInt(map.get("reading_room_deposit_paise") || "50000", 10);
  const open = (map.get("reading_room_open") ?? "1") !== "0";
  const upi_id = (map.get("payment_upi_id") ?? "").trim();
  const upi_payee = (map.get("payment_upi_payee_name") ?? "ICAI Nagpur Branch").trim();
  return { depositPaise, open, upi_id, upi_payee };
}

// Per-room booking counts for a given year/month. One query joins the
// counts back onto the rooms so we can return "N used / M capacity" for
// each room in one round-trip.
async function roomsWithUsage(year: number, month: number) {
  const rooms = await db
    .select()
    .from(readingRooms)
    .where(eq(readingRooms.active, true))
    .orderBy(asc(readingRooms.sort_order), asc(readingRooms.name));

  if (rooms.length === 0) return [];

  const counts = await db
    .select({
      room_id: readingRoomBookings.room_id,
      n:       sql<number>`count(*)::int`.as("n"),
    })
    .from(readingRoomBookings)
    .where(and(
      eq(readingRoomBookings.year, year),
      eq(readingRoomBookings.month, month),
      isNull(readingRoomBookings.cancelled_at),
    ))
    .groupBy(readingRoomBookings.room_id);

  const map = new Map(counts.map((c) => [c.room_id, c.n]));
  return rooms.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    location: r.location,
    capacity: r.capacity,
    used: map.get(r.id) ?? 0,
    available: Math.max(0, r.capacity - (map.get(r.id) ?? 0)),
  }));
}

// Booking rules for the two months a student can pick from at any point:
//   • Current month (M)   — always open. If the student is joining mid-
//     month, they should be able to grab a seat immediately if any room
//     still has capacity.
//   • Next month (M+1)    — opens on the 25th of M. Before that day, the
//     card is visible but the button is disabled with a countdown.
//
// Pure date arithmetic, no cron.
function currentMonth(now = new Date()) {
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

function nextMonth(now = new Date()) {
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  return m === 12 ? { year: y + 1, month: 1 } : { year: y, month: m + 1 };
}

// Is (year, month) either the current or the next calendar month?
function classifyMonth(year: number, month: number, now = new Date()) {
  const cur = currentMonth(now);
  const nxt = nextMonth(now);
  if (year === cur.year && month === cur.month) return "current" as const;
  if (year === nxt.year && month === nxt.month) return "next" as const;
  return "invalid" as const;
}

// Booking window state for a specific (year, month) tuple. Current-month
// windows are always open; next-month windows open on the 25th.
function windowFor(year: number, month: number, now = new Date()) {
  const kind = classifyMonth(year, month, now);
  if (kind === "current") return { open: true, opens_at: null as string | null };
  if (kind === "next") {
    const day = now.getDate();
    const opensAt = new Date(now.getFullYear(), now.getMonth(), 25, 0, 0, 0);
    return { open: day >= 25, opens_at: opensAt.toISOString() };
  }
  return null;
}

function buildUpiUri(input: { upi_id: string; payee_name: string; amount_paise: number; note: string }) {
  const amountRupees = (input.amount_paise / 100).toFixed(2);
  const params = new URLSearchParams({
    pa: input.upi_id,
    pn: input.payee_name,
    am: amountRupees,
    cu: "INR",
    tn: input.note,
  });
  return `upi://pay?${params.toString()}`;
}

async function activeCountForRoom(roomId: string, year: number, month: number) {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int`.as("n") })
    .from(readingRoomBookings)
    .where(and(
      eq(readingRoomBookings.room_id, roomId),
      eq(readingRoomBookings.year, year),
      eq(readingRoomBookings.month, month),
      isNull(readingRoomBookings.cancelled_at),
    ));
  return n;
}

async function getBooking(userId: string, year: number, month: number) {
  const [row] = await db
    .select({
      id:         readingRoomBookings.id,
      room_id:    readingRoomBookings.room_id,
      room_name:  readingRooms.name,
      year:       readingRoomBookings.year,
      month:      readingRoomBookings.month,
      created_at: readingRoomBookings.created_at,
    })
    .from(readingRoomBookings)
    .leftJoin(readingRooms, eq(readingRooms.id, readingRoomBookings.room_id))
    .where(and(
      eq(readingRoomBookings.user_id, userId),
      eq(readingRoomBookings.year, year),
      eq(readingRoomBookings.month, month),
      isNull(readingRoomBookings.cancelled_at),
    ))
    .limit(1);
  return row ?? null;
}

// ─── GET /api/reading-room/status ──────────────────────────────────────────
// One-shot endpoint the public page hits on load. Returns everything the
// UI needs to render the deposit flow + both bookable months (current +
// next) with per-room capacity so the student can book mid-month if
// seats are still available.
readingRoomRouter.get("/status", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const role = req.user!.primary_role;
    const cfg = await loadConfig();
    const cur = currentMonth();
    const nxt = nextMonth();

    const [deposit] = await db
      .select()
      .from(readingRoomDeposits)
      .where(eq(readingRoomDeposits.user_id, req.user!.id))
      .limit(1);

    // Parallel fetch for both months — booking + per-room usage.
    const [
      curBooking, nxtBooking,
      curRooms,   nxtRooms,
    ] = await Promise.all([
      getBooking(req.user!.id, cur.year, cur.month),
      getBooking(req.user!.id, nxt.year, nxt.month),
      roomsWithUsage(cur.year, cur.month),
      roomsWithUsage(nxt.year, nxt.month),
    ]);

    const months = [
      {
        year: cur.year, month: cur.month, kind: "current" as const,
        window: windowFor(cur.year, cur.month)!,
        rooms: curRooms,
        my_booking: curBooking,
      },
      {
        year: nxt.year, month: nxt.month, kind: "next" as const,
        window: windowFor(nxt.year, nxt.month)!,
        rooms: nxtRooms,
        my_booking: nxtBooking,
      },
    ];

    res.json({
      role,
      is_student: role === "student",
      config: {
        deposit_paise: cfg.depositPaise,
        room_open: cfg.open,
      },
      deposit: deposit ? {
        id: deposit.id,
        status: deposit.status,
        amount_paise: deposit.amount_paise,
        utr: deposit.utr,
        submitted_at: deposit.submitted_at,
        verified_at: deposit.verified_at,
        rejection_reason: deposit.rejection_reason,
        refunded_at: deposit.refunded_at,
      } : null,
      months,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/reading-room/deposit/start ──────────────────────────────────
// Creates (or returns) the deposit row and hands back the UPI intent URI
// the frontend renders as a QR. Idempotent — a subsequent call while the
// row is still in pending_verification returns the same UPI intent.
readingRoomRouter.post("/deposit/start", bookingWriteLimiter, requireUser, async (req: AuthedRequest, res, next) => {
  try {
    if (req.user!.primary_role !== "student") {
      throw new ApiError(403, "Reading Room enrolment is available to CA students only");
    }
    const cfg = await loadConfig();
    if (!cfg.upi_id) {
      throw new ApiError(503, "Payments are not configured yet — please contact the branch office");
    }

    // Look for an existing row. Statuses:
    //   pending_verification → reuse
    //   verified              → nothing to pay
    //   rejected              → reset back to pending so student can retry
    //   refunded              → treat as a fresh enrolment (rare — usually
    //                            admin deletes the row instead, but if not
    //                            we let the student re-pay)
    const [existing] = await db
      .select()
      .from(readingRoomDeposits)
      .where(eq(readingRoomDeposits.user_id, req.user!.id))
      .limit(1);

    let row = existing;
    if (existing && existing.status === "verified") {
      throw new ApiError(400, "Deposit already verified");
    }
    if (!existing) {
      [row] = await db.insert(readingRoomDeposits).values({
        user_id: req.user!.id,
        amount_paise: cfg.depositPaise,
        status: "pending_verification",
      }).returning();
    } else if (existing.status === "rejected" || existing.status === "refunded") {
      [row] = await db
        .update(readingRoomDeposits)
        .set({
          status: "pending_verification",
          amount_paise: cfg.depositPaise,
          utr: null,
          submitted_at: null,
          verified_at: null,
          verified_by: null,
          rejection_reason: null,
          refunded_at: null,
          refund_note: null,
          updated_at: new Date(),
        })
        .where(eq(readingRoomDeposits.id, existing.id))
        .returning();
    }

    const upiUri = buildUpiUri({
      upi_id: cfg.upi_id,
      payee_name: cfg.upi_payee,
      amount_paise: row.amount_paise,
      note: `RRD-${row.id.slice(0, 8)}`,
    });

    res.json({
      deposit: row,
      upi_id: cfg.upi_id,
      upi_payee_name: cfg.upi_payee,
      upi_uri: upiUri,
      note: `RRD-${row.id.slice(0, 8)}`,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/reading-room/deposit/utr ────────────────────────────────────
// Student submits the UTR/transaction reference they got from their UPI
// app. Row stays in pending_verification — admin will flip it to verified.
readingRoomRouter.post("/deposit/utr", bookingWriteLimiter, requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const utr = need(trim(req.body?.utr), "utr");
    if (utr.length < 6 || utr.length > 40) {
      throw new ApiError(400, "UTR looks wrong — should be 6–40 characters");
    }

    const [row] = await db
      .select()
      .from(readingRoomDeposits)
      .where(eq(readingRoomDeposits.user_id, req.user!.id))
      .limit(1);
    if (!row) throw new ApiError(404, "Start the deposit first");
    if (row.status === "verified") {
      throw new ApiError(400, "Deposit already verified");
    }

    const [updated] = await db
      .update(readingRoomDeposits)
      .set({
        utr,
        submitted_at: new Date(),
        status: "pending_verification",
        rejection_reason: null,
        updated_at: new Date(),
      })
      .where(eq(readingRoomDeposits.id, row.id))
      .returning();

    res.json({ deposit: updated });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/reading-room/book ───────────────────────────────────────────
// Books a seat for a specific room + month. Body: { room_id, year, month }.
// The target month must be either the current month (always open) or the
// next month (open only from the 25th of the current month onwards).
// Rejected if:
//   • not a student
//   • no verified deposit
//   • (year, month) is neither current nor next
//   • the next-month window hasn't opened yet
//   • room doesn't exist / isn't active
//   • that room's capacity is already full for that month
//   • student already has a booking for that month (in any room)
// Capacity check + insert wrap in a re-check pattern — cheap and race-safe
// under low concurrency (few rooms × few dozen seats × slow insert rate).
readingRoomRouter.post("/book", bookingWriteLimiter, requireUser, async (req: AuthedRequest, res, next) => {
  try {
    if (req.user!.primary_role !== "student") {
      throw new ApiError(403, "Reading Room booking is available to CA students only");
    }
    const cfg = await loadConfig();
    if (!cfg.open) {
      throw new ApiError(400, "Reading Room bookings are temporarily closed");
    }

    const roomId = need(trim(req.body?.room_id), "room_id");
    const year   = Number.parseInt(String(req.body?.year), 10);
    const month  = Number.parseInt(String(req.body?.month), 10);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      throw new ApiError(400, "year and month are required");
    }

    // Month gate — must be current or next, and next only after the 25th.
    const win = windowFor(year, month);
    if (!win) {
      throw new ApiError(400, "You can only book the current month or the next month");
    }
    if (!win.open) {
      throw new ApiError(400, "Bookings for next month open on the 25th of this month");
    }

    // Deposit gate.
    const [deposit] = await db
      .select()
      .from(readingRoomDeposits)
      .where(eq(readingRoomDeposits.user_id, req.user!.id))
      .limit(1);
    if (!deposit || deposit.status !== "verified") {
      throw new ApiError(403, "Pay the ₹500 refundable deposit first — admin verifies within 1 business day");
    }

    // Capacity + duplicate + insert all happen inside one transaction
    // with a FOR UPDATE lock on the target room row. This serialises
    // concurrent bookings for the same room so the "check-then-insert"
    // pair is atomic — no over-booking, no "everybody rolls back"
    // outcome. Bookings for different rooms don't block each other.
    const row = await db.transaction(async (tx) => {
      const [lockedRoom] = await tx
        .select()
        .from(readingRooms)
        .where(eq(readingRooms.id, roomId))
        .for("update")
        .limit(1);
      if (!lockedRoom) throw new ApiError(404, "Room not found");
      if (!lockedRoom.active) throw new ApiError(400, "That room isn't accepting bookings right now");

      // Per-room capacity gate — now safe because we hold the row lock.
      const [{ n: inUse }] = await tx
        .select({ n: sql<number>`count(*)::int`.as("n") })
        .from(readingRoomBookings)
        .where(and(
          eq(readingRoomBookings.room_id, lockedRoom.id),
          eq(readingRoomBookings.year, year),
          eq(readingRoomBookings.month, month),
          isNull(readingRoomBookings.cancelled_at),
        ));
      if (inUse >= lockedRoom.capacity) {
        throw new ApiError(409, `${lockedRoom.name} is full for that month — pick another room`);
      }

      // Duplicate gate — one seat per student per month across ALL rooms.
      const [existing] = await tx
        .select({
          id:         readingRoomBookings.id,
          room_id:    readingRoomBookings.room_id,
          room_name:  readingRooms.name,
        })
        .from(readingRoomBookings)
        .leftJoin(readingRooms, eq(readingRooms.id, readingRoomBookings.room_id))
        .where(and(
          eq(readingRoomBookings.user_id, req.user!.id),
          eq(readingRoomBookings.year, year),
          eq(readingRoomBookings.month, month),
          isNull(readingRoomBookings.cancelled_at),
        ))
        .limit(1);
      if (existing) {
        if (existing.room_id === lockedRoom.id) {
          return { booking: existing, already: true } as const;
        }
        throw new ApiError(409, `You already have a seat in ${existing.room_name} for that month — cancel it first to switch rooms`);
      }

      try {
        const [inserted] = await tx.insert(readingRoomBookings).values({
          user_id: req.user!.id,
          room_id: lockedRoom.id,
          year, month,
        }).returning();
        return { booking: inserted, already: false } as const;
      } catch (e: any) {
        if (e && String(e.code) === "23505") {
          throw new ApiError(409, "You already have a booking for that month");
        }
        throw e;
      }
    });

    if (row.already) {
      return res.json({ booking: row.booking, already: true });
    }
    res.status(201).json({ booking: row.booking });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/reading-room/cancel ─────────────────────────────────────────
// Cancel one of the student's active bookings. Body: { booking_id }.
// Frees the seat immediately.
readingRoomRouter.post("/cancel", bookingWriteLimiter, requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const bookingId = need(trim(req.body?.booking_id), "booking_id");
    const [existing] = await db
      .select()
      .from(readingRoomBookings)
      .where(and(
        eq(readingRoomBookings.id, bookingId),
        eq(readingRoomBookings.user_id, req.user!.id),
        isNull(readingRoomBookings.cancelled_at),
      ))
      .limit(1);
    if (!existing) {
      throw new ApiError(404, "Booking not found or already cancelled");
    }
    const [row] = await db
      .update(readingRoomBookings)
      .set({ cancelled_at: new Date() })
      .where(eq(readingRoomBookings.id, existing.id))
      .returning();
    res.json({ ok: true, booking: row });
  } catch (err) { handleApiError(err, res, next); }
});
