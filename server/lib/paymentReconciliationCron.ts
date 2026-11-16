// Reconciliation cron for stuck SabPaisa payment rows.
//
// If the SabPaisa callback never reaches us (user closed the tab, network
// drop), a row can stay `pending` although the money went through. Every
// 30 min this picks SabPaisa rows pending for over an hour, checks them
// with SabPaisa's Transaction Enquiry API (one at a time, as the docs
// require) and confirms or fails them. confirm/fail are idempotent, so a
// late callback after reconciliation is harmless.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { payments } from "../../schema/index.js";
import { enquireTransaction, amountMatches } from "./sabpaisa/client.js";
import { describeSabPaisa } from "./sabpaisa/types.js";
import { confirmPaymentAndFulfil, markPaymentFailed } from "./payments/confirm.js";

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
      client_txn_id:     payments.client_txn_id,
      amount_paise:      payments.amount_paise,
      created_at:        payments.created_at,
    })
    .from(payments)
    .where(and(
      eq(payments.status, "pending"),
      isNull(payments.deleted_at),
      sql`${payments.created_at} < now() - interval '${sql.raw(String(STALE_AFTER_MINUTES))} minutes'`,
      eq(payments.provider, "sabpaisa"),
      sql`${payments.client_txn_id} IS NOT NULL`,
    ))
    .limit(MAX_PER_TICK);

  let confirmed = 0;
  let failed = 0;
  let stillPending = 0;
  let errored = 0;

  // SabPaisa rows are checked with the documented Transaction Enquiry API
  // (one request at a time — the loop below is sequential, as the docs
  // require). Set RECONCILE_SABPAISA=0 to skip them.
  const sabpaisaReconcileEnabled = (process.env.RECONCILE_SABPAISA ?? "").trim() !== "0";

  let sabpaisaSkippedThisTick = 0;
  for (const row of stuck) {
    try {
      if (row.provider === "sabpaisa") {
        if (!sabpaisaReconcileEnabled) {
          sabpaisaSkippedThisTick++;
          stillPending++;
          continue;
        }
        if (!row.client_txn_id) {
          // Row labelled sabpaisa but with no client_txn_id — can't be
          // looked up. Rare: usually means init crashed between row
          // creation and client_txn_id persistence. Skip.
          stillPending++;
          continue;
        }
        const { outcome, response } = await enquireTransaction(row.client_txn_id);
        if (response) {
          await db.update(payments).set({
            sabpaisa_txn_id:       response.sabpaisaTxnId || undefined,
            sabpaisa_status_code:  response.statusCode    || undefined,
            sabpaisa_payment_mode: response.paymentMode   || undefined,
            sabpaisa_bank_name:    response.bankName      || undefined,
            sabpaisa_bank_txn_id:  response.bankTxnId     || undefined,
            sabpaisa_response:     response as any,
            last_verified_at:      new Date(),
            updated_at:            new Date(),
          }).where(eq(payments.id, row.id));
        }
        const ageHours = (Date.now() - new Date(row.created_at).getTime()) / 3_600_000;
        if (outcome === "success" && response) {
          if (!amountMatches(response, row.amount_paise)) {
            // eslint-disable-next-line no-console
            console.error(`[paymentReconciliationCron] SabPaisa amount mismatch on ${row.id}: amount=${response.amount}`);
            stillPending++;
          } else {
            await confirmPaymentAndFulfil(row.id);
            confirmed++;
          }
        } else if (outcome === "failed" || outcome === "aborted") {
          await markPaymentFailed(row.id, describeSabPaisa(response) || `Reconciliation: SabPaisa reported ${outcome}`);
          failed++;
        } else if (outcome === "not_found" && ageHours > 24) {
          // Never reached SabPaisa's checkout (404 from enquiry) for a day.
          await markPaymentFailed(row.id, "Reconciliation: transaction not found at SabPaisa");
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

  if (sabpaisaSkippedThisTick > 0) {
    // One log line per tick, not per row. Visible to ops but doesn't
    // storm the log pipeline the way the 403 stack traces did.
    // eslint-disable-next-line no-console
    console.log(`[paymentReconciliationCron] skipped ${sabpaisaSkippedThisTick} SabPaisa row(s) — RECONCILE_SABPAISA=0`);
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
