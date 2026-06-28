import { Router } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { events, eventRegistrations, users, payments } from "../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { createRazorpayOrder, razorpayKeyId, verifyCheckoutSignature } from "../lib/razorpay.js";
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

function eventNotifyVars(event: { title: string; slug: string; venue: string | null; online_url: string | null; starts_at: Date; cpe_hours: string | number; mode: string }) {
  const startsAt = event.starts_at instanceof Date ? event.starts_at : new Date(event.starts_at);
  return {
    event_title:  event.title,
    event_slug:   event.slug,
    event_date:   IST_DATE.format(startsAt),
    event_time:   IST_TIME.format(startsAt),
    event_venue:  event.venue || (event.mode === "online" ? "Online" : "TBC"),
    cpe_hours:    event.cpe_hours,
    calendar_link: `${process.env.APP_URL ?? ""}/#/events`,
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

    // Capacity full → fall through to a waitlist registration on the free
    // path. We still reject paid registrations against a full event to
    // avoid charging for a non-confirmed seat — the UI should call
    // /:slug/waitlist below instead in that case.
    const isFull = event.capacity !== null && event.registered_count >= event.capacity;
    if (isFull && event.fee_paise > 0) {
      throw new ApiError(400, "This event is full. Use 'Join waitlist' instead.");
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
          link_url: `/#/dashboard`,
        });
      }

      return res.status(201).json({
        paid: false,
        registration: row,
        waitlisted: row.status === "waitlisted",
      });
    }

    // â”€â”€ Paid event: open a Razorpay order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // We create the payment row first (without razorpay_order_id), use its UUID
    // as the Razorpay receipt, then patch the order id back. This way every
    // payment we attempt has a row, even if order creation fails â€” easier
    // reconciliation than relying on Razorpay being the source of truth.
    //
    // GST (H.20): when gst_applicable is true, the fee shown to the user is
    // base + GST. We store both numbers in payment.metadata so the invoice
    // generator and reconciliation can recover the split deterministically.
    const baseFee = event.fee_paise;
    const gstRate = event.gst_applicable ? Number(event.gst_percent ?? 0) : 0;
    const gstPaise = Math.round(baseFee * gstRate / 100);
    const totalPaise = baseFee + gstPaise;

    const [payment] = await db.insert(payments).values({
      payer_user_id: user.id,
      amount_paise: totalPaise,
      currency: "INR",
      status: "created",
      purpose: "event_registration",
      ref_type: "event",
      ref_id: event.id,
      metadata: {
        event_slug: event.slug,
        event_title: event.title,
        base_paise: baseFee,
        gst_applicable: event.gst_applicable,
        gst_percent: gstRate,
        gst_paise: gstPaise,
      },
    }).returning();

    const order = await createRazorpayOrder({
      amount_paise: totalPaise,
      receipt: payment.id.slice(0, 40),
      notes: {
        event_id: event.id,
        user_id: user.id,
        payment_id: payment.id,
      },
    });

    await db.update(payments)
      .set({ razorpay_order_id: order.id, updated_at: new Date() })
      .where(eq(payments.id, payment.id));

    return res.status(200).json({
      paid: true,
      payment_id: payment.id,
      order_id: order.id,
      amount_paise: totalPaise,
      base_paise: baseFee,
      gst_paise: gstPaise,
      gst_applicable: event.gst_applicable,
      gst_percent: gstRate,
      currency: "INR",
      key_id: razorpayKeyId(),
      event: { title: event.title, slug: event.slug },
      prefill: { name: user.name, email: user.email, contact: phone || user.phone || "" },
    });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ POST /api/events/:slug/verify-payment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Razorpay Checkout returns order_id + payment_id + signature on success.
