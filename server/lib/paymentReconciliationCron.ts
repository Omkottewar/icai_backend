// Reconciliation cron for stuck payment rows (Razorpay OR SabPaisa).
//
// Both the browser handler (Razorpay /verify, SabPaisa /return) and the
// server-to-server webhook can resolve a payment. If both fail — user
// closes tab before the verify call lands AND the gateway's webhook
// retries get dropped (network partition, our server down past the
// retry budget) — the row stays `pending` forever. User's money went
// through on the gateway; our DB thinks it never resolved; no
// registration created.
//
// This cron catches those rows: every 30 min it picks payments stuck in
// `pending` for more than 1 hour, polls the ORIGINAL provider's enquiry
// API (chosen per row via payments.provider — Razorpay for 'razorpay'
// rows, SabPaisa for 'sabpaisa' rows), and routes the outcome through
// the existing confirm / fail helpers. Both target functions are
// idempotent, so a late webhook arriving after reconciliation already
// fixed the row is harmless.
//
// Same tick-based pattern as jobAlertsCron.ts and escalations.ts so ops
// don't juggle multiple cron systems.

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { payments } from "../../schema/index.js";
import { verifyOrderOutcome } from "./razorpay/client.js";
import { verifyPayment as verifySabpaisaPayment } from "./sabpaisa/client.js";
import { confirmPaymentAndFulfil, markPaymentFailed } from "./razorpay/confirm.js";

const TICK_MS = 30 * 60 * 1000;              // every 30 minutes
const STALE_AFTER_MINUTES = 60;              // only touch rows older than 1 hour
// Hard cap per tick — if we somehow accumulate thousands of stuck rows,
// we don't want one tick blocking the event loop forever. Fresh rows get
// picked up on the next tick.
const MAX_PER_TICK = 200;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export async function reconcileStuckPayments(): Promise<{ checked: number; confirmed: number; failed: number; stillPending: number; errored: number }> {
  const stuck = await db
    .select({
      id: payments.id,
      provider: payments.provider,
      razorpay_order_id: payments.razorpay_order_id,
      client_txn_id:     payments.client_txn_id,
    })
    .from(payments)
    .where(and(
      eq(payments.status, "pending"),
      isNull(payments.deleted_at),
      sql`${payments.created_at} < now() - interval '${sql.raw(String(STALE_AFTER_MINUTES))} minutes'`,
      // Only rows that actually reached a gateway — a row without a
      // razorpay_order_id AND without a client_txn_id never made it past
      // /initiate. Covers both providers in one predicate.
      or(
        sql`${payments.razorpay_order_id} IS NOT NULL`,
        sql`${payments.client_txn_id} IS NOT NULL`,
      )!,
    ))
    .limit(MAX_PER_TICK);

  let confirmed = 0;
  let failed = 0;
  let stillPending = 0;
  let errored = 0;

  for (const row of stuck) {
    try {
      if (row.provider === "sabpaisa") {
        if (!row.client_txn_id) {
          // Row labelled sabpaisa but with no client_txn_id — can't be
          // looked up. Rare: usually means init crashed between row
          // creation and client_txn_id persistence. Skip.
          stillPending++;
          continue;
        }
        const { outcome, response } = await verifySabpaisaPayment(row.client_txn_id);
        if (outcome === "success") {
          // Stash the latest SabPaisa fields before confirming so the row
          // carries the gateway ids even if confirm errors below.
          if (response) {
            await db.update(payments).set({
              sabpaisa_txn_id:       (response.sabpaisaTxnId ?? null) || null,
              sabpaisa_status_code:  (response.statusCode   ?? null) || null,
              sabpaisa_payment_mode: (response.paymentMode  ?? null) || null,
              sabpaisa_bank_name:    (response.bankName     ?? null) || null,
              sabpaisa_bank_txn_id:  (response.bankTxnId    ?? null) || null,
              sabpaisa_response:     response as any,
              last_verified_at:      new Date(),
              updated_at:            new Date(),
            }).where(eq(payments.id, row.id));
          }
          await confirmPaymentAndFulfil(row.id);
          confirmed++;
        } else if (outcome === "failed" || outcome === "aborted") {
          const reason = (response?.statusDesc ?? "").trim() || `Reconciliation: SabPaisa reported ${outcome}`;
          await markPaymentFailed(row.id, reason);
          failed++;
        } else {
          stillPending++;
        }
      } else {
        // Default: Razorpay path (legacy + current-active rows).
        if (!row.razorpay_order_id) {
          stillPending++;
          continue;
        }
        // verifyOrderOutcome throws on network failure — caught below as
        // `errored` so the next tick retries. Don't flip to failed on an
        // API hiccup.
        const result = await verifyOrderOutcome(row.razorpay_order_id);

        if (result.outcome === "success") {
          if (result.payment?.id) {
            await db.update(payments).set({
              razorpay_payment_id: result.payment.id,
              updated_at: new Date(),
            }).where(eq(payments.id, row.id));
          }
          await confirmPaymentAndFulfil(row.id);
          confirmed++;
        } else if (result.outcome === "failed" || result.outcome === "aborted") {
          const reason = result.payment?.error_description
            ?? result.payment?.error_reason
            ?? `Reconciliation: Razorpay reported ${result.outcome}`;
          await markPaymentFailed(row.id, reason);
          failed++;
        } else {
          stillPending++;
        }
      }
    } catch (err) {
      errored++;
      // eslint-disable-next-line no-console
      console.error(`[paymentReconciliationCron] row ${row.id} (${row.provider}) failed:`, err);
    }
  }

  return { checked: stuck.length, confirmed, failed, stillPending, errored };
}

export function startPaymentReconciliationCron(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    reconcileStuckPayments()
      .then((summary) => {
        if (summary.checked > 0) {
          // eslint-disable-next-line no-console
          console.log(`[paymentReconciliationCron]`, summary);
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("[paymentReconciliationCron] tick failed", err);
      });
  }, TICK_MS);
}

export function stopPaymentReconciliationCron(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
