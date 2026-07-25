// Admin view of who's subscribed to job alerts. Read-only listing + CSV
// export + on-behalf-of unsubscribe (support use-case: subscriber emails
// asking to be removed, admin does it in one click).

import { Router } from "express";
import { and, asc, desc, eq, ilike, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import {
  jobAlertSubscriptions, jobCategories, users,
} from "../../../schema/index.js";
import { ApiError, handleApiError, trim } from "../../lib/apiError.js";

export const jobSubscribersAdminRouter = Router();

// ─── GET /api/admin/job-subscribers ──────────────────────────────────────
// Query: ?q=…&category=<id>&type=<posting_type>&status=active|unsub|unconfirmed
jobSubscribersAdminRouter.get("/", async (req, res, next) => {
  try {
    const q = trim(req.query.q);
    const category = trim(req.query.category);
    const type = trim(req.query.type);
    const status = trim(req.query.status);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 25));
    const offset = (page - 1) * pageSize;

    const conds: any[] = [];
    if (category) conds.push(eq(jobAlertSubscriptions.category_id, category));
    if (type) conds.push(eq(jobAlertSubscriptions.posting_type, type as any));
    if (status === "active") {
      conds.push(isNull(jobAlertSubscriptions.unsubscribed_at));
      conds.push(sql`${jobAlertSubscriptions.confirmed_at} IS NOT NULL`);
    } else if (status === "unsub") {
      conds.push(sql`${jobAlertSubscriptions.unsubscribed_at} IS NOT NULL`);
    } else if (status === "unconfirmed") {
      conds.push(isNull(jobAlertSubscriptions.confirmed_at));
      conds.push(isNull(jobAlertSubscriptions.unsubscribed_at));
    }
    if (q) {
      conds.push(sql`(${users.name} ILIKE ${"%" + q + "%"} OR ${users.email} ILIKE ${"%" + q + "%"})`);
    }

    const rows = await db
      .select({
        id: jobAlertSubscriptions.id,
        user_id: jobAlertSubscriptions.user_id,
        user_name: users.name,
        user_email: users.email,
        user_role: users.primary_role,
        category_id: jobAlertSubscriptions.category_id,
        category_name: jobCategories.name,
        posting_type: jobAlertSubscriptions.posting_type,
        frequency: jobAlertSubscriptions.frequency,
        filter_location: jobAlertSubscriptions.filter_location,
        filter_experience: jobAlertSubscriptions.filter_experience,
        confirmed_at: jobAlertSubscriptions.confirmed_at,
        unsubscribed_at: jobAlertSubscriptions.unsubscribed_at,
        last_notified_at: jobAlertSubscriptions.last_notified_at,
        created_at: jobAlertSubscriptions.created_at,
      })
      .from(jobAlertSubscriptions)
      .leftJoin(users, eq(users.id, jobAlertSubscriptions.user_id))
      .leftJoin(jobCategories, eq(jobCategories.id, jobAlertSubscriptions.category_id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(jobAlertSubscriptions.created_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(jobAlertSubscriptions)
      .leftJoin(users, eq(users.id, jobAlertSubscriptions.user_id))
      .where(conds.length ? and(...conds) : undefined);

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/job-subscribers/export ───────────────────────────────
// CSV dump of the current filter set. Not paginated. Same shape as / above.
jobSubscribersAdminRouter.get("/export", async (req, res, next) => {
  try {
    const category = trim(req.query.category);
    const type = trim(req.query.type);
    const status = trim(req.query.status);
    const conds: any[] = [];
    if (category) conds.push(eq(jobAlertSubscriptions.category_id, category));
    if (type) conds.push(eq(jobAlertSubscriptions.posting_type, type as any));
    if (status === "active") {
      conds.push(isNull(jobAlertSubscriptions.unsubscribed_at));
      conds.push(sql`${jobAlertSubscriptions.confirmed_at} IS NOT NULL`);
    } else if (status === "unsub") {
      conds.push(sql`${jobAlertSubscriptions.unsubscribed_at} IS NOT NULL`);
    }

    const rows = await db
      .select({
        user_name: users.name,
        user_email: users.email,
        user_role: users.primary_role,
        category_name: jobCategories.name,
        posting_type: jobAlertSubscriptions.posting_type,
        frequency: jobAlertSubscriptions.frequency,
        confirmed_at: jobAlertSubscriptions.confirmed_at,
        unsubscribed_at: jobAlertSubscriptions.unsubscribed_at,
        created_at: jobAlertSubscriptions.created_at,
      })
      .from(jobAlertSubscriptions)
      .leftJoin(users, eq(users.id, jobAlertSubscriptions.user_id))
      .leftJoin(jobCategories, eq(jobCategories.id, jobAlertSubscriptions.category_id))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(users.name));

    const header = "name,email,role,category,posting_type,frequency,confirmed,unsubscribed,created_at";
    const escape = (v: unknown) =>
      v === null || v === undefined ? ""
      : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"`
      : String(v);
    const lines = rows.map((r) => [
      r.user_name, r.user_email, r.user_role, r.category_name, r.posting_type,
      r.frequency, r.confirmed_at ? "yes" : "no", r.unsubscribed_at ? "yes" : "no",
      r.created_at?.toISOString?.() ?? r.created_at,
    ].map(escape).join(","));

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="job-subscribers.csv"');
    res.send([header, ...lines].join("\n"));
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/admin/job-subscribers/:id ───────────────────────────────
// Soft unsubscribe on behalf of a user.
jobSubscribersAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const [row] = await db.update(jobAlertSubscriptions)
      .set({ unsubscribed_at: new Date(), updated_at: new Date() })
      .where(eq(jobAlertSubscriptions.id, String(req.params.id)))
      .returning();
    if (!row) throw new ApiError(404, "Subscription not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
