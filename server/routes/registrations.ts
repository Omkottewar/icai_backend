import { Router } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { events, eventRegistrations, users, payments, siteSettings } from "../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { notifyAsync } from "../lib/notify.js";
import { streamCertificate } from "../lib/certificates.js";
import { buildCalendar } from "../lib/ical.js";
import { createHmac } from "node:crypto";
import { memberProfiles } from "../../schema/index.js";

// IST formatter used in notification copy. The events themselves store UTC;
// users expect to see local time.
const IST = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "short",
});
const IST_DATE = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", dateStyle: "medium",
});
const IST_TIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata", timeStyle: "short",
});

function eventNotifyVars(event: { title: string; slug: string; venue: string | null; online_url: string | null; starts_at: Date; cpe_hours?: string | number | null; mode: string }) {
  const startsAt = event.starts_at instanceof Date ? event.starts_at : new Date(event.starts_at);
  return {
    event_title:  event.title,
    event_slug:   event.slug,
    event_date:   IST_DATE.format(startsAt),
    event_time:   IST_TIME.format(startsAt),
    event_venue:  event.venue || (event.mode === "online" ? "Online" : "TBC"),
    cpe_hours:    event.cpe_hours ?? "",
    calendar_link: `${process.env.APP_URL ?? ""}/events`,
    joining_link_or_directions: event.online_url || event.venue || "Details will be shared closer to the date.",
  };
}

// Fetch the branch's UPI VPA + display name from site_settings. Both are
// admin-editable via the Site Content admin so switching UPI providers (or
// account holders) is a one-click change without a redeploy.
async function loadUpiConfig(): Promise<{ upi_id: string; payee_name: string }> {
  const rows = await db
    .select({ key: siteSettings.key, value: siteSettings.value })
    .from(siteSettings);
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    upi_id: (map.get("payment_upi_id") ?? "").trim(),
    payee_name: (map.get("payment_upi_payee_name") ?? "ICAI Nagpur Branch").trim(),
  };
}

