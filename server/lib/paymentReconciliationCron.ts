// Reconciliation cron for stuck Razorpay payments.
//
// Both /api/payments/verify (browser handler) and /api/payments/webhook
// (Razorpay S2S) can resolve a payment. If both fail — user closes tab
// before the verify call lands AND Razorpay's webhook retries get dropped
// (network partition, our server down past the retry budget) — the row
// stays `pending` forever. User's money went through on Razorpay; our DB
// thinks it never resolved; no registration created.
//
// This cron catches those rows: every 30 min it picks payments stuck in
// `pending` for more than 1 hour, polls Razorpay's Orders API for the
// order's payment history, and routes the outcome through the existing
// confirm / fail helpers. Both target functions are idempotent, so a late
// webhook arriving after reconciliation already fixed the row is harmless.
//
// Same tick-based pattern as jobAlertsCron.ts and escalations.ts so ops
// don't juggle multiple cron systems.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { payments } from "../../schema/index.js";
import { verifyOrderOutcome } from "./razorpay/client.js";
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
      razorpay_order_id: payments.razorpay_order_id,
    })
    .from(payments)
    .where(and(
      eq(payments.status, "pending"),
      isNull(payments.deleted_at),
      sql`${payments.created_at} < now() - interval '${sql.raw(String(STALE_AFTER_MINUTES))} minutes'`,
      // Only rows that actually reached Razorpay — a row without an order
      // id never made it past /initiate.
      sql`${payments.razorpay_order_id} IS NOT NULL`,
    ))
    .limit(MAX_PER_TICK);

  let confirmed = 0;
  let failed = 0;
  let stillPending = 0;
  let errored = 0;

  for (const row of stuck) {
    try {
      // verifyOrderOutcome throws on network failure — caught below as
      // `errored` so the next tick retries. Don't flip to failed on an
      // API hiccup.
      const result = await verifyOrderOutcome(row.razorpay_order_id!);

      if (result.outcome === "success") {
        // Persist the captured payment id before confirming so the row has
        // the Razorpay ref even if confirm errors later.
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
        // Still pending at Razorpay too — leave it; try again next tick.
        stillPending++;
      }
    } catch (err) {
      errored++;
      // eslint-disable-next-line no-console
      console.error(`[paymentReconciliationCron] row ${row.id} failed:`, err);
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
