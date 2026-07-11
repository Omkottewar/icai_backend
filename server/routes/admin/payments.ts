// Admin payments API — read-only listing with Razorpay reconciliation refs.
//
// Refunds live in routes/admin/refunds.ts (already mounted); this router
// surfaces the underlying payment rows so admin can audit what's happened
// against Razorpay. Aggregated totals at /summary back the dashboard tiles.
//
// Mounted at /api/admin/payments.

import { Router } from "express";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { payments, paymentRefunds, users, events, eventRegistrations, files } from "../../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { notifyAsync } from "../../lib/notify.js";
import { sendEmail } from "../../lib/email.js";
import { storage } from "../../lib/storage.js";

// Compact helper: null for empty paths so the admin UI can skip the
// "View screenshot" link when no attachment was submitted.
const fileUrl = (path: string | null | undefined) => (path ? storage().url(path) : null);

export const paymentsAdminRouter = Router();

const STATUSES = ["created", "pending", "pending_verification", "success", "failed", "refunded", "partially_refunded"] as const;
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
      OR ${payments.upi_utr}          ILIKE ${`%${q}%`}
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
        upi_utr: payments.upi_utr,
        upi_screenshot_file_id: payments.upi_screenshot_file_id,
        rejected_reason: payments.rejected_reason,
        metadata: payments.metadata,
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

