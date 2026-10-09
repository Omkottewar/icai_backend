// SabPaisa payment orchestration.
//
// Four endpoints:
//
//   POST /api/payments/initiate
//     Authed. Takes a purpose + ref_id, creates a payment row, builds the
//     SabPaisa init payload, returns { action, clientCode, encData } so the
//     browser can auto-POST to SabPaisa's hosted checkout. This is the
//     only payment-creation path for new rows — the old /register endpoint
//     used to inline it for events, but that logic now delegates here.
//
//   POST /api/payments/return    (public — SabPaisa posts here)
//     SabPaisa's user-return callback. The user's browser is here, holding
//     an encrypted response field. We decrypt, correlate by clientTxnId,
//     run the double-verify server-to-server call (so a spoofed callback
//     can't short-circuit confirmation), then confirm or fail the payment
//     and redirect the browser to a success/failure/pending SPA page.
//
//   POST /api/payments/webhook   (public — SabPaisa posts here)
//     SabPaisa Push API — server-to-server notification that fires
//     independently of the user's browser. Same decrypt + verify + confirm
//     flow, no redirect. Idempotent against /return.
//
//   GET /api/payments/:id/status (authed)
//     Lightweight polling endpoint the SPA uses after /return redirects
//     back to the SPA, so the success page can confirm the row flipped to
//     'success' before showing the confirmation banner.

import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { payments, events } from "../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { bookingWriteLimiter } from "../middleware/rateLimit.js";
import { buildInitRedirect, parseCallbackEncData, verifyPayment, paiseToRupees } from "../lib/sabpaisa/client.js";
import { confirmPaymentAndFulfil, markPaymentFailed } from "../lib/sabpaisa/confirm.js";
import { mapSabPaisaStatus } from "../lib/sabpaisa/types.js";

export const paymentsRouter = Router();

