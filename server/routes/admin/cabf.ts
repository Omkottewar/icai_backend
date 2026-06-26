// Admin CABF assistance requests API.
//
// Workflow per requirements (M.1):
//   submitted → reviewing → approved → disbursed     (or → rejected)
//
// CSV export at GET /export.csv produces the chairman's monthly excel
// (filterable by month/year). PAN of the member is fetched live from
// member_profiles.kym_data — branch policy is to capture PAN at request
// time and mail 80G receipts from ICAI HO directly to the member, so we
// do NOT issue our own certificate.
//
// Mounted at /api/admin/cabf.

import { Router } from "express";
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { cabfAssistanceRequests, users, memberProfiles } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const cabfAdminRouter = Router();

const STATUSES = ["submitted", "reviewing", "approved", "rejected", "disbursed"] as const;

// ─── GET /api/admin/cabf ──────────────────────────────────────────────────
// List requests with member name + PAN (from kym_data JSON).
// Filters: ?status=  ?q=<member name/email>  ?page=  ?pageSize=
cabfAdminRouter.get("/", async (req, res, next) => {
  try {
    const status = trim(req.query.status);
    const q = trim(req.query.q);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(5, Number(req.query.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    const conds: any[] = [];
    if (status && (STATUSES as readonly string[]).includes(status)) {
      conds.push(eq(cabfAssistanceRequests.status, status));
    }
    if (q) conds.push(sql`(${users.name} ILIKE ${`%${q}%`} OR ${users.email} ILIKE ${`%${q}%`})`);
    const where = conds.length ? and(...conds) : undefined;

    const rows = await db
      .select({
        id: cabfAssistanceRequests.id,
        member_user_id: cabfAssistanceRequests.member_user_id,
        member_name: users.name,
        member_email: users.email,
        member_pan: sql<string | null>`${memberProfiles.kym_data}->>'pan'`.as("member_pan"),
        member_mrn: memberProfiles.mrn,
        category: cabfAssistanceRequests.category,
        amount_requested_paise: cabfAssistanceRequests.amount_requested_paise,
        status: cabfAssistanceRequests.status,
        decision_note: cabfAssistanceRequests.decision_note,
        disbursed_amount_paise: cabfAssistanceRequests.disbursed_amount_paise,
        disbursed_at: cabfAssistanceRequests.disbursed_at,
        created_at: cabfAssistanceRequests.created_at,
        updated_at: cabfAssistanceRequests.updated_at,
      })
      .from(cabfAssistanceRequests)
      .leftJoin(users, eq(users.id, cabfAssistanceRequests.member_user_id))
      .leftJoin(memberProfiles, eq(memberProfiles.user_id, cabfAssistanceRequests.member_user_id))
      .where(where)
      .orderBy(
        sql`CASE ${cabfAssistanceRequests.status}
              WHEN 'submitted' THEN 0
              WHEN 'reviewing' THEN 1
              WHEN 'approved' THEN 2
              WHEN 'disbursed' THEN 3
              ELSE 4 END`,
        desc(cabfAssistanceRequests.created_at),
      )
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(cabfAssistanceRequests)
      .leftJoin(users, eq(users.id, cabfAssistanceRequests.member_user_id))
      .where(where);

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/admin/cabf/:id ────────────────────────────────────────────
// Move through the workflow. Body:
//   { status, decision_note?, disbursed_amount_paise?, disbursed_at? }
cabfAdminRouter.patch("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    const status = trim(req.body?.status);
    if (!(STATUSES as readonly string[]).includes(status)) {
      throw new ApiError(400, `status must be one of: ${STATUSES.join(", ")}`);
    }

    const patch: Record<string, unknown> = { status, updated_at: new Date() };
    if ("decision_note" in req.body)        patch.decision_note = trim(req.body.decision_note) || null;
    if ("disbursed_amount_paise" in req.body) {
      const a = Number(req.body.disbursed_amount_paise);
      patch.disbursed_amount_paise = Number.isFinite(a) && a >= 0 ? a : null;
    }
    if (status === "disbursed") {
      patch.disbursed_at = req.body?.disbursed_at ? new Date(req.body.disbursed_at) : new Date();
      if (req.user?.id) patch.reviewer_user_id = req.user.id;
    } else if (status === "approved" || status === "reviewing" || status === "rejected") {
      if (req.user?.id) patch.reviewer_user_id = req.user.id;
    }

    const [row] = await db.update(cabfAssistanceRequests)
      .set(patch as any)
      .where(eq(cabfAssistanceRequests.id, id))
      .returning();
    if (!row) throw new ApiError(404, "CABF request not found");

    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/cabf/export.csv ───────────────────────────────────────
// Monthly chairman report. Defaults to the current month; override via
// ?year=&month= (month is 1-12). Returns text/csv.
cabfAdminRouter.get("/export.csv", async (req, res, next) => {
  try {
    const now = new Date();
    const year = Number(req.query.year) || now.getFullYear();
    const month = Number(req.query.month) || (now.getMonth() + 1);
    if (month < 1 || month > 12) throw new ApiError(400, "month must be 1–12");

    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 1));

    const rows = await db
      .select({
        id: cabfAssistanceRequests.id,
        member_name: users.name,
        member_email: users.email,
        member_pan: sql<string | null>`${memberProfiles.kym_data}->>'pan'`.as("member_pan"),
        category: cabfAssistanceRequests.category,
        amount_requested_paise: cabfAssistanceRequests.amount_requested_paise,
        status: cabfAssistanceRequests.status,
        decision_note: cabfAssistanceRequests.decision_note,
        disbursed_amount_paise: cabfAssistanceRequests.disbursed_amount_paise,
        disbursed_at: cabfAssistanceRequests.disbursed_at,
        created_at: cabfAssistanceRequests.created_at,
      })
      .from(cabfAssistanceRequests)
      .leftJoin(users, eq(users.id, cabfAssistanceRequests.member_user_id))
      .leftJoin(memberProfiles, eq(memberProfiles.user_id, cabfAssistanceRequests.member_user_id))
      .where(and(
        gte(cabfAssistanceRequests.created_at, start),
        lt(cabfAssistanceRequests.created_at, end),
      ))
      .orderBy(asc(cabfAssistanceRequests.created_at));

    const headers = [
      "Ticket ID", "Member name", "Member email", "PAN", "Category",
      "Amount requested (₹)", "Status", "Decision note",
      "Amount disbursed (₹)", "Disbursed at", "Submitted at",
    ];
    const escape = (v: unknown): string => {
      if (v == null) return "";
      const s = String(v);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    };

    const lines = [headers.join(",")];
    for (const r of rows) {
      lines.push([
        r.id,
        r.member_name ?? "",
        r.member_email ?? "",
        r.member_pan ?? "",
        r.category,
        (r.amount_requested_paise / 100).toFixed(2),
        r.status,
        r.decision_note ?? "",
        r.disbursed_amount_paise != null ? (r.disbursed_amount_paise / 100).toFixed(2) : "",
        r.disbursed_at ? new Date(r.disbursed_at).toISOString().slice(0, 10) : "",
        new Date(r.created_at).toISOString().slice(0, 10),
      ].map(escape).join(","));
    }

    const filename = `cabf-${year}-${String(month).padStart(2, "0")}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(lines.join("\n"));
  } catch (err) { handleApiError(err, res, next); }
});
