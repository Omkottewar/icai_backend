import { Router } from "express";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { events, eventRegistrations, users, payments, roles, userRoleAssignments } from "../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { bookingWriteLimiter } from "../middleware/rateLimit.js";
import { notifyAsync } from "../lib/notify.js";
import { streamCertificate } from "../lib/certificates.js";
import { buildCalendar } from "../lib/ical.js";
import { buildInitRedirect, paiseToRupees } from "../lib/sabpaisa/client.js";
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
//   fee_paise = 0 → create the registration immediately, return paid=false.
//   fee_paise > 0 → create a `payments` row in status "pending", build the
//                   SabPaisa init payload, return { action, clientCode,
//                   encData } so the browser auto-POSTs to SabPaisa's
//                   hosted checkout. The event_registrations row is created
//                   later by sabpaisa/confirm.ts once the gateway confirms
//                   via callback / webhook. No manual UTR approval anymore.
// LEGACY (pre-migration-0100):
//   fee_paise = 0 â†’ create the registration immediately, return paid=false.
//   fee_paise > 0 â†’ create a `payments` row in status "created", open a
//                   Razorpay order, return the order id + public key so the
//                   browser can launch Razorpay Checkout. No registration row
//                   yet â€” that's created on /verify-payment after the
//                   signature checks out.
registrationsRouter.post("/:slug/register", bookingWriteLimiter, requireUser, async (req: AuthedRequest, res, next) => {
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
        // Lock the event row FOR UPDATE so concurrent registrations
        // serialise on capacity. Postgres default isolation is READ
        // COMMITTED, so without this lock two racing transactions can
        // both read registered_count=49 and both increment to 50 —
        // silent over-registration. FOR UPDATE takes a row-level lock
        // that blocks any other txn also trying to read+increment this
        // event, but leaves reads of OTHER events / other rows alone.
        const [fresh] = await tx.select({
          capacity: events.capacity,
          registered_count: events.registered_count,
        }).from(events).where(eq(events.id, event.id)).for("update").limit(1);
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

    // ── Paid event: SabPaisa hosted checkout ──────────────────────────
    // We DON'T create the registration row yet — that happens in
    // sabpaisa/confirm.ts once the gateway confirms payment via the
    // callback/webhook. The payment row is the durable handle: user gets
    // its id + the SabPaisa redirect form, we route them to SabPaisa's
    // hosted page, they pay, SabPaisa calls us back, we create the
    // registration.
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

    const [payment] = await db.insert(payments).values({
      payer_user_id: user.id,
      amount_paise: totalPaise,
      currency: "INR",
      status: "pending",
      provider: "sabpaisa",
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
        // Payer details stashed so /api/payments/initiate can re-build the
        // SabPaisa payload without a user table re-fetch on re-initiate.
        payer_name:  user.name,
        payer_email: user.email,
        payer_phone: phone || user.phone || "",
        // Attendee ids stashed so sabpaisa/confirm.ts can create one
        // event_registrations row per attendee. NULL/empty means self-only.
        attendee_user_ids: attendeeUsers.map((a) => a.id),
      },
    }).returning();

    // Deterministic clientTxnId derived from the payment UUID — small
    // enough to fit SabPaisa's dashboard column, big enough to be globally
    // unique within our tenancy.
    const clientTxnId = `NBWRI-${payment.id.replace(/-/g, "").slice(0, 18)}`;

    let redirect;
    try {
      redirect = buildInitRedirect({
        clientTxnId,
        amountRupees: paiseToRupees(totalPaise),
        payerName:  user.name,
        payerEmail: user.email,
        payerMobile: phone || user.phone || "",
        udf1: "event_registration",
        udf2: event.id,
      });
    } catch (e) {
      // Missing SABPAISA_* env var → surface a clean 503 instead of a 500.
      const msg = e instanceof Error ? e.message : String(e);
      throw new ApiError(503, `Online payments are not configured yet (${msg}). Please contact the branch office.`);
    }

    await db.update(payments).set({
      client_txn_id: clientTxnId,
      updated_at: new Date(),
    }).where(eq(payments.id, payment.id));

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
      // SabPaisa hosted-checkout redirect — frontend auto-POSTs an invisible
      // form carrying these three fields to `action`.
      sabpaisa: {
        action:      redirect.action,
        clientCode:  redirect.clientCode,
        clientTxnId: redirect.clientTxnId,
        encData:     redirect.encData,
      },
      client_txn_id: clientTxnId,
      event: { title: event.title, slug: event.slug },
    });
  } catch (err) { handleApiError(err, res, next); }
});

