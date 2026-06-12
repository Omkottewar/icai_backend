import { and, count, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { cabfAssistanceRequests, payments } from "../../schema/index.js";

// CABF (CA Benevolent Fund) aggregation utilities for the Treasurer's
// dashboard. The branch collects CABF contributions from members; receipts
// are remitted to ICAI HO monthly. The treasurer needs to know at a glance:
//
//   - How much was received this month (so they can plan the next remittance)
//   - How many requests are pending review/disbursement
//   - When the last remittance was made

export type CabfStats = {
  receipts_this_month_paise: number;
  receipts_this_month_count: number;
  requests_pending_review: number;
  requests_pending_disbursement: number;
};

export async function getCabfStats(): Promise<CabfStats> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonth  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

  // Receipts: successful payments with purpose='cabf_donation' in this calendar month
  const [receipts] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${payments.amount_paise}), 0)::bigint`.as("total"),
      count: count(payments.id),
    })
    .from(payments)
    .where(and(
      eq(payments.purpose, "cabf_donation"),
      eq(payments.status, "success"),
      gte(payments.created_at, monthStart),
      lt(payments.created_at, nextMonth),
    ));

  // Pending review: status in (submitted, reviewing)
  const [pendingReview] = await db
    .select({ c: count(cabfAssistanceRequests.id) })
    .from(cabfAssistanceRequests)
    .where(sql`${cabfAssistanceRequests.status} IN ('submitted', 'reviewing')`);

  // Pending disbursement: approved but not yet disbursed
  const [pendingDisbursement] = await db
    .select({ c: count(cabfAssistanceRequests.id) })
    .from(cabfAssistanceRequests)
    .where(eq(cabfAssistanceRequests.status, "approved"));

  return {
    receipts_this_month_paise: Number(receipts.total ?? 0),
    receipts_this_month_count: receipts.count,
    requests_pending_review: pendingReview.c,
    requests_pending_disbursement: pendingDisbursement.c,
  };
}
