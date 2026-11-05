// Razorpay payment orchestration.
//
// Four endpoints:
//
//   POST /api/payments/initiate
//     Authed. Takes a payment_id (row already created by the originating
//     route — /events/:slug/register or /employer/postings). Creates a
//     Razorpay Order via the Razorpay REST API, stores the order id on the
//     row, and returns { key_id, order_id, amount_paise, currency, prefill }
//     so the browser can open Razorpay Checkout with the correct order.
//
//   POST /api/payments/verify   (authed — browser handler after modal resolves)
//     Body: { razorpay_order_id, razorpay_payment_id, razorpay_signature }
//     Verifies the HMAC signature against our key_secret. If it matches,
//     persists the payment id + signature, calls confirmPaymentAndFulfil,
//     and returns the normalised payment row. Idempotent against the
//     webhook path — whichever lands first flips to success.
//
//   POST /api/payments/webhook  (public — Razorpay posts here)
//     Server-to-server push from Razorpay. Validated via X-Razorpay-Signature
//     (HMAC-SHA256 of the raw body with the webhook secret). Handles the
//     payment.captured / payment.failed events. Idempotent against /verify.
//
//   GET /api/payments/:id/status (authed)
//     Lightweight polling endpoint the SPA uses on /payments/result after
//     the modal closes, so the result page can confirm the row flipped to
//     'success' before showing the confirmation banner.

import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { payments, events, jobPostings } from "../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { bookingWriteLimiter } from "../middleware/rateLimit.js";
import {
  createOrder,
  verifyCheckoutSignature,
  verifyWebhookSignature,
  mapRazorpayStatus,
} from "../lib/razorpay/client.js";
import { razorpayConfig } from "../lib/razorpay/config.js";
import { confirmPaymentAndFulfil, markPaymentFailed } from "../lib/razorpay/confirm.js";

export const paymentsRouter = Router();