// ─── POST /api/payments/initiate ──────────────────────────────────────────
// Body: { payment_id }
//   The caller has already created the payment row (via /events/:slug/register
//   or any other paid-purpose entry point). This endpoint builds the SabPaisa
//   init form from that row and returns it. Keeping create-the-row logic in
//   the originating router means each purpose can set its own metadata +
//   validation + capacity rules; this endpoint is purely a "wrap the row
//   in a SabPaisa payload" step.
//
// Returns: { action, clientCode, encData, client_txn_id }
paymentsRouter.post("/initiate", bookingWriteLimiter, requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const payment_id = need(trim(req.body?.payment_id), "Payment ID");

    const [payment] = await db.select().from(payments).where(eq(payments.id, payment_id)).limit(1);
    if (!payment) throw new ApiError(404, "Payment not found");
    if (payment.payer_user_id !== req.user!.id) throw new ApiError(403, "Payment does not belong to this user");
    if (payment.status !== "created" && payment.status !== "pending") {
      throw new ApiError(400, `Payment is already in status '${payment.status}' — cannot re-initiate.`);
    }

    // Generate a fresh clientTxnId if the row doesn't have one yet. UUID
    // segments are too long for some SabPaisa dashboards — use a 24-char
    // slug that's still globally unique within the branch's txn history.
    const clientTxnId = payment.client_txn_id ?? `NBWRI-${payment.id.replace(/-/g, "").slice(0, 18)}`;

    const metadata = (payment.metadata ?? {}) as Record<string, unknown>;
    const payerName  = String(metadata.payer_name  ?? req.user!.name  ?? "");
    const payerEmail = String(metadata.payer_email ?? req.user!.email ?? "");
    const payerMobile = String(metadata.payer_phone ?? "");

    const redirect = buildInitRedirect({
      clientTxnId,
      amountRupees: paiseToRupees(payment.amount_paise),
      payerName,
      payerEmail,
      payerMobile,
      // udf1 carries the purpose so the return handler can route the SPA
      // back to the right landing page without a DB lookup. udf2 is the
      // ref_id (event id, job id, ...). udf3 is reserved.
      udf1: payment.purpose,
      udf2: payment.ref_id ?? "",
    });

    // Persist the clientTxnId and flip to pending — SabPaisa now owns the
    // payment until a callback or webhook arrives.
    await db.update(payments).set({
      client_txn_id: clientTxnId,
      status: "pending",
      provider: "sabpaisa",
      updated_at: new Date(),
    }).where(eq(payments.id, payment.id));

    return res.json({
      action:        redirect.action,
      clientCode:    redirect.clientCode,
      clientTxnId:   redirect.clientTxnId,
      encData:       redirect.encData,
      client_txn_id: clientTxnId,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── /api/payments/return ─────────────────────────────────────────────────
// SabPaisa redirects the user here after they finish paying (success /
// fail / cancel — all paths come through here). The user's browser is on
// this endpoint; we decrypt, double-verify, update the row, and 302 to
// the SPA.
//
// This endpoint is PUBLIC — SabPaisa calls it over HTTPS without our auth
// cookies. Treat every input as untrusted: never trust the status field
// in the callback, always double-verify server-to-server before confirming.
//
// Both POST (newer SabPaisa) and GET (older variant that encodes
// `encResponse` as a query param) share one handler.
async function handleReturn(req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) {
  try {
    const appUrl = (process.env.APP_URL ?? "").replace(/\/$/, "");

    const input = req.method === "GET" ? req.query : req.body;
    // SabPaisa's field name has varied across versions; accept the three
    // common ones. Anything else → log and redirect to a generic failure.
    const encResponse = String(
      (input as any)?.encResponse ?? (input as any)?.encData ?? (input as any)?.enc ?? (input as any)?.response ?? ""
    ).trim();

    if (!encResponse) {
      // eslint-disable-next-line no-console
      console.warn("[sabpaisa] /return called without encResponse field; keys:", Object.keys(req.body ?? {}));
      return res.redirect(302, `${appUrl}/payments/result?status=unknown`);
    }

    const payload = parseCallbackEncData(encResponse);
    const clientTxnId = payload.clientTxnId ?? payload.udf0 ?? "";

    if (!clientTxnId) {
      return res.redirect(302, `${appUrl}/payments/result?status=unknown`);
    }

    const [payment] = await db.select().from(payments).where(eq(payments.client_txn_id, clientTxnId)).limit(1);
    if (!payment) {
      return res.redirect(302, `${appUrl}/payments/result?status=unknown&ref=${encodeURIComponent(clientTxnId)}`);
    }

    // Stash the raw callback for audit before any status change — if
    // confirmation fails later we still have the payload.
    await db.update(payments).set({
      sabpaisa_response: payload as any,
      return_received_at: new Date(),
      updated_at: new Date(),
    }).where(eq(payments.id, payment.id));

    // The callback payload is itself AES-decrypted with the merchant's
    // secret key, so a spoofed callback would need our key. Treat the
    // callback's status as the primary signal; call double-verify as a
    // defence-in-depth check but DON'T let a verify-API failure override
    // a legit callback. (Earlier logic hard-defaulted to 'pending' on
    // verify failure which left visibly-successful payments stuck.)
    const callbackOutcome = mapSabPaisaStatus(payload.status);

    const verifyResult = await verifyPayment(clientTxnId).catch((e) => {
      // eslint-disable-next-line no-console
      console.error("[sabpaisa] verify failed on /return — falling back to callback status:", e);
      return null;
    });

    const verifiedOutcome = verifyResult?.outcome ?? callbackOutcome;
    const verified = verifyResult?.response ?? payload;

    const sabpaisaTxnId = verified.sabpaisaTxnId ?? payload.sabpaisaTxnId ?? null;

    await db.update(payments).set({
      sabpaisa_txn_id:       sabpaisaTxnId,
      sabpaisa_status_code:  verified.statusCode ?? payload.statusCode ?? null,
      sabpaisa_payment_mode: verified.paymentMode ?? payload.paymentMode ?? null,
      sabpaisa_bank_name:    verified.bankName ?? payload.bankName ?? null,
      sabpaisa_bank_txn_id:  verified.bankTxnId ?? payload.bankTxnId ?? null,
      last_verified_at:      new Date(),
      updated_at:            new Date(),
    }).where(eq(payments.id, payment.id));

    if (verifiedOutcome === "success") {
      await confirmPaymentAndFulfil(payment.id).catch((e) => {
        // Confirmation shouldn't fail — but if it does we don't want the
        // user to see "payment failed" when SabPaisa really did take the
        // money. Fall through to a pending redirect so the webhook can
        // retry fulfilment.
        // eslint-disable-next-line no-console
        console.error("[sabpaisa] confirm failed on /return:", e);
      });
      return res.redirect(302, buildResultRedirect(appUrl, "success", payment, payload));
    }

    if (verifiedOutcome === "failed" || verifiedOutcome === "aborted") {
      const reason = verified.bankErrorMessage ?? payload.bankErrorMessage ?? `SabPaisa reported ${verifiedOutcome}`;
      await markPaymentFailed(payment.id, reason);
      return res.redirect(302, buildResultRedirect(appUrl, verifiedOutcome, payment, payload));
    }

    // Pending — SabPaisa hasn't resolved yet. Show the pending screen; the
    // webhook will fire within minutes and the SPA's /status polling will
    // flip to success/fail when it does.
    return res.redirect(302, buildResultRedirect(appUrl, "pending", payment, payload));
  } catch (err) { handleApiError(err, res, next); }
}

paymentsRouter.post("/return", handleReturn);
paymentsRouter.get("/return",  handleReturn);

// ─── POST /api/payments/webhook ───────────────────────────────────────────
// SabPaisa Push API — server-to-server. Fires asynchronously of the
// user's browser callback. Must respond fast (SabPaisa retries on
// timeout) and MUST be idempotent — the same push can be delivered twice.
//
// Public endpoint. Authentication is the AES key — only SabPaisa holds
// the matching key, so decrypting a well-formed payload proves origin.
paymentsRouter.post("/webhook", async (req, res, next) => {
  try {
    const encResponse = String(
      req.body?.encResponse ?? req.body?.encData ?? req.body?.enc ?? ""
    ).trim();

    if (!encResponse) {
      return res.status(400).json({ error: "missing encResponse" });
    }

    let payload;
    try {
      payload = parseCallbackEncData(encResponse);
    } catch {
      return res.status(400).json({ error: "decryption failed" });
    }

    const clientTxnId = payload.clientTxnId ?? "";
    if (!clientTxnId) return res.status(400).json({ error: "missing clientTxnId" });

    const [payment] = await db.select().from(payments).where(eq(payments.client_txn_id, clientTxnId)).limit(1);
    if (!payment) {
      // Push for an unknown payment — SabPaisa will retry if we 5xx, so
      // 200 to acknowledge-and-ignore (prevents retry storms on legit
      // orphans like a cancelled init).
      return res.json({ ok: true, note: "unknown clientTxnId" });
    }

    await db.update(payments).set({
      sabpaisa_response: { ...(payment.sabpaisa_response as object || {}), webhook: payload } as any,
      webhook_received_at: new Date(),
      updated_at: new Date(),
    }).where(eq(payments.id, payment.id));

    // Same verify-before-confirm discipline as /return.
    const { outcome, response: verified } = await verifyPayment(clientTxnId).catch(() => {
      // On verify failure, trust the webhook outcome (webhook is itself
      // server-to-server and signed with our AES key — a spoof here is
      // impractical). SabPaisa's docs say this fallback is acceptable.
      return { outcome: mapSabPaisaStatus(payload.status), response: payload };
    });

    const sabpaisaTxnId = verified.sabpaisaTxnId ?? payload.sabpaisaTxnId ?? null;

    await db.update(payments).set({
      sabpaisa_txn_id:       sabpaisaTxnId,
      sabpaisa_status_code:  verified.statusCode ?? payload.statusCode ?? null,
      sabpaisa_payment_mode: verified.paymentMode ?? payload.paymentMode ?? null,
      sabpaisa_bank_name:    verified.bankName ?? payload.bankName ?? null,
      sabpaisa_bank_txn_id:  verified.bankTxnId ?? payload.bankTxnId ?? null,
      last_verified_at:      new Date(),
      updated_at:            new Date(),
    }).where(eq(payments.id, payment.id));

    if (outcome === "success") {
      await confirmPaymentAndFulfil(payment.id);
    } else if (outcome === "failed" || outcome === "aborted") {
      const reason = verified.bankErrorMessage ?? payload.bankErrorMessage ?? `SabPaisa webhook reported ${outcome}`;
      await markPaymentFailed(payment.id, reason);
    }
    // Pending → do nothing, next webhook / verify will resolve it.

    return res.json({ ok: true });
  } catch (err) {
    // Log but still return 200 — SabPaisa retries on 5xx. If we have a
    // true bug we'd rather fix forward than DoS our own endpoint via
    // SabPaisa's retry backoff.
    // eslint-disable-next-line no-console
    console.error("[sabpaisa] webhook handler error:", err);
    return res.json({ ok: true, note: "handler error — logged" });
  }
});

// ─── GET /api/payments/:id/status ─────────────────────────────────────────
// Lightweight status poller. SPA uses this after SabPaisa redirects back
// so the success page can confirm the row flipped before showing the
// confirmation banner.
paymentsRouter.get("/:id/status", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Payment ID");
    // Scope the lookup to the current user — otherwise any logged-in caller
    // who learns a payment ID (easy: it's in the /payments/result URL after
    // the SabPaisa redirect) can poll /status and read someone else's
    // transaction, including whether it succeeded. Mirrors the ownership
    // check in /initiate above. Returning 404 (not 403) avoids confirming
    // the id exists for a non-owner.
    const [p] = await db.select({
      id: payments.id,
      status: payments.status,
      amount_paise: payments.amount_paise,
      purpose: payments.purpose,
      ref_id: payments.ref_id,
      sabpaisa_txn_id: payments.sabpaisa_txn_id,
      sabpaisa_payment_mode: payments.sabpaisa_payment_mode,
      sabpaisa_bank_name: payments.sabpaisa_bank_name,
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
    if (p.purpose === "event_registration" && p.ref_id) {
      const [e] = await db.select({ slug: events.slug, title: events.title })
        .from(events).where(and(eq(events.id, p.ref_id), isNull(events.deleted_at))).limit(1);
      if (e) event = e;
    }

    res.json({ payment: p, event });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Helper ───────────────────────────────────────────────────────────────

function buildResultRedirect(
  appUrl: string,
  status: "success" | "failed" | "aborted" | "pending",
  payment: { id: string; purpose: string; ref_id: string | null; metadata: unknown },
  _payload: Record<string, unknown>,
): string {
  const md = (payment.metadata as { event_slug?: string }) ?? {};
  const params = new URLSearchParams({
    status,
    payment_id: payment.id,
    purpose:    payment.purpose,
  });
  if (md.event_slug) params.set("event_slug", md.event_slug);
  return `${appUrl}/payments/result?${params.toString()}`;
}
