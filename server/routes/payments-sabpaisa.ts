// SabPaisa routes, per https://developer.sabpaisa.in
//
//   POST /api/payments/sabpaisa/initiate     (authed)
//     Builds encData for an existing payment row; the browser POSTs
//     { encData, clientCode } to SabPaisa's init URL.
//
//   POST|GET /api/payments/sabpaisa/return   (public — the callbackUrl)
//     SabPaisa sends `encResponse`. Decrypt (HMAC-verified), update the row,
//     confirm/fail, then 302 the browser to /payments/result.
//
//   POST /api/payments/sabpaisa/webhook      (public)
//     Same `encResponse` handling for a server-to-server push, if SabPaisa
//     enables one for the merchant. Always 200 so it doesn't retry-storm.
//
//   GET /api/payments/sabpaisa/:id/status    → /api/payments/:id/status

import { Router, urlencoded, type Request } from "express";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { payments } from "../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { bookingWriteLimiter } from "../middleware/rateLimit.js";
import {
  buildInitRedirect,
  parseEncResponse,
  enquireTransaction,
  amountMatches,
  paiseToRupees,
} from "../lib/sabpaisa/client.js";
import { sabpaisaConfig } from "../lib/sabpaisa/config.js";
import { mapSabPaisaStatus, describeSabPaisa, type SabPaisaResponse } from "../lib/sabpaisa/types.js";
import { confirmPaymentAndFulfil, markPaymentFailed } from "../lib/payments/confirm.js";
import { signPaymentViewToken } from "../lib/memberGuest.js";

export const sabpaisaPaymentsRouter = Router();

const formParser = urlencoded({ extended: false, limit: "100kb" });