// ─── POST /api/payments/initiate ──────────────────────────────────────────
// Body: { payment_id }
//   The caller has already created the payment row (via /events/:slug/register
//   or any other paid-purpose entry point). This endpoint creates a Razorpay
//   Order and returns the payload the frontend hands to Checkout.js.
//
// Returns: { key_id, order_id, amount_paise, currency, prefill }
paymentsRouter.post("/initiate", bookingWriteLimiter, requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const payment_id = need(trim(req.body?.payment_id), "Payment ID");

    const [payment] = await db.select().from(payments).where(eq(payments.id, payment_id)).limit(1);
    if (!payment) throw new ApiError(404, "Payment not found");
    if (payment.payer_user_id !== req.user!.id) throw new ApiError(403, "Payment does not belong to this user");
    if (payment.status !== "created" && payment.status !== "pending") {
      throw new ApiError(400, `Payment is already in status '${payment.status}' — cannot re-initiate.`);
    }

    const metadata = (payment.metadata ?? {}) as Record<string, unknown>;
    const payerName  = String(metadata.payer_name  ?? req.user!.name  ?? "");
    const payerEmail = String(metadata.payer_email ?? req.user!.email ?? "");
    const payerPhone = String(metadata.payer_phone ?? "");

    let order;
    try {
      order = await createOrder({
        amountPaise: payment.amount_paise,
        receipt:     payment.id,     // row UUID as receipt — Razorpay accepts up to 40 chars
        notes: {
          payment_id: payment.id,
          purpose:    payment.purpose,
          ref_id:     payment.ref_id ?? "",
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ApiError(503, `Online payments are not configured yet (${msg}). Please contact the branch office.`);
    }

    await db.update(payments).set({
      razorpay_order_id: order.id,
      status: "pending",
      provider: "razorpay",
      updated_at: new Date(),
    }).where(eq(payments.id, payment.id));

    return res.json({
      key_id:       razorpayConfig().keyId,
      order_id:     order.id,
      amount_paise: payment.amount_paise,
      currency:     order.currency,
      prefill: {
        name:    payerName,
        email:   payerEmail,
        contact: payerPhone,
      },
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/payments/verify ────────────────────────────────────────────
// Browser handler fires this from inside the Razorpay Checkout success
// callback with the three fields Razorpay hands it. Verifies the HMAC
// signature server-side — if it doesn't match, the payload was tampered
// with and must be rejected. If it matches, we trust that Razorpay really
// did capture the payment and call confirmPaymentAndFulfil.
//
// Authed because only the payer should be able to trigger confirmation from
// the client. The webhook path (next endpoint) handles the unauth'd side.
paymentsRouter.post("/verify", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const razorpay_order_id   = need(trim(req.body?.razorpay_order_id), "razorpay_order_id");
    const razorpay_payment_id = need(trim(req.body?.razorpay_payment_id), "razorpay_payment_id");
    const razorpay_signature  = need(trim(req.body?.razorpay_signature), "razorpay_signature");

    const [payment] = await db.select().from(payments)
      .where(eq(payments.razorpay_order_id, razorpay_order_id))
      .limit(1);
    if (!payment) throw new ApiError(404, "Payment not found");
    if (payment.payer_user_id !== req.user!.id) {
      // Don't let a logged-in user confirm somebody else's order even if
      // they somehow learn the order id. Returning 404 instead of 403
      // avoids confirming the id exists for a non-owner.
      throw new ApiError(404, "Payment not found");
    }

    const valid = verifyCheckoutSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    if (!valid) {
      // Record the attempt so audit can see a failed signature verify.
      await db.update(payments).set({
        rejected_reason: "Invalid Razorpay signature on /verify",
        updated_at: new Date(),
      }).where(eq(payments.id, payment.id));
      throw new ApiError(400, "Invalid payment signature — not from Razorpay.");
    }

    // Persist the verified payment id + signature before confirmation. If
    // confirm throws we still have the Razorpay fields on the row for the
    // reconciliation cron or the admin reverify.
    await db.update(payments).set({
      razorpay_payment_id: razorpay_payment_id,
      razorpay_signature:  razorpay_signature,
      updated_at: new Date(),
    }).where(eq(payments.id, payment.id));

    // Idempotent short-circuit — if webhook arrived first and flipped the
    // row to success, don't do the work twice.
    if (payment.status === "success") {
      return res.json({ ok: true, alreadyConfirmed: true, payment_id: payment.id, status: "success" });
    }

    try {
      await confirmPaymentAndFulfil(payment.id);
    } catch (confirmErr) {
      // Money landed but we failed to create the registration/activate the
      // posting. Return pending so the SPA shows the pending screen and the
      // reconciliation cron (every 30 min) can retry. The webhook may also
      // arrive and retry via its own path.
      // eslint-disable-next-line no-console
      console.error("[razorpay] confirm failed on /verify:", confirmErr);
      try {
        const Sentry = await import("@sentry/node").catch(() => null);
        Sentry?.captureException?.(confirmErr, {
          tags: { source: "razorpay_verify_confirm" },
          extra: { payment_id: payment.id, order_id: razorpay_order_id },
        });
      } catch { /* Sentry optional */ }
      return res.json({ ok: true, alreadyConfirmed: false, payment_id: payment.id, status: "pending" });
    }

    return res.json({ ok: true, alreadyConfirmed: false, payment_id: payment.id, status: "success" });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/payments/webhook ───────────────────────────────────────────
// Razorpay's server-to-server push. Fires asynchronously of the browser
// handler. Must respond fast (Razorpay retries on timeout) and MUST be
// idempotent — the same push can be delivered twice.
//
// Authentication is the X-Razorpay-Signature header verified against the
// webhook secret (distinct from the API key secret — configured separately
// in the Razorpay dashboard).
//
// IMPORTANT: Razorpay signs the RAW request body. The urlencoded parser
// mounted on this router in index.ts doesn't give us the raw bytes, so
// this endpoint uses a JSON body parser with a `verify` callback that
// stashes the raw buffer on req.rawBody. The signature check runs
// against that buffer, not the parsed object.
paymentsRouter.post("/webhook", async (req: any, res, next) => {
  try {
    const signature = String(req.headers["x-razorpay-signature"] ?? "").trim();
    const rawBody = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(req.body ?? {});

    if (!signature || !verifyWebhookSignature(rawBody, signature)) {
      // Don't 5xx — Razorpay would retry. 400 tells it "this payload won't
      // ever succeed", so stop trying. Mismatched signatures are either a
      // spoof or a webhook-secret-mismatch on our side.
      return res.status(400).json({ error: "invalid signature" });
    }

    const payload = req.body ?? {};
    const eventType = String(payload?.event ?? "");
    const rpPayment = payload?.payload?.payment?.entity ?? null;
    const rpOrderId = rpPayment?.order_id ?? payload?.payload?.order?.entity?.id ?? null;

    if (!rpOrderId) {
      // Unhandled event shape — ack-and-ignore. Razorpay fires events we
      // don't care about (order.paid, refund.*, etc.); no retry storm.
      return res.json({ ok: true, note: `ignored event ${eventType}` });
    }

    const [payment] = await db.select().from(payments)
      .where(eq(payments.razorpay_order_id, rpOrderId))
      .limit(1);
    if (!payment) {
      // Push for an unknown order — Razorpay will retry if we 5xx, so
      // 200 to acknowledge-and-ignore (prevents retry storms on legit
      // orphans like a test fired against the wrong environment).
      return res.json({ ok: true, note: "unknown order" });
    }

    // Persist the latest payment id + metadata before any status change.
    const rpPaymentId = rpPayment?.id ?? payment.razorpay_payment_id ?? null;
    await db.update(payments).set({
      razorpay_payment_id: rpPaymentId,
      updated_at: new Date(),
    }).where(eq(payments.id, payment.id));

    if (eventType === "payment.captured" || eventType === "order.paid") {
      if (payment.status !== "success") {
        try {
          await confirmPaymentAndFulfil(payment.id);
        } catch (confirmErr) {
          // eslint-disable-next-line no-console
          console.error("[razorpay] confirm failed in webhook:", confirmErr);
        }
      }
      return res.json({ ok: true });
    }

    if (eventType === "payment.failed") {
      const reason = rpPayment?.error_description
        ?? rpPayment?.error_reason
        ?? `Razorpay webhook: payment.failed (${rpPayment?.error_code ?? "unknown"})`;
      await markPaymentFailed(payment.id, reason);
      return res.json({ ok: true });
    }

    // Other events (refund.*, order.*, etc.) — ack without action.
    return res.json({ ok: true, note: `no-op for ${eventType}` });
  } catch (err) {
    // Log but still return 200 — Razorpay retries on 5xx. If we have a
    // true bug we'd rather fix forward than DoS our own endpoint via
    // Razorpay's retry backoff.
    // eslint-disable-next-line no-console
    console.error("[razorpay] webhook handler error:", err);
    return res.json({ ok: true, note: "handler error — logged" });
  }
});

// ─── GET /api/payments/:id/status ─────────────────────────────────────────
// Lightweight status poller. SPA uses this on /payments/result so the
// success page can confirm the row flipped before showing the confirmation
// banner.
paymentsRouter.get("/:id/status", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Payment ID");
    // Scope to current user — otherwise any logged-in caller who learns a
    // payment id (easy: it's in the /payments/result URL after modal close)
    // could read someone else's transaction, including whether it
    // succeeded. Mirrors the ownership check in /initiate above. Returning
    // 404 (not 403) avoids confirming the id exists for a non-owner.
    const [p] = await db.select({
      id: payments.id,
      status: payments.status,
      amount_paise: payments.amount_paise,
      purpose: payments.purpose,
      ref_id: payments.ref_id,
      razorpay_order_id:   payments.razorpay_order_id,
      razorpay_payment_id: payments.razorpay_payment_id,
      rejected_reason: payments.rejected_reason,
      metadata: payments.metadata,
      updated_at: payments.updated_at,
    }).from(payments).where(and(
      eq(payments.id, id),
      eq(payments.payer_user_id, req.user!.id),
    )).limit(1);
    if (!p) throw new ApiError(404, "Payment not found");
    if (p.id !== id) throw new ApiError(404, "Payment not found");

    // For event payments, surface the event slug so the SPA can link back
    // ("Back to <event name>") without a second request.
    let event: { slug: string; title: string } | null = null;
    let posting: { id: string; title: string; status: string; type: string } | null = null;
    if (p.purpose === "event_registration" && p.ref_id) {
      const [e] = await db.select({ slug: events.slug, title: events.title })
        .from(events).where(and(eq(events.id, p.ref_id), isNull(events.deleted_at))).limit(1);
      if (e) event = e;
    } else if (p.purpose === "job_posting" && p.ref_id) {
      const [row] = await db.select({
        id: jobPostings.id, title: jobPostings.title,
        status: jobPostings.status, type: jobPostings.type,
      })
        .from(jobPostings)
        .where(and(eq(jobPostings.id, p.ref_id), isNull(jobPostings.deleted_at))).limit(1);
      if (row) posting = row;
    }

    res.json({ payment: p, event, posting });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/payments/cancelled ─────────────────────────────────────────
// Browser calls this when the user closes Razorpay's modal without paying
// (Checkout.js fires the `payment.failed` handler with reason `cancelled`,
// but there's no server-side signal). Flips the row to `failed` with a
// cancellation reason so the user can see it in /my-pending-payments and
// retry. Non-authoritative: if a real payment later arrives for the same
// order via webhook, markPaymentFailed's guard rejects the failure on an
// already-successful row.
paymentsRouter.post("/cancelled", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const payment_id = need(trim(req.body?.payment_id), "Payment ID");
    const [payment] = await db.select({ id: payments.id, payer_user_id: payments.payer_user_id, status: payments.status })
      .from(payments).where(eq(payments.id, payment_id)).limit(1);
    if (!payment) throw new ApiError(404, "Payment not found");
    if (payment.payer_user_id !== req.user!.id) throw new ApiError(404, "Payment not found");

    // Only cancel rows the user could plausibly cancel. Terminal states
    // are left alone — a stale cancel after a successful payment must not
    // downgrade the row.
    if (payment.status === "created" || payment.status === "pending") {
      await markPaymentFailed(payment.id, "User cancelled the payment modal");
    }
    return res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
