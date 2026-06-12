import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { paymentRefunds, payments, users } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const refundsAdminRouter = Router();

const STATUSES = ["requested", "approved", "rejected", "processed"] as const;
type Status = typeof STATUSES[number];

// ─── GET /api/admin/refunds ───────────────────────────────────────────────
// Treasurer's refund queue. Default filter: status='requested' (newest first).
refundsAdminRouter.get("/", async (req, res, next) => {
  try {
    const status = trim(req.query.status);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const conds = [] as any[];
    if (status && STATUSES.includes(status as Status)) {
      conds.push(eq(paymentRefunds.status, status));
    }

    const rows = await db
      .select({
        id:            paymentRefunds.id,
        payment_id:    paymentRefunds.payment_id,
        amount_paise:  paymentRefunds.amount_paise,
        reason:        paymentRefunds.reason,
        status:        paymentRefunds.status,
        requested_at:  paymentRefunds.requested_at,
        approved_at:   paymentRefunds.approved_at,
        processed_at:  paymentRefunds.processed_at,
        notes:         paymentRefunds.notes,
        razorpay_refund_id: paymentRefunds.razorpay_refund_id,
        payment_amount_paise: payments.amount_paise,
        payment_purpose:      payments.purpose,
        payer_name:           users.name,
        payer_email:          users.email,
      })
      .from(paymentRefunds)
      .leftJoin(payments, eq(payments.id, paymentRefunds.payment_id))
      .leftJoin(users, eq(users.id, payments.payer_user_id))
      .where(conds.length ? and(...conds) : sql`true`)
      .orderBy(desc(paymentRefunds.requested_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(paymentRefunds)
      .where(conds.length ? and(...conds) : sql`true`);

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/refunds ──────────────────────────────────────────────
// Initiate a refund against a successful payment. Caller is typically the
// treasurer or admin; the chairman can also override.
refundsAdminRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const payment_id = need(trim(req.body?.payment_id), "Payment ID");
    const reason = need(trim(req.body?.reason), "Reason");
    const amount_paise = Math.trunc(Number(req.body?.amount_paise));
    if (!Number.isFinite(amount_paise) || amount_paise <= 0) {
      throw new ApiError(400, "amount_paise must be a positive integer");
    }

    const [payment] = await db.select().from(payments).where(eq(payments.id, payment_id)).limit(1);
    if (!payment) throw new ApiError(404, "Payment not found");
    if (payment.status !== "success") throw new ApiError(400, "Only successful payments can be refunded");
    if (amount_paise > payment.amount_paise) {
      throw new ApiError(400, "Refund amount exceeds the original payment");
    }

    const [row] = await db.insert(paymentRefunds).values({
      payment_id,
      amount_paise,
      reason,
      status: "requested",
      requested_by: req.user?.id ?? null,
    }).returning();

    res.status(201).json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/refunds/:id/approve ──────────────────────────────────
refundsAdminRouter.post("/:id/approve", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Refund ID");
    const notes = trim(req.body?.notes) || null;

    const [row] = await db.update(paymentRefunds)
      .set({
        status: "approved",
        approved_by: req.user?.id ?? null,
        approved_at: new Date(),
        notes,
        updated_at: new Date(),
      })
      .where(and(eq(paymentRefunds.id, id), eq(paymentRefunds.status, "requested")))
      .returning();
    if (!row) throw new ApiError(404, "Refund not found or no longer pending");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/refunds/:id/reject ───────────────────────────────────
refundsAdminRouter.post("/:id/reject", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Refund ID");
    const notes = need(trim(req.body?.notes), "Rejection note");

    const [row] = await db.update(paymentRefunds)
      .set({
        status: "rejected",
        approved_by: req.user?.id ?? null,
        approved_at: new Date(),
        notes,
        updated_at: new Date(),
      })
      .where(and(eq(paymentRefunds.id, id), eq(paymentRefunds.status, "requested")))
      .returning();
    if (!row) throw new ApiError(404, "Refund not found or no longer pending");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/refunds/:id/processed ────────────────────────────────
// Marks the refund as successfully processed at the gateway. Once Razorpay
// integration is wired, this will fire automatically from the webhook.
refundsAdminRouter.post("/:id/processed", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Refund ID");
    const razorpay_refund_id = trim(req.body?.razorpay_refund_id) || null;

    const [row] = await db.update(paymentRefunds)
      .set({
        status: "processed",
        razorpay_refund_id,
        processed_at: new Date(),
        updated_at: new Date(),
      })
      .where(and(eq(paymentRefunds.id, id), eq(paymentRefunds.status, "approved")))
      .returning();
    if (!row) throw new ApiError(404, "Refund not found or not in approved state");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});