// ─── POST /initiate ───────────────────────────────────────────────────────
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
    let built;
    try {
      built = buildInitRedirect({
        payment_id:   payment.id,
        amountRupees: paiseToRupees(payment.amount_paise),
        payerName:    String(metadata.payer_name  ?? req.user!.name  ?? ""),
        payerEmail:   String(metadata.payer_email ?? req.user!.email ?? ""),
        payerPhone:   String(metadata.payer_phone ?? ""),
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

    return res.json({
      action:       built.redirect.action,
      clientCode:   built.redirect.clientCode,
      encData:      built.redirect.encData,
      amount_paise: payment.amount_paise,
      currency:     "INR",
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Shared callback handling ─────────────────────────────────────────────
type CallbackResult = { status: "success" | "failed" | "pending"; paymentId: string | null; note?: string };

function readEncResponse(req: Request): string {
  // SabPaisa names the field `encResponse`; older kits used `encData`.
  const body  = (req.body ?? {}) as Record<string, unknown>;
  const query = (req.query ?? {}) as Record<string, unknown>;
  return String(body.encResponse ?? body.encData ?? query.encResponse ?? query.encData ?? "").trim();
}

async function handleSabPaisaResponse(encResponse: string, source: "return" | "webhook"): Promise<CallbackResult> {
  if (!encResponse) return { status: "failed", paymentId: null, note: "no_payload" };

  const parsed = parseEncResponse(encResponse);
  if (!parsed) return { status: "failed", paymentId: null, note: "bad_payload" };

  if (parsed.clientCode && parsed.clientCode !== sabpaisaConfig().clientCode) {
    return { status: "failed", paymentId: null, note: "wrong_client" };
  }

  const clientTxnId = String(parsed.clientTxnId ?? "").trim();
  const udfPaymentId = String(parsed.udf1 ?? "").trim();

  let payment: typeof payments.$inferSelect | undefined;
  if (clientTxnId) {
    [payment] = await db.select().from(payments).where(eq(payments.client_txn_id, clientTxnId)).limit(1);
  }
  if (!payment && /^[0-9a-f-]{36}$/i.test(udfPaymentId)) {
    [payment] = await db.select().from(payments).where(eq(payments.id, udfPaymentId)).limit(1);
  }
  if (!payment) return { status: "failed", paymentId: null, note: "unknown_payment" };

  // A result for an older attempt on this row (user retried). A success
  // still means money was taken, so honour it; anything else is ignored.
  const isCurrentAttempt = !payment.client_txn_id || payment.client_txn_id === clientTxnId;

  let response: SabPaisaResponse = parsed;
  let outcome = mapSabPaisaStatus(parsed.statusCode, parsed.status);

  // Docs: 0999 (unknown) → confirm with Transaction Enquiry.
  if (outcome === "unknown" && clientTxnId) {
    try {
      const enq = await enquireTransaction(clientTxnId);
      if (enq.response) { response = { ...parsed, ...enq.response }; outcome = enq.outcome; }
    } catch (e) {
      console.error("[sabpaisa] enquiry after unknown status failed:", e);
    }
  }

  await db.update(payments).set({
    sabpaisa_txn_id:       response.sabpaisaTxnId || payment.sabpaisa_txn_id,
    sabpaisa_status_code:  response.statusCode    || payment.sabpaisa_status_code,
    sabpaisa_payment_mode: response.paymentMode   || payment.sabpaisa_payment_mode,
    sabpaisa_bank_name:    response.bankName      || payment.sabpaisa_bank_name,
    sabpaisa_bank_txn_id:  response.bankTxnId     || payment.sabpaisa_bank_txn_id,
    sabpaisa_response:     response as any,
    ...(source === "return" ? { return_received_at: new Date() } : { webhook_received_at: new Date() }),
    updated_at:            new Date(),
  }).where(eq(payments.id, payment.id));

  if (payment.status === "success") return { status: "success", paymentId: payment.id };

  if (outcome === "success") {
    if (!amountMatches(response, payment.amount_paise)) {
      console.error(`[sabpaisa] amount mismatch on ${payment.id}: expected ${payment.amount_paise} paise, got amount=${response.amount} paidAmount=${response.paidAmount}`);
      return { status: "pending", paymentId: payment.id, note: "amount_mismatch" };
    }
    try {
      await confirmPaymentAndFulfil(payment.id);
    } catch (confirmErr) {
      console.error(`[sabpaisa] confirm failed on /${source}:`, confirmErr);
      return { status: "pending", paymentId: payment.id };
    }
    return { status: "success", paymentId: payment.id };
  }

  if ((outcome === "failed" || outcome === "aborted") && isCurrentAttempt) {
    const reason = describeSabPaisa(response) || `SabPaisa ${outcome} (${response.statusCode ?? "?"})`;
    await markPaymentFailed(payment.id, reason);
    return { status: "failed", paymentId: payment.id };
  }

  // 0100 initiated, 0400 challan generated, 404, still-unknown → pending;
  // the reconciliation cron resolves it via Transaction Enquiry.
  return { status: "pending", paymentId: payment.id };
}

// ─── /return (callbackUrl) ────────────────────────────────────────────────
async function returnHandler(req: Request, res: import("express").Response) {
  const appUrl = (process.env.APP_URL ?? "").replace(/\/$/, "");
  const go = (r: CallbackResult) => {
    const qs = new URLSearchParams({ status: r.status });
    if (r.paymentId) {
      qs.set("payment_id", r.paymentId);
      // Lets members who paid without logging in open the result page.
      qs.set("t", signPaymentViewToken(r.paymentId));
    }
    if (r.note) qs.set("note", r.note);
    return res.redirect(302, `${appUrl}/payments/result?${qs.toString()}`);
  };
  try {
    return go(await handleSabPaisaResponse(readEncResponse(req), "return"));
  } catch (err) {
    console.error("[sabpaisa] /return handler error:", err);
    return go({ status: "failed", paymentId: null, note: "handler_error" });
  }
}
sabpaisaPaymentsRouter.post("/return", formParser, returnHandler);
sabpaisaPaymentsRouter.get("/return", returnHandler);

// ─── /webhook ─────────────────────────────────────────────────────────────
sabpaisaPaymentsRouter.post("/webhook", formParser, async (req, res) => {
  try {
    const r = await handleSabPaisaResponse(readEncResponse(req), "webhook");
    if (r.note === "bad_payload") return res.status(400).json({ error: "invalid payload" });
    return res.json({ ok: true, status: r.status, note: r.note });
  } catch (err) {
    console.error("[sabpaisa] webhook handler error:", err);
    return res.json({ ok: true, note: "handler error — logged" });
  }
});

// ─── GET /:id/status ──────────────────────────────────────────────────────
sabpaisaPaymentsRouter.get("/:id/status", requireUser, (req: AuthedRequest, res) => {
  return res.redirect(307, `/api/payments/${encodeURIComponent(String(req.params.id))}/status`);
});
