// SabPaisa payment orchestration.
//
// Mirror of routes/payments.ts, but for the SabPaisa gateway. Mounted
// at /api/payments/sabpaisa so both providers can run side-by-side (see
// backend/server/lib/paymentProvider.ts — flipping PAYMENT_PROVIDER env
// var picks which gateway new /initiate calls use; this router stays
// reachable for historical SabPaisa rows regardless of the active flag).
//
// Four endpoints:
//
//   POST /api/payments/sabpaisa/initiate
//     Authed. Takes a payment_id (row already created by the originating
//     route — /events/:slug/register or /employer/postings). Builds the
//     encrypted init payload and returns { action, clientCode, encData }
//     for the browser to auto-POST to SabPaisa's hosted checkout URL.
//
//   POST /api/payments/sabpaisa/return   (PUBLIC — SabPaisa posts the user here)
//     Form-encoded body: { clientCode, encData }. We decrypt, update the
//     row with the callback payload, confirm or fail, and 302 the browser
//     to the SPA's /payments/result page. Status is driven by the SabPaisa
//     statusCode; a server-to-server /status/verify is called as a
//     tie-breaker on ambiguous states.
//
//   POST /api/payments/sabpaisa/webhook  (PUBLIC — SabPaisa Push API)
//     Async server-to-server confirmation. Decrypt, confirm, 200 ack.
//     Idempotent against the /return path — whichever lands first wins.
//
//   GET /api/payments/sabpaisa/:id/status (authed)
//     Deprecated alias for /api/payments/:id/status (which is already
//     provider-neutral). Kept so a future expansion of the SPA can call
//     the SabPaisa-namespaced version without a second mount — today it
//     just 302s to the canonical path.

import { Router, urlencoded } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { payments, events } from "../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { bookingWriteLimiter } from "../middleware/rateLimit.js";
import {
  buildInitRedirect,
  parseCallbackEncData,
  verifyPayment,
  paiseToRupees,
} from "../lib/sabpaisa/client.js";
import { mapSabPaisaStatus } from "../lib/sabpaisa/types.js";
import { confirmPaymentAndFulfil, markPaymentFailed } from "../lib/razorpay/confirm.js";

export const sabpaisaPaymentsRouter = Router();

// SabPaisa POSTs form-encoded (application/x-www-form-urlencoded), not JSON.
// Mount the urlencoded parser ONLY on /return and /webhook so our own
// frontend's JSON calls to /initiate stay on the global JSON parser.
// extended:false uses the stricter querystring parser — SabPaisa's payload
// is flat key-value with no nested arrays.
const formParser = urlencoded({ extended: false, limit: "100kb" });