// Build the UPI intent URI (`upi://pay?pa=...&pn=...&am=...&tn=...&cu=INR`)
// the frontend renders as a QR. Scanning this in any UPI app opens a
// payment screen with the amount already filled in — the user just picks
// the source account and hits Pay. `tn` (transaction note) is the payment
// UUID so the branch can cross-reference the UTR against the payments row.
function buildUpiUri(input: { upi_id: string; payee_name: string; amount_paise: number; note: string }): string {
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

export const registrationsRouter = Router();

// â”€â”€â”€ GET /api/events/my-registrations â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns just the event IDs the current user is registered for (active /
// non-deleted rows only). EventsPage uses this to flip the Register button
// to a "Registered âœ“" badge. Kept separate from the public /api/events
// listing so that listing stays cacheable and anonymous.
registrationsRouter.get("/my-registrations", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db
      .select({
        event_id: eventRegistrations.event_id,
        status: eventRegistrations.status,
      })
      .from(eventRegistrations)
      .where(and(
        eq(eventRegistrations.user_id, req.user!.id),
        isNull(eventRegistrations.deleted_at),
      ));
    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ POST /api/events/:slug/register â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Self-service registration. Two paths depending on the event fee:
//   fee_paise = 0 â†’ create the registration immediately, return paid=false.
//   fee_paise > 0 â†’ create a `payments` row in status "created", open a
//                   Razorpay order, return the order id + public key so the
//                   browser can launch Razorpay Checkout. No registration row
//                   yet â€” that's created on /verify-payment after the
//                   signature checks out.
registrationsRouter.post("/:slug/register", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    const slug = need(trim(req.params.slug), "Event slug");
    const phone = trim(req.body?.phone);

    // Group booking (paid events only): booker picks 1-N portal users as
    // additional attendees. All seats charged on one payment. On admin
    // approve every attendee gets their own event_registrations row with
    // booked_by_user_id set to the booker so their dashboard shows the
    // attribution. Attendee list is validated below and stashed in
    // payment.metadata so admin approve can recover it.
    const rawAttendees = Array.isArray(req.body?.attendee_user_ids) ? req.body.attendee_user_ids : [];
    const attendeeIds: string[] = [];
    const seen = new Set<string>();
    for (const raw of rawAttendees) {
      const id = trim(raw);
      if (!id) continue;
      if (id === user.id) continue;      // Booker is not an attendee — always in seat 1
      if (seen.has(id)) continue;         // Deduplicate
      seen.add(id);
      attendeeIds.push(id);
    }
    // Soft cap so a bad client can't try to book 500 seats and DoS the DB.
    if (attendeeIds.length > 20) throw new ApiError(400, "You can book at most 20 additional seats in one payment.");

    // Step 1: load the event and run preflight checks outside the txn â€”
    // these reject the request without touching writable state.
    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.slug, slug), isNull(events.deleted_at)))
      .limit(1);

    if (!event || event.status !== "published") throw new ApiError(404, "Event not found");
    if (event.starts_at <= new Date()) throw new ApiError(400, "Registration is closed for this event");

    const [existing] = await db
      .select({ id: eventRegistrations.id, status: eventRegistrations.status })
      .from(eventRegistrations)
      .where(and(
        eq(eventRegistrations.event_id, event.id),
        eq(eventRegistrations.user_id, user.id),
        isNull(eventRegistrations.deleted_at),
      ))
      .limit(1);
    if (existing) throw new ApiError(409, "You are already registered for this event");

    // Validate attendees when the booker is buying group seats. Every
    // attendee must (a) exist and not be soft-deleted, and (b) not already
    // be registered for this event. Failing early with a clear message is
    // better than silently dropping them at admin-approve time.
    let attendeeUsers: Array<{ id: string; name: string; email: string }> = [];
    if (attendeeIds.length > 0) {
      if (event.fee_paise === 0) {
        // Group bookings on free events don't make sense — each user can
        // just register themselves in one click. Blocking this keeps the
        // fee×N math from producing "pay ₹0" edge cases.
        throw new ApiError(400, "Group booking is only available for paid events. Ask each attendee to register themselves.");
      }
      const rows = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(and(inArray(users.id, attendeeIds), isNull(users.deleted_at)));
      if (rows.length !== attendeeIds.length) {
        throw new ApiError(400, "One of the selected attendees no longer exists.");
      }
      const existingReg = await db
        .select({ user_id: eventRegistrations.user_id })
        .from(eventRegistrations)
        .where(and(
          eq(eventRegistrations.event_id, event.id),
          inArray(eventRegistrations.user_id, attendeeIds),
          isNull(eventRegistrations.deleted_at),
        ));
      if (existingReg.length > 0) {
        const conflictName = rows.find((r) => r.id === existingReg[0].user_id)?.name ?? "One of your attendees";
        throw new ApiError(409, `${conflictName} is already registered for this event.`);
      }
      attendeeUsers = rows;
    }

    const totalSeats = 1 + attendeeUsers.length;

    // Capacity full → fall through to a waitlist registration on the free
    // path. We still reject paid registrations against a full event to
    // avoid charging for a non-confirmed seat — the UI should call
    // /:slug/waitlist below instead in that case.
    const seatsLeft = event.capacity !== null ? event.capacity - event.registered_count : Infinity;
    const isFull = event.capacity !== null && seatsLeft <= 0;
    if (event.fee_paise > 0 && seatsLeft < totalSeats) {
      throw new ApiError(400, isFull
        ? "This event is full. Use 'Join waitlist' instead."
        : `Only ${seatsLeft} seat${seatsLeft === 1 ? '' : 's'} left — reduce the number of attendees or try 'Join waitlist'.`);
    }

    // Step 2: optionally sync the phone the user just entered back to their
    // profile so future registrations prefill it. Email/name we trust as-is.
    if (phone && phone !== user.phone) {
      await db.update(users)
        .set({ phone, updated_at: new Date() })
        .where(eq(users.id, user.id));
    }

    // â”€â”€ Free event: create the registration row right now â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (event.fee_paise === 0) {
      const row = await db.transaction(async (tx) => {
        // Re-check capacity inside the txn so two concurrent registrations
        // can't both slip past the soft check above.
        const [fresh] = await tx.select({
          capacity: events.capacity,
          registered_count: events.registered_count,
        }).from(events).where(eq(events.id, event.id)).limit(1);
        // If full at this exact moment, register as waitlisted instead of
        // rejecting. The cancel endpoint auto-promotes the oldest waitlist
        // entry, so the user gets in if a seat opens up.
        const wouldBeFull = fresh.capacity !== null && fresh.registered_count >= fresh.capacity;
        const status = wouldBeFull ? "waitlisted" : "registered";

        const [inserted] = await tx.insert(eventRegistrations).values({
          event_id: event.id,
          user_id: user.id,
          status,
        }).returning();

        // registered_count only tracks confirmed seats, not waitlist.
        if (status === "registered") {
          await tx.update(events).set({
            registered_count: sql`${events.registered_count} + 1`,
            updated_at: new Date(),
          }).where(eq(events.id, event.id));
        }

        return inserted;
      });

      // Confirmation only for confirmed seats — waitlist users get S.3 when
      // they're promoted.
      if (row.status === "registered") {
        notifyAsync({
          user_id: user.id,
          template_key: "event_registered",
          vars: eventNotifyVars(event),
          link_url: `/dashboard`,
        });
      }

      return res.status(201).json({
        paid: false,
        registration: row,
        waitlisted: row.status === "waitlisted",
      });
    }

    // ── Paid event: UPI QR flow ────────────────────────────────────────
    // We DON'T create the registration row yet — that happens only after
    // an admin verifies the UTR the user submits. The payment row is the
    // durable handle: user gets its id + the UPI URI, submits UTR against
    // it, admin approves against it, registration is created against it.
    //
    // GST (H.20): when gst_applicable is true, the fee shown to the user
    // is base + GST. We store both numbers in payment.metadata so the
    // invoice generator can recover the split deterministically. For group
    // bookings the total is (base + GST) × seats — same GST rate applied
    // per seat, matching how branch invoices already work.
    const perSeatBase = event.fee_paise;
    const gstRate = event.gst_applicable ? Number(event.gst_percent ?? 0) : 0;
    const perSeatGst = Math.round(perSeatBase * gstRate / 100);
    const perSeatTotal = perSeatBase + perSeatGst;
    const totalPaise = perSeatTotal * totalSeats;

    const upi = await loadUpiConfig();
    if (!upi.upi_id) {
      throw new ApiError(503, "Online payments are not configured yet. Please contact the branch office.");
    }

    const [payment] = await db.insert(payments).values({
      payer_user_id: user.id,
      amount_paise: totalPaise,
      currency: "INR",
      status: "pending",
      purpose: "event_registration",
      ref_type: "event",
      ref_id: event.id,
      metadata: {
        event_slug: event.slug,
        event_title: event.title,
        base_paise: perSeatBase * totalSeats,
        gst_applicable: event.gst_applicable,
        gst_percent: gstRate,
        gst_paise: perSeatGst * totalSeats,
        seat_count: totalSeats,
        // Attendee ids stashed so admin approve can create one
        // event_registrations row per attendee. NULL/empty means self-only.
        attendee_user_ids: attendeeUsers.map((a) => a.id),
      },
    }).returning();

    // The transaction-note token is what the admin cross-references when
    // reading the bank statement — keep it short + prefixed so it's easy
    // to grep for "ICAI-<id>" in a UPI statement export.
    const upiUri = buildUpiUri({
      upi_id: upi.upi_id,
      payee_name: upi.payee_name,
      amount_paise: totalPaise,
      note: `ICAI-${payment.id.slice(0, 8)}`,
    });

    return res.status(200).json({
      paid: true,
      payment_id: payment.id,
      amount_paise: totalPaise,
      base_paise: perSeatBase * totalSeats,
      gst_paise: perSeatGst * totalSeats,
      gst_applicable: event.gst_applicable,
      gst_percent: gstRate,
      currency: "INR",
      seat_count: totalSeats,
      per_seat_paise: perSeatTotal,
      attendees: attendeeUsers,          // [{ id, name, email }, ...]
      upi_id: upi.upi_id,
      upi_payee_name: upi.payee_name,
      upi_uri: upiUri,
      event: { title: event.title, slug: event.slug },
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/events/:slug/submit-utr ───────────────────────────────────
// User has paid via the UPI QR and is submitting the UTR (UPI transaction
// reference — 12-digit numeric string that any bank/UPI app returns after
// a successful transfer) so an admin can cross-check it against the bank
// statement. Flow:
//   1. Look up the payment row created by POST /register.
//   2. Guard: caller owns it, it's still 'pending' (not already submitted
//      or verified), UTR isn't already in use elsewhere (partial UNIQUE
//      index on payments.upi_utr).
//   3. Flip status → 'pending_verification', stash utr + screenshot.
//   4. Return the payment row so the frontend can show "verification
//      typically takes 24h".
//
// No registration row is created here. That happens only on admin approve.
registrationsRouter.post("/:slug/submit-utr", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    const slug = need(trim(req.params.slug), "Event slug");
    const payment_id = need(trim(req.body?.payment_id), "Payment ID");
    const utr = need(trim(req.body?.utr), "UTR (UPI reference number)");
    const screenshot_file_id = trim(req.body?.screenshot_file_id) || null;

    // Basic UTR sanity — most banks emit 12-digit numeric, some emit
    // 22-char alphanumeric. Accept 8-30 alphanumeric chars to cover both
    // without blocking edge-case wallet providers.
    if (!/^[A-Za-z0-9]{8,30}$/.test(utr)) {
      throw new ApiError(400, "UTR looks invalid — enter the 12-digit reference from your UPI app.");
    }

    const [payment] = await db.select().from(payments).where(eq(payments.id, payment_id)).limit(1);
    if (!payment) throw new ApiError(404, "Payment not found");
    if (payment.payer_user_id !== user.id) throw new ApiError(403, "Payment does not belong to this user");
    if (payment.status !== "pending") {
      throw new ApiError(400, `Payment is already in status '${payment.status}'. Refresh the page.`);
    }

    const [event] = await db
      .select({ id: events.id, slug: events.slug })
      .from(events)
      .where(and(eq(events.slug, slug), isNull(events.deleted_at)))
      .limit(1);
    if (!event) throw new ApiError(404, "Event not found");
    if (payment.ref_id !== event.id) throw new ApiError(400, "Payment is for a different event");

    try {
      const [updated] = await db.update(payments).set({
        status: "pending_verification",
        upi_utr: utr,
        upi_screenshot_file_id: screenshot_file_id,
        updated_at: new Date(),
      }).where(eq(payments.id, payment.id)).returning();

      return res.status(200).json({ ok: true, payment: updated });
    } catch (e) {
      // Duplicate UTR — someone submitted the same reference against a
      // different registration. Almost always a copy/paste error; occasionally
      // a fraud attempt. Either way, block it here and route the human to
      // support so admin can eyeball both rows.
      if (e && typeof e === "object" && "code" in e && (e as any).code === "23505") {
        throw new ApiError(409, "This UTR has already been submitted for another payment. If this is a mistake, please contact the branch office.");
      }
      throw e;
    }
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/events/my-pending-payments ─────────────────────────────────
// Returns the caller's payments currently awaiting admin verification, plus
// enough event context for the "you have N pending payment(s)" banner on
// the events page and the dashboard. Members can see status + submitted
// timestamp but not the reject reason (that lives in the rejection email
// only, to keep the UI copy simple).
registrationsRouter.get("/my-pending-payments", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db
      .select({
        payment_id: payments.id,
        event_id: events.id,
        event_slug: events.slug,
        event_title: events.title,
        amount_paise: payments.amount_paise,
        status: payments.status,
        upi_utr: payments.upi_utr,
        submitted_at: payments.updated_at,
      })
      .from(payments)
      .innerJoin(events, eq(events.id, payments.ref_id))
      .where(and(
        eq(payments.payer_user_id, req.user!.id),
        eq(payments.purpose, "event_registration"),
        isNull(payments.deleted_at),
        sql`${payments.status} in ('pending', 'pending_verification')`,
      ))
      .orderBy(sql`${payments.created_at} desc`);
    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Calendar token helpers ──────────────────────────────────────────────
// Per-user subscription URLs (?token=…) so calendar apps can refresh
// without re-auth. Token = HMAC(user.id) keyed off the JWT secret, so it
// can't be forged, doesn't expose user.id directly, and can be rotated by
// changing the secret. Stateless — no DB write to invalidate.
function calendarTokenFor(userId: string): string {
  const secret = process.env.JWT_SECRET ?? "dev-secret";
  return createHmac("sha256", secret).update(`calendar:${userId}`).digest("hex").slice(0, 32);
}
function userIdFromToken(token: string, candidateIds: string[]): string | null {
  for (const id of candidateIds) {
    if (calendarTokenFor(id) === token) return id;
  }
  return null;
}

// ─── GET /api/events/:slug/ical ───────────────────────────────────────────
// Public single-event .ics download. Anyone with the slug can grab it —
// the calendar entry contains nothing private (title + venue + time).
registrationsRouter.get("/:slug/ical", async (req, res, next) => {
  try {
    const slug = need(trim(req.params.slug), "Event slug");
    const [event] = await db
      .select({
        id: events.id,
        slug: events.slug,
        title: events.title,
        description: events.description,
        venue: events.venue,
        online_url: events.online_url,
        starts_at: events.starts_at,
        ends_at: events.ends_at,
        status: events.status,
      })
      .from(events)
      .where(and(eq(events.slug, slug), isNull(events.deleted_at)))
      .limit(1);
    if (!event) throw new ApiError(404, "Event not found");

    const ics = buildCalendar([{
      uid: `event-${event.id}@icai-nagpur`,
      title: event.title,
      description: event.description ?? null,
      location: event.venue ?? null,
      url: event.online_url ?? `${process.env.APP_URL ?? ""}/events/${event.slug}`,
      start: event.starts_at,
      end: event.ends_at,
      organizerEmail: "nagpur@icai.org",
      organizerName: "ICAI Nagpur Branch (WIRC)",
      status: event.status === "cancelled" ? "CANCELLED" : "CONFIRMED",
    }], event.title);

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${event.slug}.ics"`);
    res.send(ics);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/events/my-calendar.ics ──────────────────────────────────────
// Per-user subscription feed of every event the user is registered for
// (status in registered/waitlisted/attended). Calendar apps refresh this
// URL hourly. Authenticated either by session (browser opens it directly)
// or by ?token=<hmac> (calendar app on a different device).
registrationsRouter.get("/my-calendar.ics", async (req: AuthedRequest, res, next) => {
  try {
    // Prefer session if present; else try token.
    let userId = req.user?.id;
    if (!userId) {
      const token = trim(req.query.token);
      if (!token) throw new ApiError(401, "Missing session or ?token=");
      // We need the user id space to validate against — small recent list.
      const recent = await db.select({ id: users.id }).from(users)
        .where(isNull(users.deleted_at)).limit(50000);
      userId = userIdFromToken(token, recent.map((u) => u.id)) ?? undefined;
      if (!userId) throw new ApiError(401, "Invalid token");
    }

    const rows = await db
      .select({
        id: events.id,
        slug: events.slug,
        title: events.title,
        description: events.description,
        venue: events.venue,
        online_url: events.online_url,
        starts_at: events.starts_at,
        ends_at: events.ends_at,
        status: events.status,
      })
      .from(eventRegistrations)
      .innerJoin(events, eq(events.id, eventRegistrations.event_id))
      .where(and(
        eq(eventRegistrations.user_id, userId),
        isNull(eventRegistrations.deleted_at),
        isNull(events.deleted_at),
      ));

    const ics = buildCalendar(rows.map((e) => ({
      uid: `event-${e.id}@icai-nagpur`,
      title: e.title,
      description: e.description ?? null,
      location: e.venue ?? null,
      url: e.online_url ?? `${process.env.APP_URL ?? ""}/events/${e.slug}`,
      start: e.starts_at,
      end: e.ends_at,
      organizerEmail: "nagpur@icai.org",
      organizerName: "ICAI Nagpur Branch (WIRC)",
      status: e.status === "cancelled" ? "CANCELLED" : "CONFIRMED",
    })), "My ICAI Nagpur Events");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="my-icai-events.ics"`);
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.send(ics);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/events/my-calendar-url ──────────────────────────────────────
// Returns the user's personal subscription URL so the frontend can show it
// in profile → calendar settings. Requires session.
registrationsRouter.get("/my-calendar-url", requireUser, (req: AuthedRequest, res) => {
  const token = calendarTokenFor(req.user!.id);
  const base = process.env.APP_URL ?? "";
  res.json({
    url: `${base}/api/events/my-calendar.ics?token=${token}`,
    webcal: `${base.replace(/^https?:/, "webcal:")}/api/events/my-calendar.ics?token=${token}`,
  });
});

// ─── GET /api/events/:slug/certificate ────────────────────────────────────
// Streams an attendance certificate PDF for the requesting user. Available
// once their registration is marked 'attended'. Cert numbers are
// deterministic so the same download is reproducible (no DB write here —
// we generate on demand). CPE-hour attribution was removed in migration
// 0087 alongside the rest of the CPE feature.
registrationsRouter.get("/:slug/certificate", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    const slug = need(trim(req.params.slug), "Event slug");

    const [event] = await db
      .select({
        id: events.id,
        slug: events.slug,
        title: events.title,
        starts_at: events.starts_at,
      })
      .from(events)
      .where(and(eq(events.slug, slug), isNull(events.deleted_at)))
      .limit(1);
    if (!event) throw new ApiError(404, "Event not found");

    const [reg] = await db
      .select({ status: eventRegistrations.status })
      .from(eventRegistrations)
      .where(and(
        eq(eventRegistrations.event_id, event.id),
        eq(eventRegistrations.user_id, user.id),
        isNull(eventRegistrations.deleted_at),
      ))
      .limit(1);
    if (!reg) throw new ApiError(404, "You did not attend this event");
    if (reg.status !== "attended") {
      throw new ApiError(403, "Certificate becomes available after attendance is recorded");
    }

    const [profile] = await db
      .select({ mrn: memberProfiles.mrn })
      .from(memberProfiles)
      .where(eq(memberProfiles.user_id, user.id))
      .limit(1);

    const certificateNo = `NGP-EVT-${event.slug.slice(-8).toUpperCase()}-${user.id.slice(0, 8).toUpperCase()}`;
    const filename = `certificate-${event.slug}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

    streamCertificate({
      memberName: user.name,
      memberMrn: profile?.mrn ?? null,
      eventTitle: event.title,
      eventDate: event.starts_at,
      branchName: "ICAI Nagpur Branch (WIRC)",
      certificateNo,
    }, res);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/events/:slug/cancel ────────────────────────────────────────
// User cancels their own registration. Soft-deletes the row, decrements
// registered_count, and auto-promotes the oldest waitlisted user (S.3 fires
// to them). Idempotent: cancelling something already cancelled is a no-op.
// Paid registrations remain canceled here but refund processing is manual
// (see admin refunds module).
registrationsRouter.post("/:slug/cancel", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    const slug = need(trim(req.params.slug), "Event slug");

    const result = await db.transaction(async (tx) => {
      const [event] = await tx
        .select()
        .from(events)
        .where(and(eq(events.slug, slug), isNull(events.deleted_at)))
        .limit(1);
      if (!event) throw new ApiError(404, "Event not found");

      const [reg] = await tx
        .select()
        .from(eventRegistrations)
        .where(and(
          eq(eventRegistrations.event_id, event.id),
          eq(eventRegistrations.user_id, user.id),
          isNull(eventRegistrations.deleted_at),
        ))
        .limit(1);
      if (!reg) throw new ApiError(404, "You don't have an active registration for this event");
      if (reg.status === "attended") {
        throw new ApiError(400, "Cannot cancel after attendance has been recorded");
      }

      const wasConfirmed = reg.status === "registered";

      // Mark cancelled (soft delete preserves the audit trail).
      await tx.update(eventRegistrations).set({
        status: "cancelled",
        deleted_at: new Date(),
      }).where(eq(eventRegistrations.id, reg.id));

      // Only decrement the counter for confirmed cancellations.
      if (wasConfirmed) {
        await tx.update(events).set({
          registered_count: sql`GREATEST(${events.registered_count} - 1, 0)`,
          updated_at: new Date(),
        }).where(eq(events.id, event.id));
      }

      // Auto-promote the oldest waitlisted user — only if a confirmed seat
      // opened up (cancelling a waitlist entry doesn't free anything).
      let promoted: { id: string; user_id: string } | null = null;
      if (wasConfirmed) {
        const [next] = await tx
          .select({ id: eventRegistrations.id, user_id: eventRegistrations.user_id })
          .from(eventRegistrations)
          .where(and(
            eq(eventRegistrations.event_id, event.id),
            eq(eventRegistrations.status, "waitlisted"),
            isNull(eventRegistrations.deleted_at),
          ))
          .orderBy(eventRegistrations.registered_at)
          .limit(1);

        if (next) {
          await tx.update(eventRegistrations).set({
            status: "registered",
          }).where(eq(eventRegistrations.id, next.id));

          await tx.update(events).set({
            registered_count: sql`${events.registered_count} + 1`,
            updated_at: new Date(),
          }).where(eq(events.id, event.id));

          promoted = next;
        }
      }

      return { event, promoted };
    });

    // Fire S.3 to the promoted user (outside the txn — notify is async).
    if (result.promoted) {
      notifyAsync({
        user_id: result.promoted.user_id,
        template_key: "event_waitlist_promoted",
        vars: eventNotifyVars(result.event),
        link_url: `/dashboard`,
      });
    }

    res.json({ ok: true, promoted: !!result.promoted });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/events/:slug/waitlist ──────────────────────────────────────
// Explicit join-waitlist endpoint. The /register path already adds to the
// waitlist transparently for free events when capacity is full, so this
// route exists primarily for paid events where the UI surfaces "Join
// waitlist" as a distinct CTA (no payment until promoted).
registrationsRouter.post("/:slug/waitlist", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    const slug = need(trim(req.params.slug), "Event slug");

    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.slug, slug), isNull(events.deleted_at)))
      .limit(1);
    if (!event || event.status !== "published") throw new ApiError(404, "Event not found");
    if (event.starts_at <= new Date()) throw new ApiError(400, "This event has already started");

    const [existing] = await db
      .select({ id: eventRegistrations.id, status: eventRegistrations.status })
      .from(eventRegistrations)
      .where(and(
        eq(eventRegistrations.event_id, event.id),
        eq(eventRegistrations.user_id, user.id),
        isNull(eventRegistrations.deleted_at),
      ))
      .limit(1);
    if (existing) {
      throw new ApiError(409, `You are already ${existing.status} for this event`);
    }

    const [row] = await db.insert(eventRegistrations).values({
      event_id: event.id,
      user_id: user.id,
      status: "waitlisted",
    }).returning();

    res.status(201).json({ registration: row, waitlisted: true });
  } catch (err) { handleApiError(err, res, next); }
});