// ─── GET /api/admin/payments/pending-verification ────────────────────────
// Focused queue for the manual UPI approval workflow. Every row here is a
// user waiting for the branch to confirm their UTR against the bank
// statement. Enriched with event context + screenshot file url so the
// admin panel can eyeball everything without opening a detail modal.
paymentsAdminRouter.get("/pending-verification", async (_req, res, next) => {
  try {
    const rows = await db
      .select({
        payment_id:     payments.id,
        payer_user_id:  payments.payer_user_id,
        payer_name:     users.name,
        payer_email:    users.email,
        amount_paise:   payments.amount_paise,
        upi_utr:        payments.upi_utr,
        screenshot_storage_path: files.storage_path,
        purpose:        payments.purpose,
        event_id:       events.id,
        event_title:    events.title,
        event_slug:     events.slug,
        event_starts_at: events.starts_at,
        submitted_at:   payments.updated_at,
        created_at:     payments.created_at,
        metadata:       payments.metadata,
      })
      .from(payments)
      .leftJoin(users, eq(users.id, payments.payer_user_id))
      .leftJoin(events, and(eq(events.id, payments.ref_id), eq(payments.ref_type, "event")))
      .leftJoin(files, eq(files.id, payments.upi_screenshot_file_id))
      .where(eq(payments.status, "pending_verification"))
      .orderBy(desc(payments.updated_at));
    res.json({ rows: rows.map((r) => ({
      ...r,
      screenshot_url: fileUrl(r.screenshot_storage_path),
    })) });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/payments/:id/approve ────────────────────────────────
// Admin has eyeballed the UTR against the bank statement and confirmed the
// money landed. This endpoint flips the payment to 'success', creates the
// event registration (or waitlists it if the event filled up while the
// admin was verifying), bumps registered_count, and fires the standard
// event_registered notification.
//
// Idempotent — if the payment is already 'success' and a registration
// already exists, returns 200 without side effects. This matters because
// the admin might double-click the button or reload after a network hiccup.
paymentsAdminRouter.post("/:id/approve", async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    const result = await db.transaction(async (tx) => {
      const [payment] = await tx.select().from(payments).where(eq(payments.id, id)).limit(1);
      if (!payment) throw new ApiError(404, "Payment not found");

      // Idempotent short-circuit — admin double-click / reload safety.
      if (payment.status === "success") {
        return { alreadyApproved: true, payment, createdCount: 0, waitlistedCount: 0 };
      }
      if (payment.status !== "pending_verification") {
        throw new ApiError(400, `Payment is in status '${payment.status}' — can only approve pending_verification.`);
      }
      if (payment.purpose !== "event_registration") {
        throw new ApiError(400, "Only event registrations can be approved through this endpoint (other purposes are not wired yet).");
      }

      const [event] = await tx.select().from(events).where(eq(events.id, payment.ref_id!)).limit(1);
      if (!event) throw new ApiError(404, "Linked event not found");

      // Recover the group booking from payment.metadata. Booker is always
      // seat 1; additional attendees are the ids stashed at /register time.
      const metadata = (payment.metadata ?? {}) as { attendee_user_ids?: string[]; seat_count?: number };
      const attendeeIds = Array.isArray(metadata.attendee_user_ids) ? metadata.attendee_user_ids : [];
      const bookerId = payment.payer_user_id!;
      // Seat holders: booker first (booked_by = null), then each attendee
      // (booked_by = booker so dashboard can show attribution).
      const seatHolders: Array<{ user_id: string; booked_by: string | null }> = [
        { user_id: bookerId, booked_by: null },
        ...attendeeIds.map((uid) => ({ user_id: uid, booked_by: bookerId })),
      ];

      // Skip any seat holder that already has an active registration for
      // this event — happens if admin re-approves after a partial failure,
      // or if the guest self-registered between UTR submission and approval.
      const existingRows = await tx
        .select({ user_id: eventRegistrations.user_id, status: eventRegistrations.status })
        .from(eventRegistrations)
        .where(and(
          eq(eventRegistrations.event_id, event.id),
          inArray(eventRegistrations.user_id, seatHolders.map((h) => h.user_id)),
          isNull(eventRegistrations.deleted_at),
        ));
      const alreadyRegistered = new Set(existingRows.map((r) => r.user_id));
      const toCreate = seatHolders.filter((h) => !alreadyRegistered.has(h.user_id));

      // Capacity — freshly read inside the txn so we don't over-allocate
      // if two payments approved at the same moment. If we don't have room
      // for every remaining seat, waitlist the whole batch; refund is a
      // manual off-platform action the admin decides on.
      const [fresh] = await tx.select({
        capacity: events.capacity,
        registered_count: events.registered_count,
      }).from(events).where(eq(events.id, event.id)).limit(1);
      const seatsLeft = fresh.capacity !== null ? fresh.capacity - fresh.registered_count : Infinity;
      const willBeFull = fresh.capacity !== null && seatsLeft < toCreate.length;
      const regStatus: "registered" | "waitlisted" = willBeFull ? "waitlisted" : "registered";

      let createdRows: Array<{ id: string; user_id: string; status: string }> = [];
      if (toCreate.length > 0) {
        createdRows = await tx.insert(eventRegistrations).values(
          toCreate.map((h) => ({
            event_id:          event.id,
            user_id:           h.user_id,
            status:            regStatus,
            payment_id:        payment.id,
            booked_by_user_id: h.booked_by,
          })),
        ).returning({ id: eventRegistrations.id, user_id: eventRegistrations.user_id, status: eventRegistrations.status });

        if (regStatus === "registered") {
          await tx.update(events).set({
            registered_count: sql`${events.registered_count} + ${toCreate.length}`,
            updated_at: new Date(),
          }).where(eq(events.id, event.id));
        }
      }

      const [updatedPayment] = await tx.update(payments).set({
        status: "success",
        verified_by: req.user!.id,
        verified_at: new Date(),
        metadata: willBeFull
          ? { ...(payment.metadata as object || {}), needs_refund: "event_full_after_payment" }
          : payment.metadata,
        updated_at: new Date(),
      }).where(eq(payments.id, payment.id)).returning();

      return {
        alreadyApproved: false,
        payment: updatedPayment,
        event,
        createdRows,
        createdCount: createdRows.length,
        waitlistedCount: regStatus === "waitlisted" ? createdRows.length : 0,
        bookerId,
      };
    });

    // Fire one confirmation email per newly-created registration. Attendees
    // (booked_by non-null) get a variant subject line so they know it's
    // someone else's booking. notifyAsync never throws — batch them off
    // the response critical path.
    if (!result.alreadyApproved && result.event && result.createdRows) {
      const startsAt = result.event.starts_at instanceof Date ? result.event.starts_at : new Date(result.event.starts_at);
      const commonVars = {
        event_title: result.event.title,
        event_slug:  result.event.slug,
        event_date:  startsAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium" }),
        event_time:  startsAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", timeStyle: "short" }),
        event_venue: result.event.venue || (result.event.mode === "online" ? "Online" : "TBC"),
        cpe_hours:   result.event.cpe_hours ?? "",
        calendar_link: `${process.env.APP_URL ?? ""}/events`,
        joining_link_or_directions: result.event.online_url || result.event.venue || "Details will be shared closer to the date.",
      };
      for (const row of result.createdRows) {
        notifyAsync({
          user_id: row.user_id,
          template_key: "event_registered",
          vars: commonVars,
          link_url: "/dashboard",
        });
      }
    }

    res.json({
      ok: true,
      already_approved: result.alreadyApproved,
      created_count: result.createdCount,
      waitlisted: result.waitlistedCount > 0,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/payments/:id/reject ─────────────────────────────────
// The UTR the user submitted didn't match anything in the bank statement,
// or looked fraudulent. Flip payment to 'failed', record the reason so the
// admin queue shows why, and email the user so they know to retry.
// Body: { reason: "..." }
paymentsAdminRouter.post("/:id/reject", async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    const reason = need(trim(req.body?.reason), "Rejection reason");

    const [payment] = await db.select().from(payments).where(eq(payments.id, id)).limit(1);
    if (!payment) throw new ApiError(404, "Payment not found");
    if (payment.status !== "pending_verification") {
      throw new ApiError(400, `Payment is in status '${payment.status}' — can only reject pending_verification.`);
    }

    const [updated] = await db.update(payments).set({
      status: "failed",
      rejected_reason: reason,
      verified_by: req.user!.id,
      verified_at: new Date(),
      updated_at: new Date(),
    }).where(eq(payments.id, payment.id)).returning();

    // Best-effort email to the user. No template for this yet — write the
    // copy inline. sendEmail returns a structured result on failure so we
    // never block admin's action on a mail hiccup.
    if (payment.payer_user_id) {
      const [payer] = await db.select({ name: users.name, email: users.email }).from(users).where(eq(users.id, payment.payer_user_id)).limit(1);
      if (payer?.email) {
        const md = (payment.metadata as { event_title?: string }) ?? {};
        const eventTitle = md.event_title ?? "your event registration";
        sendEmail({
          to: payer.email,
          subject: `Payment could not be verified — ${eventTitle}`,
          body: `Hi ${payer.name},\n\nWe couldn't confirm your payment for "${eventTitle}".\n\nReason: ${reason}\n\nPlease register again and submit a fresh UTR after paying. If you believe the money did leave your account, contact the branch office with a copy of the transaction receipt.\n\n— ICAI Nagpur Branch`,
        }).catch(() => { /* swallow */ });
      }
    }

    res.json({ ok: true, payment: updated });
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
        upi_utr: payments.upi_utr,
        upi_screenshot_file_id: payments.upi_screenshot_file_id,
        verified_by: payments.verified_by,
        verified_at: payments.verified_at,
        rejected_reason: payments.rejected_reason,
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
