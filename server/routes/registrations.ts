import { Router } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { events, eventRegistrations, users, payments } from "../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { createRazorpayOrder, razorpayKeyId, verifyCheckoutSignature } from "../lib/razorpay.js";

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

    if (event.capacity !== null && event.registered_count >= event.capacity) {
      throw new ApiError(400, "This event is full");
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
        if (fresh.capacity !== null && fresh.registered_count >= fresh.capacity) {
          throw new ApiError(400, "This event is full");
        }

        const [inserted] = await tx.insert(eventRegistrations).values({
          event_id: event.id,
          user_id: user.id,
          status: "registered",
        }).returning();

        await tx.update(events).set({
          registered_count: sql`${events.registered_count} + 1`,
          updated_at: new Date(),
        }).where(eq(events.id, event.id));

        return inserted;
      });

      return res.status(201).json({ paid: false, registration: row });
    }

    // â”€â”€ Paid event: open a Razorpay order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // We create the payment row first (without razorpay_order_id), use its UUID
    // as the Razorpay receipt, then patch the order id back. This way every
    // payment we attempt has a row, even if order creation fails â€” easier
    // reconciliation than relying on Razorpay being the source of truth.
    const [payment] = await db.insert(payments).values({
      payer_user_id: user.id,
      amount_paise: event.fee_paise,
      currency: "INR",
      status: "created",
      purpose: "event_registration",
      ref_type: "event",
      ref_id: event.id,
      metadata: {
        event_slug: event.slug,
        event_title: event.title,
      },
    }).returning();

    const order = await createRazorpayOrder({
      amount_paise: event.fee_paise,
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
      amount_paise: event.fee_paise,
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

      return { payment: updatedPayment, registration };
    });

    res.status(201).json({ paid: true, registration: result.registration });
  } catch (err) { handleApiError(err, res, next); }
});
