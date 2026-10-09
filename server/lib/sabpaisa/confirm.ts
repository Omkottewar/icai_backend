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

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { payments, events, eventRegistrations } from "../../../schema/index.js";
import { notifyAsync } from "../notify.js";

export interface ConfirmResult {
  ok: true;
  alreadyConfirmed: boolean;
  createdCount: number;
  waitlistedCount: number;
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
      return { alreadyConfirmed: true, event: null, createdRows: [] as Array<{ id: string; user_id: string; status: string }>, waitlistedCount: 0 };
    }

    if (payment.purpose !== "event_registration") {
      // Not an event — just flip to success and let whichever subsystem
      // owns that purpose handle its own fulfilment.
      await tx.update(payments).set({
        status: "success",
        updated_at: new Date(),
      }).where(eq(payments.id, payment.id));
      return { alreadyConfirmed: false, event: null, createdRows: [], waitlistedCount: 0 };
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

    return {
      alreadyConfirmed: false,
      event,
      createdRows,
      waitlistedCount: regStatus === "waitlisted" ? createdRows.length : 0,
    };
  });

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

  return {
    ok: true,
    alreadyConfirmed: result.alreadyConfirmed,
    createdCount: result.createdRows.length,
    waitlistedCount: result.waitlistedCount,
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
