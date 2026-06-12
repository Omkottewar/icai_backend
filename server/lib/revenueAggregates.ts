import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { payments } from "../../schema/index.js";

// Monthly revenue aggregation utilities.
//
// Used by:
//   - TreasurerHome's "Revenue by month" sparkline
//   - ChairmanHome's headline numbers
//   - FY export CSV
//
// We aggregate over successful payments only (status = 'success') because
// that's the column the treasurer cares about — pending / failed rows must
// not inflate revenue. The buckets are calendar months in UTC; if the client
// wants IST buckets later we can swap to date_trunc with AT TIME ZONE.

export type MonthlyRevenueRow = {
  month: string;          // 'YYYY-MM' (UTC)
  total_paise: number;
  transaction_count: number;
};

/**
 * Returns one row per month in [fromDate, toDate). Months with zero revenue
 * are NOT returned — the caller is expected to fill gaps if they want a
 * dense series (Treasurer chart does).
 */
export async function getMonthlyRevenue(
  fromDate: Date,
  toDate: Date,
): Promise<MonthlyRevenueRow[]> {
  const rows = await db
    .select({
      month: sql<string>`to_char(date_trunc('month', ${payments.created_at}), 'YYYY-MM')`.as("month"),
      total_paise: sql<number>`COALESCE(SUM(${payments.amount_paise}), 0)::bigint`.as("total_paise"),
      transaction_count: sql<number>`count(*)::int`.as("transaction_count"),
    })
    .from(payments)
    .where(and(
      eq(payments.status, "success"),
      gte(payments.created_at, fromDate),
      lt(payments.created_at, toDate),
      isNull(payments.deleted_at),
    ))
    .groupBy(sql`date_trunc('month', ${payments.created_at})`)
    .orderBy(sql`date_trunc('month', ${payments.created_at})`);

  // `bigint` columns come back as strings from postgres-js; coerce here so
  // the caller always sees a number. Safe to Number() — branch-level revenue
  // will never exceed Number.MAX_SAFE_INTEGER paise (~9e15).
  return rows.map((r) => ({
    month: r.month,
    total_paise: Number(r.total_paise),
    transaction_count: r.transaction_count,
  }));
}

/**
 * Convenience: sum of successful revenue for the current calendar month.
 */
export async function getCurrentMonthRevenuePaise(): Promise<number> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const nextMonth  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const rows = await getMonthlyRevenue(monthStart, nextMonth);
  return rows[0]?.total_paise ?? 0;
}

/**
 * Fills any missing months in [from, to) with zero rows so the caller can
 * plot a dense sparkline. `from` should be a month-aligned date.
 */
export function fillMissingMonths(
  rows: MonthlyRevenueRow[],
  from: Date,
  to: Date,
): MonthlyRevenueRow[] {
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  const out: MonthlyRevenueRow[] = [];
  const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  while (cursor < to) {
    const key = cursor.toISOString().slice(0, 7);
    out.push(byMonth.get(key) ?? { month: key, total_paise: 0, transaction_count: 0 });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}