// The POST /api/events/:slug/submit-utr endpoint was removed by migration
// 0100. In the UPI-manual era, users paid off-platform via a QR, then
// submitted the UTR here so admin could verify it against the bank
// statement. The SabPaisa flow eliminates both — payment is handled on
// SabPaisa's hosted page and confirmation is driven by their callback +
// webhook, no UTR to submit. Historical pending_verification rows are
// still visible in the admin queue for backfill approval.

// ─── GET /api/events/my-pending-payments ─────────────────────────────────
// Returns the caller's payments currently awaiting admin verification, plus
// enough event context for the "you have N pending payment(s)" banner on
// the events page and the dashboard. Members can see status + submitted
// timestamp but not the reject reason (that lives in the rejection email
// only, to keep the UI copy simple).
//
// Stale-pending suppression: a `pending` row is created the moment the user
// clicks Register (before SabPaisa), so hitting Back without paying leaves
// an orphan. We hide `pending` rows older than 15 minutes — SabPaisa
// confirms successful payments within seconds, so anything older is almost
// certainly abandoned. We intentionally do NOT expose a manual-cancel
// button: a user who clicks Cancel seconds after a real success would
// create a ghost-cancelled row that doesn't match the gateway. The purely
// time-based filter avoids that reconciliation nightmare.
//
// Status is never changed by this filter — the row stays `pending` in the
// DB. If SabPaisa's webhook arrives late with a successful payment, the
// normal confirm flow still runs and creates the registration.
// `pending_verification` rows (legacy UPI-manual) are always shown — those
// need admin action and have no auto-timeout.
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
        sql`(
          ${payments.status} = 'pending_verification'
          OR (
            ${payments.status} = 'pending'
            AND ${payments.created_at} > now() - interval '15 minutes'
          )
        )`,
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

// ─── POST /api/events/:slug/request-cancellation ──────────────────────────
// Members no longer cancel directly. They file a REQUEST with a reason that
// a branch_chairman / admin reviews from the admin console. This endpoint:
//   • Validates the user has an active, cancellable registration.
//   • Rejects duplicate requests (one pending at a time per registration).
//   • Stamps cancellation_requested_at + cancellation_reason on the row.
//   • Notifies every active branch_chairman + admin so someone picks it up.
//
// The actual cancellation (status flip, counter decrement, waitlist promote,
// refund flag) happens later in POST /api/admin/events/registrations/:id/
// approve-cancellation — which calls performRegistrationCancellation() below.
registrationsRouter.post("/:slug/request-cancellation", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    const slug = need(trim(req.params.slug), "Event slug");
    const reason = need(trim(req.body?.reason), "Reason").slice(0, 1000);
    if (reason.length < 5) throw new ApiError(400, "Please give a short reason (at least 5 characters)");

    const [event] = await db
      .select()
      .from(events)
      .where(and(eq(events.slug, slug), isNull(events.deleted_at)))
      .limit(1);
    if (!event) throw new ApiError(404, "Event not found");

    const [reg] = await db
      .select()
      .from(eventRegistrations)
      .where(and(
        eq(eventRegistrations.event_id, event.id),
        eq(eventRegistrations.user_id, user.id),
        isNull(eventRegistrations.deleted_at),
      ))
      .limit(1);
    if (!reg) throw new ApiError(404, "You don't have an active registration for this event");
    if (reg.status === "attended") throw new ApiError(400, "Cannot cancel after attendance has been recorded");
    if (reg.status === "cancelled") throw new ApiError(400, "This registration is already cancelled");

    // Pending request already exists — don't let a user flood the admin
    // queue with the same registration. They can wait or contact the branch.
    if (reg.cancellation_requested_at && !reg.cancellation_decided_at) {
      throw new ApiError(409, "A cancellation request for this registration is already pending review");
    }

    await db.update(eventRegistrations).set({
      cancellation_requested_at:  new Date(),
      cancellation_reason:        reason,
      // Clear any prior decision fields in case this is a re-request after
      // a rejected one.
      cancellation_decided_at:    null,
      cancellation_decided_by:    null,
      cancellation_decision:      null,
      cancellation_reject_reason: null,
    }).where(eq(eventRegistrations.id, reg.id));

    // Fire S.n to every active branch_chairman + admin so a human picks it
    // up. Fire-and-forget — a notify failure must not block the request
    // from being saved.
    (async () => {
      try {
        const recipientIds = await adminReviewerIds(event.branch_id ?? null);
        if (recipientIds.length === 0) return;
        const vars = eventNotifyVars(event);
        const memberName = user.name || user.email || "A member";
        const memberEmail = user.email || "—";
        const reviewLink = `${process.env.APP_URL ?? ""}/admin/cancellation-requests`;
        const reasonShort = reason.length > 60 ? reason.slice(0, 57) + "…" : reason;
        for (const uid of recipientIds) {
          notifyAsync({
            user_id: uid,
            template_key: "cancellation_requested_admin",
            vars: {
              ...vars,
              member_name:  memberName,
              member_email: memberEmail,
              cancellation_reason: reason,
              cancellation_reason_short: reasonShort,
              review_link: reviewLink,
            },
            link_url: "/admin/cancellation-requests",
          });
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[request-cancellation] admin notify dispatch failed:", err);
      }
    })();

    res.json({
      ok: true,
      request: {
        registration_id: reg.id,
        requested_at: new Date().toISOString(),
      },
    });
  } catch (err) { handleApiError(err, res, next); }
});

