// Admin payments API — read-only listing with Razorpay reconciliation refs.
//
// Refunds live in routes/admin/refunds.ts (already mounted); this router
// surfaces the underlying payment rows so admin can audit what's happened
// against Razorpay. Aggregated totals at /summary back the dashboard tiles.
//
// Mounted at /api/admin/payments.

import { Router } from "express";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { payments, paymentRefunds, users } from "../../../schema/index.js";
import { ApiError, handleApiError, trim } from "../../lib/apiError.js";

export const paymentsAdminRouter = Router();

const STATUSES = ["created", "pending", "success", "failed", "refunded", "partially_refunded"] as const;
const PURPOSES = [
  "event_registration", "cop_renewal", "firm_registration", "job_posting",
  "assignment_posting", "cabf_donation", "consultation", "room_booking", "other",
] as const;

// ─── GET /api/admin/payments ──────────────────────────────────────────────
// List with filters:
//   ?status=  ?purpose=  ?from=<iso>  ?to=<iso>  ?q=<order/payment id substring>
//   ?page=  ?pageSize=
paymentsAdminRouter.get("/", async (req, res, next) => {
  try {
    const status = trim(req.query.status);
    const purpose = trim(req.query.purpose);
    const from = trim(req.query.from);
    const to = trim(req.query.to);
    const q = trim(req.query.q);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(5, Number(req.query.pageSize) || 50));
    const offset = (page - 1) * pageSize;

    const conds: any[] = [];
    if (status && (STATUSES as readonly string[]).includes(status))   conds.push(eq(payments.status, status as any));
    if (purpose && (PURPOSES as readonly string[]).includes(purpose)) conds.push(eq(payments.purpose, purpose as any));
    if (from) conds.push(gte(payments.created_at, new Date(from)));
    if (to)   conds.push(lt(payments.created_at, new Date(to)));
    if (q)    conds.push(sql`(
      ${payments.razorpay_order_id} ILIKE ${`%${q}%`}
      OR ${payments.razorpay_payment_id} ILIKE ${`%${q}%`}
    )`);
    const where = conds.length ? and(...conds) : undefined;

    const rows = await db
      .select({
        id: payments.id,
        payer_user_id: payments.payer_user_id,
        payer_name: users.name,
        payer_email: users.email,
        amount_paise: payments.amount_paise,
        currency: payments.currency,
        status: payments.status,
        purpose: payments.purpose,
        ref_type: payments.ref_type,
        ref_id: payments.ref_id,
        razorpay_order_id: payments.razorpay_order_id,
        razorpay_payment_id: payments.razorpay_payment_id,
        created_at: payments.created_at,
        updated_at: payments.updated_at,
        // Sum of approved/processed refunds for this payment.
        refunded_paise: sql<number>`coalesce((
          SELECT sum(amount_paise) FROM ${paymentRefunds}
          WHERE ${paymentRefunds.payment_id} = ${payments.id}
            AND status IN ('approved', 'processed')
        ), 0)::int`.as("refunded_paise"),
      })
      .from(payments)
      .leftJoin(users, eq(users.id, payments.payer_user_id))
      .where(where)
      .orderBy(desc(payments.created_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(payments)
      .where(where);

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/payments/summary ──────────────────────────────────────
// Aggregate cards for the dashboard. ?days=N (default 30, max 365).
paymentsAdminRouter.get("/summary", async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const sinceSql = sql.raw(`now() - interval '${days} days'`);

    const [byStatus] = (await db.execute(sql`
      SELECT
        coalesce(sum(CASE WHEN status = 'success'              THEN amount_paise ELSE 0 END), 0)::bigint AS success_paise,
        coalesce(sum(CASE WHEN status IN ('refunded','partially_refunded') THEN amount_paise ELSE 0 END), 0)::bigint AS refunded_paise,
        coalesce(sum(CASE WHEN status = 'failed'               THEN amount_paise ELSE 0 END), 0)::bigint AS failed_paise,
        count(*)::int                                                                                AS total_count,
        count(*) FILTER (WHERE status = 'success')::int                                              AS success_count,
        count(*) FILTER (WHERE status = 'failed')::int                                               AS failed_count
      FROM payments
      WHERE created_at >= ${sinceSql}
    `)) as unknown as Array<{
      success_paise: string; refunded_paise: string; failed_paise: string;
      total_count: number; success_count: number; failed_count: number;
    }>;

    const byPurpose = (await db.execute(sql`
      SELECT purpose, count(*)::int AS count,
             coalesce(sum(amount_paise) FILTER (WHERE status = 'success'), 0)::bigint AS success_paise
      FROM payments
      WHERE created_at >= ${sinceSql}
      GROUP BY purpose
      ORDER BY success_paise DESC
    `)) as unknown as Array<{ purpose: string; count: number; success_paise: string }>;

    res.json({
      window_days: days,
      total_count: Number(byStatus?.total_count ?? 0),
      success_count: Number(byStatus?.success_count ?? 0),
      failed_count: Number(byStatus?.failed_count ?? 0),
      success_paise: Number(byStatus?.success_paise ?? 0),
      refunded_paise: Number(byStatus?.refunded_paise ?? 0),
      failed_paise: Number(byStatus?.failed_paise ?? 0),
      by_purpose: byPurpose.map((p) => ({
        purpose: p.purpose,
        count: Number(p.count),
        success_paise: Number(p.success_paise),
      })),
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/payments/:id ──────────────────────────────────────────
// Detail view with refund history.
paymentsAdminRouter.get("/:id", async (req, res, next) => {
  try {
    const id = trim(req.params.id);
    const [p] = await db
      .select({
        id: payments.id,
        payer_user_id: payments.payer_user_id,
        payer_name: users.name,
        payer_email: users.email,
        amount_paise: payments.amount_paise,
        currency: payments.currency,
        status: payments.status,
        purpose: payments.purpose,
        ref_type: payments.ref_type,
        ref_id: payments.ref_id,
        razorpay_order_id: payments.razorpay_order_id,
        razorpay_payment_id: payments.razorpay_payment_id,
        razorpay_signature: payments.razorpay_signature,
        metadata: payments.metadata,
        created_at: payments.created_at,
        updated_at: payments.updated_at,
      })
      .from(payments)
      .leftJoin(users, eq(users.id, payments.payer_user_id))
      .where(eq(payments.id, id))
      .limit(1);
    if (!p) throw new ApiError(404, "Payment not found");

    const refunds = await db
      .select()
      .from(paymentRefunds)
      .where(eq(paymentRefunds.payment_id, id))
      .orderBy(desc(paymentRefunds.requested_at));

    res.json({ payment: p, refunds });
  } catch (err) { handleApiError(err, res, next); }
});
