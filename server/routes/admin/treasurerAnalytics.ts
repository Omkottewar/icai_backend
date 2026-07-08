// Treasurer analytics endpoint — aggregates the three "big" widgets that
// don't fit in /api/admin/home:
//
//   1. cash_flow_forecast  — approved-but-unpaid bills + expected event
//                             registrations over the next 30 days
//   2. ytd_vs_ly           — revenue + expense YTD in the current FY vs
//                             the same window last year
//   3. expenses_by_category — YTD spend split by expense category
//
// One endpoint means the treasurer insights page fires one request for
// three widgets, keeping the p50 dashboard load fast even from a slow
// connection. Cached edge-side for 60s by the router chain.

import { Router } from "express";
import { and, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { bills, events, eventRegistrations, expenseCategories, payments } from "../../../schema/index.js";
import { handleApiError } from "../../lib/apiError.js";

export const treasurerAnalyticsAdminRouter = Router();

function currentFyStartYear(now = new Date()) {
  return now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

// ─── GET /api/admin/treasurer-analytics ────────────────────────────────────
treasurerAnalyticsAdminRouter.get("/", async (_req, res, next) => {
  try {
    const now = new Date();
    const fy = currentFyStartYear(now);

    // Windows we'll need:
    //   FY_START      → Apr 1 of the current FY
    //   TODAY         → now (used as YTD upper bound)
    //   LY_FY_START   → Apr 1 of last FY
    //   LY_SAME_TODAY → today's date but one year earlier
    const fyStart      = new Date(Date.UTC(fy, 3, 1));
    const lyFyStart    = new Date(Date.UTC(fy - 1, 3, 1));
    const lySameToday  = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate()));
    const forecastEnd  = new Date(now.getTime() + 30 * 86_400_000);

    // ─── Cash flow forecast (next 30 days) ────────────────────────────
    //
    // Committed outflow  = approved bills not yet paid, bill_date in
    //                       (now-30, now+30). We look back 30 days too
    //                       because approvals sometimes lag the bill date.
    //
    // Expected inflow    = registrations paid + registered on published
    //                       events starting in the next 30 days (approx —
    //                       once Razorpay is wired to registrations this
    //                       becomes exact via payments joined to events).
    const [outflowRow] = await db.select({
      committed_paise: sql<number>`COALESCE(SUM(${bills.amount_paise}), 0)::bigint`.as("committed_paise"),
      committed_count: sql<number>`count(*)::int`.as("committed_count"),
    })
      .from(bills)
      .where(and(
        isNull(bills.deleted_at),
        eq(bills.status, "approved"),
      ));

    // Expected inflow — event registrations for published events happening
    // in the next 30 days. Sums the event's fee_paise * registration count.
    // Registrations without a fee (audience=all, free events) contribute 0.
    const [inflowRow] = await db.select({
      expected_paise: sql<number>`COALESCE(SUM(${events.fee_paise}), 0)::bigint`.as("expected_paise"),
      registrations_count: sql<number>`count(${eventRegistrations.id})::int`.as("registrations_count"),
    })
      .from(events)
      .leftJoin(eventRegistrations, and(
        eq(eventRegistrations.event_id, events.id),
        isNull(eventRegistrations.deleted_at),
        sql`${eventRegistrations.status} IN ('registered', 'attended')`,
      ))
      .where(and(
        isNull(events.deleted_at),
        eq(events.status, "published"),
        gte(events.starts_at, now),
        lt(events.starts_at, forecastEnd),
      ));

    // ─── YTD revenue + expense vs same period last year ───────────────
    const [ytdRevenue] = await db.select({
      paise: sql<number>`COALESCE(SUM(${payments.amount_paise}), 0)::bigint`.as("paise"),
    })
      .from(payments)
      .where(and(
        eq(payments.status, "success"),
        gte(payments.created_at, fyStart),
        lt(payments.created_at, now),
        isNull(payments.deleted_at),
      ));

    const [lyRevenue] = await db.select({
      paise: sql<number>`COALESCE(SUM(${payments.amount_paise}), 0)::bigint`.as("paise"),
    })
      .from(payments)
      .where(and(
        eq(payments.status, "success"),
        gte(payments.created_at, lyFyStart),
        lt(payments.created_at, lySameToday),
        isNull(payments.deleted_at),
      ));

    const [ytdExpense] = await db.select({
      paise: sql<number>`COALESCE(SUM(${bills.amount_paise}), 0)::bigint`.as("paise"),
    })
      .from(bills)
      .where(and(
        isNull(bills.deleted_at),
        sql`${bills.status} IN ('approved', 'paid')`,
        sql`${bills.bill_date} >= ${fyStart.toISOString().slice(0, 10)}::date`,
        sql`${bills.bill_date} < ${now.toISOString().slice(0, 10)}::date`,
      ));

    const [lyExpense] = await db.select({
      paise: sql<number>`COALESCE(SUM(${bills.amount_paise}), 0)::bigint`.as("paise"),
    })
      .from(bills)
      .where(and(
        isNull(bills.deleted_at),
        sql`${bills.status} IN ('approved', 'paid')`,
        sql`${bills.bill_date} >= ${lyFyStart.toISOString().slice(0, 10)}::date`,
        sql`${bills.bill_date} < ${lySameToday.toISOString().slice(0, 10)}::date`,
      ));

    // ─── Expenses by category YTD ──────────────────────────────────────
    const byCategory = await db.select({
      category_id:    bills.category_id,
      category_label: expenseCategories.label,
      category_code:  expenseCategories.code,
      total_paise:    sql<number>`COALESCE(SUM(${bills.amount_paise}), 0)::bigint`.as("total_paise"),
      bill_count:     sql<number>`count(*)::int`.as("bill_count"),
    })
      .from(bills)
      .leftJoin(expenseCategories, eq(expenseCategories.id, bills.category_id))
      .where(and(
        isNull(bills.deleted_at),
        sql`${bills.status} IN ('approved', 'paid')`,
        sql`${bills.bill_date} >= ${fyStart.toISOString().slice(0, 10)}::date`,
        sql`${bills.bill_date} < ${now.toISOString().slice(0, 10)}::date`,
      ))
      .groupBy(bills.category_id, expenseCategories.label, expenseCategories.code)
      .orderBy(sql`total_paise DESC`);

    res.set("cache-control", "private, max-age=60");
    res.json({
      fy_start_year: fy,
      as_of: now.toISOString(),
      cash_flow: {
        committed_outflow_paise: Number(outflowRow?.committed_paise ?? 0),
        committed_bill_count:    Number(outflowRow?.committed_count ?? 0),
        expected_inflow_paise:   Number(inflowRow?.expected_paise ?? 0),
        expected_registrations:  Number(inflowRow?.registrations_count ?? 0),
        forecast_window_days:    30,
      },
      ytd_vs_ly: {
        revenue: {
          current_paise: Number(ytdRevenue?.paise ?? 0),
          last_year_paise: Number(lyRevenue?.paise ?? 0),
        },
        expense: {
          current_paise: Number(ytdExpense?.paise ?? 0),
          last_year_paise: Number(lyExpense?.paise ?? 0),
        },
      },
      expenses_by_category: byCategory.map((c) => ({
        ...c,
        total_paise: Number(c.total_paise),
        label: c.category_label || "Uncategorised",
      })),
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/treasurer-analytics/mis-export ─────────────────────────
// Monthly MIS — a chairman-ready CSV combining revenue, expense, and
// per-category breakdowns for a given month. Filename embeds the month.
treasurerAnalyticsAdminRouter.get("/mis-export", async (req, res, next) => {
  try {
    const monthParam = String(req.query.month || "");
    const m = /^(\d{4})-(\d{2})$/.exec(monthParam);
    const now = new Date();
    const year = m ? Number(m[1]) : now.getUTCFullYear();
    const month = m ? Number(m[2]) - 1 : now.getUTCMonth();
    const startD = new Date(Date.UTC(year, month, 1));
    const endD   = new Date(Date.UTC(year, month + 1, 1));
    const startIso = startD.toISOString().slice(0, 10);
    const endIso   = endD.toISOString().slice(0, 10);
    const label = startD.toLocaleDateString("en-IN", { month: "long", year: "numeric" });

    const [rev] = await db.select({
      paise: sql<number>`COALESCE(SUM(${payments.amount_paise}), 0)::bigint`.as("paise"),
      txn_count: sql<number>`count(*)::int`.as("txn_count"),
    })
      .from(payments)
      .where(and(
        eq(payments.status, "success"),
        gte(payments.created_at, startD),
        lt(payments.created_at, endD),
        isNull(payments.deleted_at),
      ));

    const [exp] = await db.select({
      paise: sql<number>`COALESCE(SUM(${bills.amount_paise}), 0)::bigint`.as("paise"),
      bill_count: sql<number>`count(*)::int`.as("bill_count"),
    })
      .from(bills)
      .where(and(
        isNull(bills.deleted_at),
        sql`${bills.status} IN ('approved', 'paid')`,
        sql`${bills.bill_date} >= ${startIso}::date`,
        sql`${bills.bill_date} < ${endIso}::date`,
      ));

    const byCategory = await db.select({
      category_label: expenseCategories.label,
      total_paise:    sql<number>`COALESCE(SUM(${bills.amount_paise}), 0)::bigint`.as("total_paise"),
      bill_count:     sql<number>`count(*)::int`.as("bill_count"),
    })
      .from(bills)
      .leftJoin(expenseCategories, eq(expenseCategories.id, bills.category_id))
      .where(and(
        isNull(bills.deleted_at),
        sql`${bills.status} IN ('approved', 'paid')`,
        sql`${bills.bill_date} >= ${startIso}::date`,
        sql`${bills.bill_date} < ${endIso}::date`,
      ))
      .groupBy(expenseCategories.label)
      .orderBy(sql`total_paise DESC`);

    function csv(v: unknown): string {
      if (v == null) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }
    const rupees = (paise: number) => (Number(paise) / 100).toFixed(2);

    const lines: string[] = [];
    lines.push(`ICAI Nagpur — Monthly MIS,${csv(label)}`);
    lines.push("");
    lines.push("Metric,Amount (₹),Count");
    lines.push(`Revenue,${rupees(rev?.paise ?? 0)},${rev?.txn_count ?? 0}`);
    lines.push(`Expenses,${rupees(exp?.paise ?? 0)},${exp?.bill_count ?? 0}`);
    lines.push(`Net,${rupees((rev?.paise ?? 0) - (exp?.paise ?? 0))},`);
    lines.push("");
    lines.push("Expense category,Amount (₹),Bill count");
    for (const c of byCategory) {
      lines.push(`${csv(c.category_label || "Uncategorised")},${rupees(c.total_paise)},${c.bill_count}`);
    }

    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="MIS-${year}-${String(month + 1).padStart(2, '0')}.csv"`);
    res.send(lines.join("\n"));
  } catch (err) { handleApiError(err, res, next); }
});