// Shared helper — actually performs the cancellation: flips status, decrements
// seat count, promotes the oldest waitlisted user. Returns the event + the
// promoted user (if any) so the caller can fire notifications outside the
// transaction. Called from the admin approve-cancellation endpoint.
export async function performRegistrationCancellation(registrationId: string): Promise<{
  event: typeof events.$inferSelect;
  reg:   typeof eventRegistrations.$inferSelect;
  wasConfirmed: boolean;
  promoted: { id: string; user_id: string } | null;
}> {
  return db.transaction(async (tx) => {
    const [reg] = await tx.select().from(eventRegistrations).where(eq(eventRegistrations.id, registrationId)).limit(1);
    if (!reg) throw new ApiError(404, "Registration not found");
    if (reg.status === "cancelled" || reg.deleted_at) throw new ApiError(400, "Registration is already cancelled");
    if (reg.status === "attended") throw new ApiError(400, "Cannot cancel after attendance has been recorded");

    const [event] = await tx.select().from(events).where(eq(events.id, reg.event_id)).limit(1);
    if (!event) throw new ApiError(404, "Linked event not found");

    const wasConfirmed = reg.status === "registered";

    await tx.update(eventRegistrations).set({
      status:     "cancelled",
      deleted_at: new Date(),
    }).where(eq(eventRegistrations.id, reg.id));

    if (wasConfirmed) {
      await tx.update(events).set({
        registered_count: sql`GREATEST(${events.registered_count} - 1, 0)`,
        updated_at: new Date(),
      }).where(eq(events.id, event.id));
    }

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
        await tx.update(eventRegistrations).set({ status: "registered" }).where(eq(eventRegistrations.id, next.id));
        await tx.update(events).set({
          registered_count: sql`${events.registered_count} + 1`,
          updated_at: new Date(),
        }).where(eq(events.id, event.id));
        promoted = next;
      }
    }

    return { event, reg, wasConfirmed, promoted };
  });
}

// Fire the waitlist-promoted notification. Separated so the admin approve
// endpoint can reuse it alongside its own notifications.
export function notifyWaitlistPromotion(event: typeof events.$inferSelect, promoted_user_id: string): void {
  notifyAsync({
    user_id: promoted_user_id,
    template_key: "event_waitlist_promoted",
    vars: eventNotifyVars(event),
    link_url: `/dashboard`,
  });
}

// Lookup the user_ids that should be notified when a cancellation request
// lands: every active branch_chairman + anyone with the global admin role.
// Scoped to the event's branch when possible; falls back to global if branch
// is null.
async function adminReviewerIds(branchId: string | null): Promise<string[]> {
  const rows = await db
    .selectDistinct({ user_id: userRoleAssignments.user_id })
    .from(userRoleAssignments)
    .innerJoin(roles, eq(roles.id, userRoleAssignments.role_id))
    .innerJoin(users, eq(users.id, userRoleAssignments.user_id))
    .where(and(
      isNull(users.deleted_at),
      or(
        isNull(userRoleAssignments.effective_to),
        sql`${userRoleAssignments.effective_to} >= CURRENT_DATE`,
      )!,
      inArray(roles.code, ["branch_chairman", "admin"]),
      // admin role is global; branch_chairman gets the branch filter.
      or(
        eq(roles.code, "admin"),
        isNull(userRoleAssignments.scope_branch_id),
        branchId ? eq(userRoleAssignments.scope_branch_id, branchId) : sql`FALSE`,
      )!,
    ));
  return rows.map((r) => r.user_id).filter(Boolean);
}

// ─── POST /api/events/:slug/waitlist ──────────────────────────────────────
// Explicit join-waitlist endpoint. The /register path already adds to the
// waitlist transparently for free events when capacity is full, so this
// route exists primarily for paid events where the UI surfaces "Join
// waitlist" as a distinct CTA (no payment until promoted).
registrationsRouter.post("/:slug/waitlist", bookingWriteLimiter, requireUser, async (req: AuthedRequest, res, next) => {
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
