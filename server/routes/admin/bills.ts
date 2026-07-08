import { Router } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { bills, users, events, committees, vendors, expenseCategories } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const billsAdminRouter = Router();

const STATUSES = ["draft", "submitted", "approved", "rejected", "paid"] as const;
type Status = typeof STATUSES[number];

function pickStatus(v: unknown): Status | null {
  return STATUSES.includes(v as Status) ? (v as Status) : null;
}

function parseDate(v: unknown, label: string): string {
  const s = trim(v);
  if (!s) throw new ApiError(400, `${label} is required`);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new ApiError(400, `${label} is not a valid date`);
  // Drizzle's date() column accepts an ISO yyyy-mm-dd string. Truncate the
  // input so callers can pass either yyyy-mm-dd or a full ISO timestamp.
  return s.slice(0, 10);
}

// ─── GET /api/admin/bills ─────────────────────────────────────────────────
// Accountant + treasurer share this list; filter by ?status= to narrow.
billsAdminRouter.get("/", async (req, res, next) => {
  try {
    const status = pickStatus(req.query.status);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const conds = [isNull(bills.deleted_at)] as any[];
    if (status) conds.push(eq(bills.status, status));

    const rows = await db
      .select({
        id:               bills.id,
        vendor_id:        bills.vendor_id,
        vendor_name:      bills.vendor_name,
        vendor_directory_name: vendors.name,
        category_id:      bills.category_id,
        category_label:   expenseCategories.label,
        description:      bills.description,
        amount_paise:     bills.amount_paise,
        budget_paise:     bills.budget_paise,
        bill_date:        bills.bill_date,
        bill_number:      bills.bill_number,
        status:           bills.status,
        submitted_at:     bills.submitted_at,
        approved_at:      bills.approved_at,
        paid_at:          bills.paid_at,
        rejection_reason: bills.rejection_reason,
        event_id:         bills.event_id,
        event_title:      events.title,
        committee_name:   committees.name,
        submitted_by_name: users.name,
      })
      .from(bills)
      .leftJoin(events, eq(events.id, bills.event_id))
      .leftJoin(committees, eq(committees.id, bills.committee_id))
      .leftJoin(users, eq(users.id, bills.submitted_by))
      .leftJoin(vendors, eq(vendors.id, bills.vendor_id))
      .leftJoin(expenseCategories, eq(expenseCategories.id, bills.category_id))
      .where(and(...conds))
      .orderBy(desc(bills.created_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(bills)
      .where(and(...conds));

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/bills ────────────────────────────────────────────────
// Accountant records a new bill (draft by default).
billsAdminRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const vendor_name = need(trim(req.body?.vendor_name), "Vendor name");
    const bill_date = parseDate(req.body?.bill_date, "Bill date");
    const amount_paise = Math.trunc(Number(req.body?.amount_paise));
    if (!Number.isFinite(amount_paise) || amount_paise < 0) {
      throw new ApiError(400, "amount_paise must be a non-negative integer");
    }

    const description    = trim(req.body?.description) || null;
    const bill_number    = trim(req.body?.bill_number) || null;
    const event_id       = trim(req.body?.event_id) || null;
    const committee_id   = trim(req.body?.committee_id) || null;
    const document_file_id = trim(req.body?.document_file_id) || null;
    const vendor_id      = trim(req.body?.vendor_id) || null;
    const category_id    = trim(req.body?.category_id) || null;
    const budget_paise = req.body?.budget_paise != null
      ? Math.trunc(Number(req.body.budget_paise)) || null
      : null;

    const submit = req.body?.submit === true;
    const status: Status = submit ? "submitted" : "draft";

    const [row] = await db.insert(bills).values({
      vendor_id,
      vendor_name,
      category_id,
      description,
      amount_paise,
      bill_date,
      bill_number,
      budget_paise,
      event_id,
      committee_id,
      document_file_id,
      status,
      submitted_by: req.user?.id ?? null,
      submitted_at: submit ? new Date() : null,
    }).returning();

    res.status(201).json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/admin/bills/:id ───────────────────────────────────────────
// Edit a draft bill. Once submitted, a bill is locked except via approve/reject.
billsAdminRouter.patch("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Bill ID");
    const [existing] = await db.select().from(bills)
      .where(and(eq(bills.id, id), isNull(bills.deleted_at)))
      .limit(1);
    if (!existing) throw new ApiError(404, "Bill not found");
    if (existing.status !== "draft") {
      throw new ApiError(409, "Bill is no longer a draft; ask the treasurer to reject and reopen");
    }

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (typeof req.body?.vendor_name === "string") patch.vendor_name = trim(req.body.vendor_name);
    if (typeof req.body?.description === "string") patch.description = trim(req.body.description) || null;
    if (typeof req.body?.bill_number === "string") patch.bill_number = trim(req.body.bill_number) || null;
    if (req.body?.amount_paise !== undefined) patch.amount_paise = Math.trunc(Number(req.body.amount_paise));
    if (req.body?.budget_paise !== undefined) {
      patch.budget_paise = req.body.budget_paise == null ? null : Math.trunc(Number(req.body.budget_paise));
    }
    if (typeof req.body?.bill_date === "string") patch.bill_date = parseDate(req.body.bill_date, "Bill date");
    if ("event_id" in req.body) patch.event_id = req.body.event_id || null;
    if ("committee_id" in req.body) patch.committee_id = req.body.committee_id || null;
    if ("vendor_id" in req.body) patch.vendor_id = req.body.vendor_id || null;
    if ("category_id" in req.body) patch.category_id = req.body.category_id || null;
    if ("document_file_id" in req.body) patch.document_file_id = req.body.document_file_id || null;

    const [row] = await db.update(bills).set(patch as any).where(eq(bills.id, id)).returning();
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/bills/:id/submit ─────────────────────────────────────
// Accountant submits a draft for treasurer approval.
billsAdminRouter.post("/:id/submit", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Bill ID");
    const [row] = await db.update(bills)
      .set({ status: "submitted", submitted_at: new Date(), submitted_by: req.user?.id ?? null, updated_at: new Date() })
      .where(and(eq(bills.id, id), eq(bills.status, "draft")))
      .returning();
    if (!row) throw new ApiError(404, "Bill not found or not in draft state");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/bills/:id/approve ────────────────────────────────────
billsAdminRouter.post("/:id/approve", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Bill ID");
    const [row] = await db.update(bills)
      .set({ status: "approved", approved_by: req.user?.id ?? null, approved_at: new Date(), updated_at: new Date() })
      .where(and(eq(bills.id, id), eq(bills.status, "submitted")))
      .returning();
    if (!row) throw new ApiError(404, "Bill not found or not in submitted state");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/bills/:id/reject ─────────────────────────────────────
billsAdminRouter.post("/:id/reject", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Bill ID");
    const reason = need(trim(req.body?.reason), "Rejection reason");
    const [row] = await db.update(bills)
      .set({
        status: "rejected",
        rejection_reason: reason,
        approved_by: req.user?.id ?? null,
        approved_at: new Date(),
        updated_at: new Date(),
      })
      .where(and(eq(bills.id, id), eq(bills.status, "submitted")))
      .returning();
    if (!row) throw new ApiError(404, "Bill not found or not in submitted state");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/bills/:id/paid ───────────────────────────────────────
billsAdminRouter.post("/:id/paid", async (_req, res, next) => {
  try {
    const id = need(trim((_req as any).params.id), "Bill ID");
    const [row] = await db.update(bills)
      .set({ status: "paid", paid_at: new Date(), updated_at: new Date() })
      .where(and(eq(bills.id, id), eq(bills.status, "approved")))
      .returning();
    if (!row) throw new ApiError(404, "Bill not found or not in approved state");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/admin/bills/:id ──────────────────────────────────────────
// Soft-delete; only allowed for drafts.
billsAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Bill ID");
    const [row] = await db.update(bills)
      .set({ deleted_at: new Date(), updated_at: new Date() })
      .where(and(eq(bills.id, id), eq(bills.status, "draft"), isNull(bills.deleted_at)))
      .returning();
    if (!row) throw new ApiError(404, "Bill not found or already submitted");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
