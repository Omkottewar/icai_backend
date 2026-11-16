// Payment endpoints shared by every paid surface (SabPaisa is the only gateway).
//
//   POST /api/payments/initiate   (authed)
//     Re-opens SabPaisa checkout for an existing created/pending payment row
//     with a fresh clientTxnId. Returns { provider, action, clientCode,
//     encData } for the browser to POST to SabPaisa.
//
//   GET  /api/payments/:id/status (authed) — status poller for /payments/result
//   POST /api/payments/cancelled  (authed) — user backed out before paying
//
// The SabPaisa callback lives in routes/payments-sabpaisa.ts.

import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { payments, events, jobPostings } from "../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { bookingWriteLimiter } from "../middleware/rateLimit.js";
import { confirmPaymentAndFulfil, markPaymentFailed } from "../lib/payments/confirm.js";
import { buildInitRedirect as buildSabpaisaInit, paiseToRupees as spPaiseToRupees } from "../lib/sabpaisa/client.js";

export const paymentsRouter = Router();

// ─── POST /api/payments/initiate ──────────────────────────────────────────
// Body: { payment_id } — retry checkout for an existing row.
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

    {
      let built;
      try {
        built = buildSabpaisaInit({
          payment_id:   payment.id,
          amountRupees: spPaiseToRupees(payment.amount_paise),
          payerName,
          payerEmail,
          payerPhone,
          notes: {
            purpose: payment.purpose,
            ref_id:  payment.ref_id ?? "",
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
        payment_id:   payment.id,
        provider:     "sabpaisa",
        amount_paise: payment.amount_paise,
        sabpaisa: {
          action:       built.redirect.action,
          clientCode:   built.redirect.clientCode,
          encData:      built.redirect.encData,
          amount_paise: payment.amount_paise,
          currency:     "INR",
        },
      });
    }

  } catch (err) { handleApiError(err, res, next); }
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
      provider: payments.provider,
      client_txn_id:       payments.client_txn_id,
      sabpaisa_txn_id:     payments.sabpaisa_txn_id,
      sabpaisa_payment_mode: payments.sabpaisa_payment_mode,
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
// The user backed out before paying. Flips a created/pending row to failed
// so it can be retried; markPaymentFailed never downgrades a success.
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
      await markPaymentFailed(payment.id, "User cancelled the payment");
    }
    return res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