// We verify the HMAC, mark the payment row paid, and create the registration
// row in the same transaction. The whole thing is idempotent on payment_id â€”
// Razorpay does retry callbacks.
registrationsRouter.post("/:slug/verify-payment", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    const slug = need(trim(req.params.slug), "Event slug");
    const payment_id = need(trim(req.body?.payment_id), "Payment ID");
    const razorpay_order_id = need(trim(req.body?.razorpay_order_id), "Razorpay order ID");
    const razorpay_payment_id = need(trim(req.body?.razorpay_payment_id), "Razorpay payment ID");
    const razorpay_signature = need(trim(req.body?.razorpay_signature), "Razorpay signature");

    const ok = verifyCheckoutSignature({
      order_id: razorpay_order_id,
      payment_id: razorpay_payment_id,
      signature: razorpay_signature,
    });

    if (!ok) {
      // Mark the payment failed so admins can see the bad attempt
      await db.update(payments)
        .set({ status: "failed", updated_at: new Date() })
        .where(eq(payments.id, payment_id));
      throw new ApiError(400, "Payment signature verification failed");
    }

    const result = await db.transaction(async (tx) => {
      const [payment] = await tx.select().from(payments).where(eq(payments.id, payment_id)).limit(1);
      if (!payment) throw new ApiError(404, "Payment not found");
      if (payment.payer_user_id !== user.id) throw new ApiError(403, "Payment does not belong to this user");
      if (payment.razorpay_order_id !== razorpay_order_id) {
        throw new ApiError(400, "Payment / order mismatch");
      }

      const [event] = await tx
        .select()
        .from(events)
        .where(and(eq(events.slug, slug), isNull(events.deleted_at)))
        .limit(1);
      if (!event) throw new ApiError(404, "Event not found");
      if (payment.ref_id !== event.id) throw new ApiError(400, "Payment is for a different event");

      // Idempotency: if we've already verified this payment, return the existing registration.
      if (payment.status === "success") {
        const [existing] = await tx
          .select()
          .from(eventRegistrations)
          .where(and(
            eq(eventRegistrations.event_id, event.id),
            eq(eventRegistrations.user_id, user.id),
            isNull(eventRegistrations.deleted_at),
          ))
          .limit(1);
        if (existing) return { payment, registration: existing };
      }

      if (event.capacity !== null && event.registered_count >= event.capacity) {
        // Edge case: event filled up between order creation and payment. Mark
        // the payment refundable so an admin can issue a refund.
        await tx.update(payments).set({
          status: "success",
          razorpay_payment_id,
          razorpay_signature,
          metadata: { ...(payment.metadata as object || {}), needs_refund: "event_full_after_payment" },
          updated_at: new Date(),
        }).where(eq(payments.id, payment.id));
        throw new ApiError(409, "Event filled up before payment completed. Our team will refund you shortly.");
      }

      const [updatedPayment] = await tx.update(payments).set({
        status: "success",
        razorpay_payment_id,
        razorpay_signature,
        updated_at: new Date(),
      }).where(eq(payments.id, payment.id)).returning();

      const [registration] = await tx.insert(eventRegistrations).values({
        event_id: event.id,
        user_id: user.id,
        status: "registered",
        payment_id: payment.id,
      }).returning();

      await tx.update(events).set({
        registered_count: sql`${events.registered_count} + 1`,
        updated_at: new Date(),
      }).where(eq(events.id, event.id));

      return { payment: updatedPayment, registration, event };
    });

    // Skip when the transaction took the idempotent path (no fresh registration)
    // — the user already received a confirmation on the first successful verify.
    if (result.event) {
      notifyAsync({
        user_id: user.id,
        template_key: "event_registered",
        vars: eventNotifyVars(result.event),
        link_url: `/#/dashboard`,
      });
    }

    res.status(201).json({ paid: true, registration: result.registration });
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
      url: event.online_url ?? `${process.env.APP_URL ?? ""}/#/events/${event.slug}`,
      start: event.starts_at,
      end: event.ends_at,
      organizerEmail: "nagpur@icai.org",
      organizerName: "Nagpur Branch of WIRC of ICAI",
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
      url: e.online_url ?? `${process.env.APP_URL ?? ""}/#/events/${e.slug}`,
      start: e.starts_at,
      end: e.ends_at,
      organizerEmail: "nagpur@icai.org",
      organizerName: "Nagpur Branch of WIRC of ICAI",
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
// Streams an attendance + CPE certificate PDF for the requesting user.
// Only available when the user's registration is 'attended' AND the event
// awards CPE hours. Cert numbers are deterministic so the same download is
// reproducible (no DB write here — we generate on demand).
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
        cpe_hours: events.cpe_hours,
      })
      .from(events)
      .where(and(eq(events.slug, slug), isNull(events.deleted_at)))
      .limit(1);
    if (!event) throw new ApiError(404, "Event not found");
    if (Number(event.cpe_hours) <= 0) {
      throw new ApiError(400, "This event does not award CPE hours");
    }

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

    const certificateNo = `NGP-CPE-${event.slug.slice(-8).toUpperCase()}-${user.id.slice(0, 8).toUpperCase()}`;
    const filename = `certificate-${event.slug}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${filename}"`);

    streamCertificate({
      memberName: user.name,
      memberMrn: profile?.mrn ?? null,
      eventTitle: event.title,
      eventDate: event.starts_at,
      cpeHours: Number(event.cpe_hours),
      branchName: "Nagpur Branch of WIRC of ICAI",
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
        link_url: `/#/dashboard`,
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