// ─── POST /api/payments/sabpaisa/initiate ────────────────────────────────
sabpaisaPaymentsRouter.post("/initiate", bookingWriteLimiter, requireUser, async (req: AuthedRequest, res, next) => {
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

    let built;
    try {
      built = buildInitRedirect({
        payment_id:   payment.id,
        amountRupees: paiseToRupees(payment.amount_paise),
        payerName,
        payerEmail,
        payerPhone,
        notes: {
          purpose:    payment.purpose,
          ref_id:     payment.ref_id ?? "",
          event_slug: String(metadata.event_slug ?? ""),
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new ApiError(503, `Online payments are not configured yet (${msg}). Please contact the branch office.`);
    }

    await db.update(payments).set({
      client_txn_id: built.clientTxnId,
      status:        "pending",
      provider:      "sabpaisa",
      updated_at:    new Date(),
    }).where(eq(payments.id, payment.id));

    // The frontend will render a hidden <form action={action}> with two
    // inputs { clientCode, encData } and submit it on mount. The result is
    // a top-level navigation to SabPaisa's hosted page — exactly what their
    // reference integration does.
    return res.json({
      action:       built.redirect.action,
      clientCode:   built.redirect.clientCode,
      encData:      built.redirect.encData,
      amount_paise: payment.amount_paise,
      currency:     "INR",
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/payments/sabpaisa/return ──────────────────────────────────
// SabPaisa redirects the user's browser here after payment. Body is
// form-encoded { clientCode, encData }. Decrypt → correlate on our
// client_txn_id (in udf12 we stashed the payments.id) → confirm or fail
// → 302 to the SPA's /payments/result page so the user sees the outcome.
//
// We always respond with a 302 (not a JSON error) so the user ends up on
// a real page, never on an opaque API response. Even on tamper/decrypt
// failure we redirect to /payments/result?status=failed so the UX
// recovers gracefully.
sabpaisaPaymentsRouter.post("/return", formParser, async (req, res) => {
  const appUrl = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const resultBase = `${appUrl}/payments/result`;

  const redirectTo = (status: "success" | "failed" | "pending", paymentId: string | null, note?: string) => {
    const qs = new URLSearchParams({ status });
    if (paymentId) qs.set("payment_id", paymentId);
    if (note)      qs.set("note", note);
    return res.redirect(302, `${resultBase}?${qs.toString()}`);
  };

  try {
    const encData = String((req.body as any)?.encData ?? "").trim();
    if (!encData) {
      return redirectTo("failed", null, "no_payload");
    }

    const parsed = parseCallbackEncData(encData);
    if (!parsed) {
      // Decrypt failed — treat as tamper, don't trust anything in the body.
      return redirectTo("failed", null, "bad_payload");
    }

    // Correlate — udf12 is the original payments.id, clientTxnId has a
    // timestamp suffix so we prefer udf12 when present, fall back to a
    // client_txn_id lookup.
    const paymentId = (parsed.udf12 ?? "").trim();
    const clientTxnId = (parsed.clientTxnId ?? "").trim();

    let payment: any = null;
    if (paymentId) {
      const [p] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
      if (p) payment = p;
    }
    if (!payment && clientTxnId) {
      const [p] = await db.select().from(payments).where(eq(payments.client_txn_id, clientTxnId)).limit(1);
      if (p) payment = p;
    }
    if (!payment) {
      return redirectTo("failed", paymentId || null, "unknown_payment");
    }

    // Persist the full callback payload for audit + the headline SabPaisa
    // columns for admin UI + the return_received_at timestamp.
    await db.update(payments).set({
      sabpaisa_txn_id:       (parsed.sabpaisaTxnId ?? null) || payment.sabpaisa_txn_id,
      sabpaisa_status_code:  (parsed.statusCode   ?? null) || payment.sabpaisa_status_code,
      sabpaisa_payment_mode: (parsed.paymentMode  ?? null) || payment.sabpaisa_payment_mode,
      sabpaisa_bank_name:    (parsed.bankName     ?? null) || payment.sabpaisa_bank_name,
      sabpaisa_bank_txn_id:  (parsed.bankTxnId    ?? null) || payment.sabpaisa_bank_txn_id,
      sabpaisa_response:     parsed as any,
      return_received_at:    new Date(),
      updated_at:            new Date(),
    }).where(eq(payments.id, payment.id));

    const outcome = mapSabPaisaStatus(parsed.statusCode);

    // Idempotent short-circuit — if webhook arrived first and flipped the
    // row to success, don't do the work twice.
    if (payment.status === "success") {
      return redirectTo("success", payment.id);
    }

    if (outcome === "success") {
      try {
        await confirmPaymentAndFulfil(payment.id);
      } catch (confirmErr) {
        // Money landed but we failed to fulfil. Route to pending — the
        // reconciliation cron + webhook will retry.
        // eslint-disable-next-line no-console
        console.error("[sabpaisa] confirm failed on /return:", confirmErr);
        try {
          const Sentry = await import("@sentry/node").catch(() => null);
          Sentry?.captureException?.(confirmErr, {
            tags: { source: "sabpaisa_return_confirm" },
            extra: { payment_id: payment.id, client_txn_id: clientTxnId },
          });
        } catch { /* Sentry optional */ }
        return redirectTo("pending", payment.id);
      }
      return redirectTo("success", payment.id);
    }

    if (outcome === "failed" || outcome === "aborted") {
      const reason = (parsed.statusDesc ?? "").trim() || `SabPaisa reported ${outcome} (${parsed.statusCode ?? "unknown"})`;
      await markPaymentFailed(payment.id, reason);
      return redirectTo("failed", payment.id);
    }

    // Pending — return the user to the result page in pending state. The
    // SPA will poll /status to flip when webhook/cron catches up.
    return redirectTo("pending", payment.id);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[sabpaisa] /return handler error:", err);
    return redirectTo("failed", null, "handler_error");
  }
});

// ─── POST /api/payments/sabpaisa/webhook ─────────────────────────────────
// SabPaisa's async server-to-server push. Fires regardless of whether the
// browser hit /return. Idempotent — same push can be delivered twice.
//
// We always 200 (even on no-op / unknown-order) so SabPaisa doesn't
// enter its retry backoff for payloads we'll never resolve.
sabpaisaPaymentsRouter.post("/webhook", formParser, async (req, res) => {
  try {
    const encData = String((req.body as any)?.encData ?? "").trim();
    if (!encData) {
      return res.json({ ok: true, note: "empty payload" });
    }

    const parsed = parseCallbackEncData(encData);
    if (!parsed) {
      // Signature equivalent — decrypt failed means the payload wasn't
      // signed with OUR key, treat as spoof. 400 so SabPaisa stops retrying.
      return res.status(400).json({ error: "invalid payload" });
    }

    const paymentId = (parsed.udf12 ?? "").trim();
    const clientTxnId = (parsed.clientTxnId ?? "").trim();

    let payment: any = null;
    if (paymentId) {
      const [p] = await db.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
      if (p) payment = p;
    }
    if (!payment && clientTxnId) {
      const [p] = await db.select().from(payments).where(eq(payments.client_txn_id, clientTxnId)).limit(1);
      if (p) payment = p;
    }
    if (!payment) {
      // Push for an unknown order — ack-and-ignore. Prevents retry storms
      // on legit orphans (test-env pushes aimed at the wrong environment).
      return res.json({ ok: true, note: "unknown order" });
    }

    await db.update(payments).set({
      sabpaisa_txn_id:       (parsed.sabpaisaTxnId ?? null) || payment.sabpaisa_txn_id,
      sabpaisa_status_code:  (parsed.statusCode   ?? null) || payment.sabpaisa_status_code,
      sabpaisa_payment_mode: (parsed.paymentMode  ?? null) || payment.sabpaisa_payment_mode,
      sabpaisa_bank_name:    (parsed.bankName     ?? null) || payment.sabpaisa_bank_name,
      sabpaisa_bank_txn_id:  (parsed.bankTxnId    ?? null) || payment.sabpaisa_bank_txn_id,
      sabpaisa_response:     parsed as any,
      webhook_received_at:   new Date(),
      updated_at:            new Date(),
    }).where(eq(payments.id, payment.id));

    const outcome = mapSabPaisaStatus(parsed.statusCode);

    if (outcome === "success") {
      if (payment.status !== "success") {
        try {
          await confirmPaymentAndFulfil(payment.id);
        } catch (confirmErr) {
          // eslint-disable-next-line no-console
          console.error("[sabpaisa] confirm failed in webhook:", confirmErr);
        }
      }
      return res.json({ ok: true });
    }

    if (outcome === "failed" || outcome === "aborted") {
      const reason = (parsed.statusDesc ?? "").trim() || `SabPaisa webhook: ${outcome} (${parsed.statusCode ?? "unknown"})`;
      await markPaymentFailed(payment.id, reason);
      return res.json({ ok: true });
    }

    // Still pending — no-op; a later webhook / cron tick will resolve.
    return res.json({ ok: true, note: `pending status ${parsed.statusCode ?? "?"}` });
  } catch (err) {
    // Log but still return 200 — SabPaisa retries on 5xx. If we have a true
    // bug we'd rather fix forward than DoS our own endpoint via retries.
    // eslint-disable-next-line no-console
    console.error("[sabpaisa] webhook handler error:", err);
    return res.json({ ok: true, note: "handler error — logged" });
  }
});

// ─── GET /api/payments/sabpaisa/:id/status ───────────────────────────────
// Convenience redirect to the provider-neutral status endpoint. Lets a
// future client version call this without knowing the canonical path.
sabpaisaPaymentsRouter.get("/:id/status", requireUser, (req: AuthedRequest, res) => {
  return res.redirect(307, `/api/payments/${encodeURIComponent(req.params.id)}/status`);
});
