// Budgets — per-FY planned amounts by committee × category.
//
// The treasurer plans a budget spreadsheet at the start of the FY;
// actuals are computed on read by joining bills. See the /rollup endpoint
// for the dashboard widget.

import { Router } from "express";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { budgets, bills, committees, expenseCategories } from "../../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const budgetsAdminRouter = Router();

// Indian FY helper — Apr 1 → Mar 31 of the next calendar year.
function currentFyStartYear(now = new Date()) {
  return now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}
function fyBoundsIso(fy: number): [string, string] {
  const start = new Date(Date.UTC(fy, 3, 1));                 // Apr 1
  const end   = new Date(Date.UTC(fy + 1, 3, 1));             // next Apr 1 (exclusive)
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
}

// ─── LIST /api/admin/budgets ──────────────────────────────────────────────
budgetsAdminRouter.get("/", async (req, res, next) => {
  try {
    const fy = Number(trim(req.query.fy)) || currentFyStartYear();
    const rows = await db.select({
      id:            budgets.id,
      fy_start_year: budgets.fy_start_year,
      committee_id:  budgets.committee_id,
      committee_name: committees.name,
      category_id:   budgets.category_id,
      category_code: expenseCategories.code,
      category_label: expenseCategories.label,
      planned_paise: budgets.planned_paise,
      notes:         budgets.notes,
    })
      .from(budgets)
      .leftJoin(committees, eq(committees.id, budgets.committee_id))
      .leftJoin(expenseCategories, eq(expenseCategories.id, budgets.category_id))
      .where(eq(budgets.fy_start_year, fy))
      .orderBy(asc(committees.name), asc(expenseCategories.sort_order));

    res.json({ rows, fy_start_year: fy });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── CREATE or UPSERT /api/admin/budgets ──────────────────────────────────
// Upsert on the (fy, committee, category) unique index so re-uploading
// the same combination updates rather than duplicating.
budgetsAdminRouter.post("/", async (req, res, next) => {
  try {
    const fy = Number(req.body?.fy_start_year);
    if (!Number.isInteger(fy) || fy < 2000 || fy > 2100) throw new ApiError(400, "Invalid FY");
    const category_id = need(trim(req.body?.category_id), "Category");
    const committee_id = trim(req.body?.committee_id) || null;
    const planned_paise = Math.trunc(Number(req.body?.planned_paise));
    if (!Number.isFinite(planned_paise) || planned_paise < 0) throw new ApiError(400, "Planned amount must be non-negative");
    const notes = trim(req.body?.notes) || null;

    // Postgres NULLS NOT DISTINCT is used by the unique constraint; drizzle
    // onConflictDoUpdate doesn't perfectly express that. Do a manual upsert.
    const existing = await db.select({ id: budgets.id }).from(budgets).where(and(
      eq(budgets.fy_start_year, fy),
      eq(budgets.category_id, category_id),
      committee_id ? eq(budgets.committee_id, committee_id) : isNull(budgets.committee_id),
    )).limit(1);

    if (existing[0]) {
      const [row] = await db.update(budgets)
        .set({ planned_paise, notes, updated_at: new Date() })
        .where(eq(budgets.id, existing[0].id))
        .returning();
      res.json({ item: row, updated: true });
    } else {
      const [row] = await db.insert(budgets).values({
        fy_start_year: fy, committee_id, category_id, planned_paise, notes,
      }).returning();
      res.status(201).json({ item: row, updated: false });
    }
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/admin/budgets/:id ─────────────────────────────────────────
budgetsAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Budget row ID");
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (req.body?.planned_paise !== undefined) {
      const n = Math.trunc(Number(req.body.planned_paise));
      if (!Number.isFinite(n) || n < 0) throw new ApiError(400, "Planned amount must be non-negative");
      patch.planned_paise = n;
    }
    if (req.body?.notes !== undefined) patch.notes = trim(req.body.notes) || null;

    const [row] = await db.update(budgets).set(patch as any).where(eq(budgets.id, id)).returning();
    if (!row) throw new ApiError(404, "Row not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/admin/budgets/:id ────────────────────────────────────────
budgetsAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Budget row ID");
    await db.delete(budgets).where(eq(budgets.id, id));
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/budgets/rollup ────────────────────────────────────────
// Budget vs actuals for the treasurer dashboard widget. One row per
// (committee, category) with planned + actual + variance.
//
// Actuals := SUM(amount_paise) FROM bills WHERE:
//   • status IN ('approved', 'paid')       — draft/submitted/rejected excluded
//   • bill_date within FY window           — Apr 1 → next Apr 1
//   • committee_id + category_id match     — or committee_id IS NULL for
//                                             branch-wide rows
budgetsAdminRouter.get("/rollup", async (req, res, next) => {
  try {
    const fy = Number(trim(req.query.fy)) || currentFyStartYear();
    const [start, end] = fyBoundsIso(fy);

    const planned = await db.select({
      committee_id:   budgets.committee_id,
      committee_name: committees.name,
      category_id:    budgets.category_id,
      category_code:  expenseCategories.code,
      category_label: expenseCategories.label,
      category_sort:  expenseCategories.sort_order,
      planned_paise:  budgets.planned_paise,
    })
      .from(budgets)
      .leftJoin(committees, eq(committees.id, budgets.committee_id))
      .leftJoin(expenseCategories, eq(expenseCategories.id, budgets.category_id))
      .where(eq(budgets.fy_start_year, fy));

    const actuals = await db.select({
      committee_id: bills.committee_id,
      category_id:  bills.category_id,
      actual_paise: sql<number>`COALESCE(SUM(${bills.amount_paise}), 0)::bigint`.as("actual_paise"),
    })
      .from(bills)
      .where(and(
        isNull(bills.deleted_at),
        sql`${bills.status} IN ('approved', 'paid')`,
        sql`${bills.bill_date} >= ${start}::date`,
        sql`${bills.bill_date} < ${end}::date`,
      ))
      .groupBy(bills.committee_id, bills.category_id);

    const actualKey = (c: string | null, cat: string | null) => `${c ?? ''}::${cat ?? ''}`;
    const actualMap = new Map(actuals.map((a) => [actualKey(a.committee_id, a.category_id), Number(a.actual_paise)]));

    const rows = planned.map((p) => {
      const actual = actualMap.get(actualKey(p.committee_id, p.category_id)) || 0;
      const variance = actual - p.planned_paise;
      const utilisation = p.planned_paise > 0 ? actual / p.planned_paise : null;
      return { ...p, actual_paise: actual, variance_paise: variance, utilisation };
    });

    // Uncategorised actuals: bills that landed in a (committee, category)
    // combo without a matching budget line. Surface them so the treasurer
    // can plan for them next FY instead of hiding them.
    const plannedKeys = new Set(planned.map((p) => actualKey(p.committee_id, p.category_id)));
    const uncategorised = actuals
      .filter((a) => !plannedKeys.has(actualKey(a.committee_id, a.category_id)))
      .map((a) => ({ ...a, actual_paise: Number(a.actual_paise) }));

    const totals = rows.reduce((acc, r) => ({
      planned: acc.planned + r.planned_paise,
      actual:  acc.actual + r.actual_paise,
    }), { planned: 0, actual: 0 });

    res.json({
      fy_start_year: fy,
      rows,
      uncategorised,
      totals: {
        planned_paise: totals.planned,
        actual_paise:  totals.actual,
        variance_paise: totals.actual - totals.planned,
        utilisation:   totals.planned > 0 ? totals.actual / totals.planned : null,
      },
    });
  } catch (err) { handleApiError(err, res, next); }
});
