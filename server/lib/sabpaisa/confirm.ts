// Shared "payment confirmed → fulfil the thing it paid for" logic.
//
// Called from TWO places:
//   • /api/payments/return  — user's browser landed back here after paying
//   • /api/payments/webhook — SabPaisa's server-to-server push
//
// Both can arrive first; whichever does gets the work done, the other
// is idempotent via the `payment.status = 'success'` short-circuit.
//
// This function covers only the event_registration purpose today. Add new
// `case` branches as other paid surfaces come online (job_posting is on
// the roadmap — see FEATURES_DELIVERED FUTURE log).

import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { payments, events, eventRegistrations, jobPostings, userRoleAssignments, roles, users } from "../../../schema/index.js";
import { notifyAsync } from "../notify.js";
import { dispatchJobAlerts } from "../jobAlerts.js";

function paiseToRupees(p: number): string {
  return (p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function activeTreasurerIds(branchId: string | null): Promise<string[]> {
  // Branch-scoped treasurers for the event's branch, plus any global
  // treasurers (scope_branch_id IS NULL). Active = effective_to is NULL or
  // still in the future.
  const rows = await db
    .select({ user_id: userRoleAssignments.user_id })
    .from(userRoleAssignments)
    .innerJoin(roles, eq(roles.id, userRoleAssignments.role_id))
    .innerJoin(users, eq(users.id, userRoleAssignments.user_id))
    .where(and(
      eq(roles.code, "branch_treasurer"),
      isNull(users.deleted_at),
      or(
        isNull(userRoleAssignments.effective_to),
        sql`${userRoleAssignments.effective_to} >= CURRENT_DATE`,
      )!,
      branchId
        ? or(
            isNull(userRoleAssignments.scope_branch_id),
            eq(userRoleAssignments.scope_branch_id, branchId),
          )!
        : isNull(userRoleAssignments.scope_branch_id),
    ));
  // Dedup — a treasurer might be assigned twice (overlapping terms) and we
  // don't want to spam them.
  return Array.from(new Set(rows.map((r) => r.user_id)));
}

async function fireSoldOutNotifications(opts: {
  payment_id: string;
  payer_user_id: string;
  payer_name: string;
  payer_email: string;
  amount_paise: number;
  sabpaisa_txn_id: string | null;
  event_title: string;
  event_date: string;
  branch_id: string | null;
}): Promise<void> {
  const amount_rupees = paiseToRupees(opts.amount_paise);
  const refundQueueLink = `${process.env.APP_URL ?? ""}/admin/refunds`;

  // Refund ETA shown to payer: today + 7 business days, rendered as a date.
  // 7 business days ≈ 10 calendar days with a weekend; close enough for a
  // "chase us if you don't see it by X" copy line.
  const etaDate = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
  const refund_eta_date = etaDate.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium" });

  const treasurerIds = await activeTreasurerIds(opts.branch_id);
  for (const user_id of treasurerIds) {
    notifyAsync({
      user_id,
      template_key: "payment_sold_out_treasurer",
      vars: {
        payer_name:       opts.payer_name,
        payer_email:      opts.payer_email,
        amount_rupees,
        payment_id:       opts.payment_id,
        sabpaisa_txn_id:  opts.sabpaisa_txn_id ?? "—",
        event_title:      opts.event_title,
        event_date:       opts.event_date,
        refund_queue_link: refundQueueLink,
      },
      link_url: "/admin/refunds",
    });
  }

  notifyAsync({
    user_id: opts.payer_user_id,
    template_key: "payment_sold_out_payer",
    vars: {
      event_title:  opts.event_title,
      amount_rupees,
      payment_id:   opts.payment_id,
      refund_eta_date,
    },
    link_url: "/dashboard",
  });
}

export interface ConfirmResult {
  ok: true;
  alreadyConfirmed: boolean;
  createdCount: number;
  waitlistedCount: number;
  // For job_posting purpose: the posting_id that was published, if any.
  // Lets the return handler surface it in the result page redirect so
  // the employer lands back on their posting after SabPaisa's bounce.
  activatedPostingId?: string | null;
}

// Caller already decided the SabPaisa outcome is "success" — this fn
// trusts that decision and only fulfils the purpose. Verification against
// SabPaisa must happen *before* calling this.
export async function confirmPaymentAndFulfil(paymentId: string): Promise<ConfirmResult> {
  const result = await db.transaction(async (tx) => {
    const [payment] = await tx.select().from(payments).where(eq(payments.id, paymentId)).limit(1);
    if (!payment) throw new Error(`Payment ${paymentId} not found`);

    // Idempotent short-circuit — webhook/return race safety.
    if (payment.status === "success") {
      return { alreadyConfirmed: true, event: null, createdRows: [] as Array<{ id: string; user_id: string; status: string }>, waitlistedCount: 0, payerSummary: null };
    }

    if (payment.purpose === "job_posting") {
      // Publish the job posting the payment paid for. The posting was
      // created in 'pending_payment' state by POST /api/employer/postings;
      // we flip it to 'active' only now that money actually landed.
      // Idempotent — if the posting is already active we just no-op.
      if (!payment.ref_id) {
        throw new Error(`Payment ${paymentId}: job_posting purpose but no ref_id`);
      }
      const [posting] = await tx.select().from(jobPostings)
        .where(and(eq(jobPostings.id, payment.ref_id), isNull(jobPostings.deleted_at)))
        .limit(1);
      if (!posting) {
        // Posting got deleted between pending-payment and confirmation —
        // flip the payment to success anyway (money landed) and tag the
        // row for the treasurer's refund attention.
        await tx.update(payments).set({
          status: "success",
          metadata: { ...(payment.metadata as object || {}), needs_refund: "posting_deleted_after_payment" },
          updated_at: new Date(),
        }).where(eq(payments.id, payment.id));
        return {
          alreadyConfirmed: false,
          event: null,
          createdRows: [] as Array<{ id: string; user_id: string; status: string }>,
          waitlistedCount: 0,
          activatedPostingId: null as string | null,
          payerSummary: null,
        };
      }

      if (posting.status !== "active") {
        await tx.update(jobPostings).set({
          status:     "active",
          payment_id: payment.id,
          updated_at: new Date(),
        }).where(eq(jobPostings.id, posting.id));
      }

      await tx.update(payments).set({
        status: "success",
        updated_at: new Date(),
      }).where(eq(payments.id, payment.id));

      return {
        alreadyConfirmed: false,
        event: null,
        createdRows: [] as Array<{ id: string; user_id: string; status: string }>,
        waitlistedCount: 0,
        activatedPostingId: posting.id,
        payerSummary: null,
      };
    }

    if (payment.purpose !== "event_registration") {
      // Not an event — just flip to success and let whichever subsystem
      // owns that purpose handle its own fulfilment.
      await tx.update(payments).set({
        status: "success",
        updated_at: new Date(),
      }).where(eq(payments.id, payment.id));
      return { alreadyConfirmed: false, event: null, createdRows: [], waitlistedCount: 0, payerSummary: null };
    }

    const [event] = await tx.select().from(events).where(eq(events.id, payment.ref_id!)).limit(1);
    if (!event) throw new Error(`Payment ${paymentId}: linked event not found`);

    const metadata = (payment.metadata ?? {}) as { attendee_user_ids?: string[]; seat_count?: number };
    const attendeeIds = Array.isArray(metadata.attendee_user_ids) ? metadata.attendee_user_ids : [];
    const bookerId = payment.payer_user_id!;
    const seatHolders: Array<{ user_id: string; booked_by: string | null }> = [
      { user_id: bookerId, booked_by: null },
      ...attendeeIds.map((uid) => ({ user_id: uid, booked_by: bookerId })),
    ];

    // Skip seat holders who already have an active registration — handles
    // webhook-after-return race and the (rare) manual self-register
    // between pay-click and payment confirmation.
    const existingRows = await tx
      .select({ user_id: eventRegistrations.user_id })
      .from(eventRegistrations)
      .where(and(
        eq(eventRegistrations.event_id, event.id),
        inArray(eventRegistrations.user_id, seatHolders.map((h) => h.user_id)),
        isNull(eventRegistrations.deleted_at),
      ));
    const alreadyRegistered = new Set(existingRows.map((r) => r.user_id));
    const toCreate = seatHolders.filter((h) => !alreadyRegistered.has(h.user_id));

    // Capacity check inside the txn — if event filled up between pay-click
    // and payment-confirm, batch-waitlist the whole group. Treasurer later
    // decides whether to refund via the refunds admin.
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

    await tx.update(payments).set({
      status: "success",
      metadata: willBeFull
        ? { ...(payment.metadata as object || {}), needs_refund: "event_full_after_payment" }
        : payment.metadata,
      updated_at: new Date(),
    }).where(eq(payments.id, payment.id));

    // Payer summary — only needed when we're about to fire the sold-out
    // notifications, but cheap enough to always collect so the caller
    // doesn't need a second round-trip. Null name/email are tolerated by
    // the template's render step (unknown vars become empty string).
    const metadataForPayer = (payment.metadata ?? {}) as { payer_name?: string; payer_email?: string };
    const payerSummary = willBeFull ? {
      payment_id:      payment.id,
      payer_user_id:   bookerId,
      payer_name:      metadataForPayer.payer_name ?? "",
      payer_email:     metadataForPayer.payer_email ?? "",
      amount_paise:    payment.amount_paise,
      sabpaisa_txn_id: payment.sabpaisa_txn_id ?? null,
    } : null;

    return {
      alreadyConfirmed: false,
      event,
      createdRows,
      waitlistedCount: regStatus === "waitlisted" ? createdRows.length : 0,
      activatedPostingId: null as string | null,
      payerSummary,
    };
  });

  // Fire job-alert dispatch outside the txn — a posting that just went
  // live from pending_payment should fan out to its category subscribers
  // just like a free posting would have on creation. dispatchJobAlerts
  // never throws (it logs internally) so it's safe to await here.
  if (!result.alreadyConfirmed && result.activatedPostingId) {
    await dispatchJobAlerts(result.activatedPostingId).catch(() => { /* swallow */ });
  }

  // Fire S.1 confirmations outside the txn. notifyAsync never throws so
  // these are fire-and-forget.
  if (!result.alreadyConfirmed && result.event && result.createdRows.length > 0) {
    const startsAt = result.event.starts_at instanceof Date
      ? result.event.starts_at
      : new Date(result.event.starts_at);
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

  // Sold-out alert: event filled up between pay-click and payment-confirm.
  // Treasurer gets the refund request; payer gets a "sorry, you're on the
  // waitlist, refund incoming" note. Fires outside the txn + after the
  // registration notifications so a notify failure never prevents the
  // confirmation from completing.
  if (!result.alreadyConfirmed && result.waitlistedCount > 0 && result.event && result.payerSummary) {
    const startsAt = result.event.starts_at instanceof Date
      ? result.event.starts_at
      : new Date(result.event.starts_at);
    await fireSoldOutNotifications({
      payment_id:      result.payerSummary.payment_id,
      payer_user_id:   result.payerSummary.payer_user_id,
      payer_name:      result.payerSummary.payer_name,
      payer_email:     result.payerSummary.payer_email,
      amount_paise:    result.payerSummary.amount_paise,
      sabpaisa_txn_id: result.payerSummary.sabpaisa_txn_id,
      event_title:     result.event.title,
      event_date:      startsAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium" }),
      branch_id:       result.event.branch_id ?? null,
    }).catch((err) => {
      // Don't let a notify failure propagate — the payment and
      // registration-as-waitlisted work has already landed.
      // eslint-disable-next-line no-console
      console.error("[confirm] sold-out notification dispatch failed:", err);
    });
  }

  return {
    ok: true,
    alreadyConfirmed: result.alreadyConfirmed,
    createdCount: result.createdRows.length,
    waitlistedCount: result.waitlistedCount,
    activatedPostingId: result.activatedPostingId,
  };
}

// Flip a payment to failed when SabPaisa confirms the outcome is terminal.
// Called from both /return and /webhook when the outcome is "failed" or
// "aborted". Idempotent — if the row is already in a terminal state, no-op.
export async function markPaymentFailed(paymentId: string, reason: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [p] = await tx.select({ status: payments.status }).from(payments).where(eq(payments.id, paymentId)).limit(1);
    if (!p) return;
    if (p.status === "success" || p.status === "refunded" || p.status === "partially_refunded") {
      // Don't downgrade a successful payment just because a stale webhook
      // arrived last. Rare but SabPaisa's docs flag it as possible.
      return;
    }
    await tx.update(payments).set({
      status: "failed",
      rejected_reason: reason.slice(0, 500),
      updated_at: new Date(),
    }).where(eq(payments.id, paymentId));
  });
}
