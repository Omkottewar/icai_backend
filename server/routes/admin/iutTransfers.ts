import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { iutTransfers, users } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const iutTransfersAdminRouter = Router();

const STATUSES = ["requested", "approved", "rejected", "executed"] as const;
type Status = typeof STATUSES[number];

function parseIsoDate(v: unknown, label: string): string {
  const s = trim(v);
  if (!s) throw new ApiError(400, `${label} is required`);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new ApiError(400, `${label} is not a valid date`);
  return s;
}

// ─── GET /api/admin/iut-transfers ─────────────────────────────────────────
iutTransfersAdminRouter.get("/", async (req, res, next) => {
  try {
    const status = trim(req.query.status);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const conds = [] as any[];
    if (status && STATUSES.includes(status as Status)) conds.push(eq(iutTransfers.status, status));

    const rows = await db
      .select({
        id:                iutTransfers.id,
        amount_paise:      iutTransfers.amount_paise,
        transfer_date:     iutTransfers.transfer_date,
        from_account:      iutTransfers.from_account,
        to_account:        iutTransfers.to_account,
        purpose:           iutTransfers.purpose,
        reference_number:  iutTransfers.reference_number,
        status:            iutTransfers.status,
        requested_at:      iutTransfers.requested_at,
        approved_at:       iutTransfers.approved_at,
        executed_at:       iutTransfers.executed_at,
        rejection_reason:  iutTransfers.rejection_reason,
        notes:             iutTransfers.notes,
        requested_by_name: users.name,
      })
      .from(iutTransfers)
      .leftJoin(users, eq(users.id, iutTransfers.requested_by))
      .where(conds.length ? and(...conds) : sql`true`)
      .orderBy(desc(iutTransfers.requested_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(iutTransfers)
      .where(conds.length ? and(...conds) : sql`true`);

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/iut-transfers ────────────────────────────────────────
iutTransfersAdminRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const amount_paise = Math.trunc(Number(req.body?.amount_paise));
    if (!Number.isFinite(amount_paise) || amount_paise <= 0) {
      throw new ApiError(400, "amount_paise must be a positive integer");
    }
    const transfer_date = parseIsoDate(req.body?.transfer_date, "Transfer date");
    const from_account = need(trim(req.body?.from_account), "From account");
    const to_account = need(trim(req.body?.to_account), "To account");
    if (from_account === to_account) throw new ApiError(400, "From and To accounts must differ");
    const purpose = need(trim(req.body?.purpose), "Purpose");
    const reference_number = trim(req.body?.reference_number) || null;
    const document_file_id = trim(req.body?.document_file_id) || null;
    const notes = trim(req.body?.notes) || null;

    const [row] = await db.insert(iutTransfers).values({
      amount_paise,
      transfer_date,
      from_account,
      to_account,
      purpose,
      reference_number,
      document_file_id,
      notes,
      requested_by: req.user?.id ?? null,
    }).returning();

    res.status(201).json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/iut-transfers/:id/approve ────────────────────────────
iutTransfersAdminRouter.post("/:id/approve", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Transfer ID");
    const [row] = await db.update(iutTransfers)
      .set({
        status: "approved",
        approved_by: req.user?.id ?? null,
        approved_at: new Date(),
        updated_at: new Date(),
      })
      .where(and(eq(iutTransfers.id, id), eq(iutTransfers.status, "requested")))
      .returning();
    if (!row) throw new ApiError(404, "Transfer not found or not pending");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/iut-transfers/:id/reject ─────────────────────────────
iutTransfersAdminRouter.post("/:id/reject", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Transfer ID");
    const reason = need(trim(req.body?.reason), "Rejection reason");
    const [row] = await db.update(iutTransfers)
      .set({
        status: "rejected",
        rejection_reason: reason,
        approved_by: req.user?.id ?? null,
        approved_at: new Date(),
        updated_at: new Date(),
      })
      .where(and(eq(iutTransfers.id, id), eq(iutTransfers.status, "requested")))
      .returning();
    if (!row) throw new ApiError(404, "Transfer not found or not pending");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/iut-transfers/:id/executed ───────────────────────────
iutTransfersAdminRouter.post("/:id/executed", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Transfer ID");
    const reference_number = trim(req.body?.reference_number) || null;
    const [row] = await db.update(iutTransfers)
      .set({
        status: "executed",
        executed_at: new Date(),
        reference_number,
        updated_at: new Date(),
      })
      .where(and(eq(iutTransfers.id, id), eq(iutTransfers.status, "approved")))
      .returning();
    if (!row) throw new ApiError(404, "Transfer not found or not in approved state");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});
