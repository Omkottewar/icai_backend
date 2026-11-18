// "Pay at venue" for paid events.
//
// When a member's online payment fails or is cancelled, they can still book
// if the event allows it: the seat is confirmed at once and a new payment
// row (provider 'pay_at_venue', status 'pending') records the amount due.
// The treasurer marks it paid at the event (admin payments page).
//
// The per-event switch lives in lib/eventOptions.ts.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { events, eventRegistrations, payments } from "../../schema/index.js";
import { ApiError } from "./apiError.js";
import { notifyAsync } from "./notify.js";
import { getEventOptions, setEventOptions } from "./eventOptions.js";

export async function getPayAtVenue(eventId: string): Promise<boolean> {
  return (await getEventOptions(eventId)).pay_at_venue;
}

export async function setPayAtVenue(eventId: string, on: boolean): Promise<void> {
  await setEventOptions(eventId, { pay_at_venue: on });
}

// Book the seats of a failed online payment as "pay at venue".
// Returns the new payment row id.
export async function bookPayAtVenue(failedPaymentId: string): Promise<{ payment_id: string; seats: number }> {
  const [failed] = await db.select().from(payments).where(eq(payments.id, failedPaymentId)).limit(1);
  if (!failed || failed.purpose !== "event_registration" || !failed.ref_id) throw new ApiError(404, "Payment not found");
  if (failed.status !== "failed") {
    throw new ApiError(400, failed.status === "success"
      ? "This payment went through — you're already registered."
      : "Pay at venue is only available after an online payment fails or is cancelled.");
  }

  const [event] = await db.select().from(events).where(and(eq(events.id, failed.ref_id), isNull(events.deleted_at))).limit(1);
  if (!event || event.status !== "published") throw new ApiError(404, "Event not found");
  if (event.starts_at <= new Date()) throw new ApiError(400, "Registration is closed for this event");
  if (!(await getPayAtVenue(event.id))) throw new ApiError(400, "Pay at venue is not available for this event.");

  const meta = (failed.metadata ?? {}) as Record<string, any>;
  const bookerId = failed.payer_user_id!;
  const attendeeIds: string[] = Array.isArray(meta.attendee_user_ids) ? meta.attendee_user_ids : [];
  const holders = [{ user_id: bookerId, booked_by: null as string | null }, ...attendeeIds.map((u) => ({ user_id: u, booked_by: bookerId }))];

  const result = await db.transaction(async (tx) => {
    // Lock the event so concurrent bookings can't oversell.
    const [fresh] = await tx.select({ capacity: events.capacity, registered_count: events.registered_count })
      .from(events).where(eq(events.id, event.id)).for("update").limit(1);

    const existing = await tx.select({ user_id: eventRegistrations.user_id }).from(eventRegistrations).where(and(
      eq(eventRegistrations.event_id, event.id),
      inArray(eventRegistrations.user_id, holders.map((h) => h.user_id)),
      isNull(eventRegistrations.deleted_at),
    ));
    if (existing.some((r) => r.user_id === bookerId)) throw new ApiError(409, "You are already registered for this event");
    const already = new Set(existing.map((r) => r.user_id));
    const toCreate = holders.filter((h) => !already.has(h.user_id));

    const seatsLeft = fresh.capacity !== null ? fresh.capacity - fresh.registered_count : Infinity;
    if (seatsLeft < toCreate.length) {
      throw new ApiError(400, seatsLeft <= 0 ? "Sorry, this event is now full." : `Only ${seatsLeft} seat${seatsLeft === 1 ? "" : "s"} left.`);
    }

    // Price the seats actually booked (an attendee may have registered
    // separately in the meantime).
    // seat_prices: per-person price (members and non-members can pay
    // different fees in one group booking).
    const perSeat = Number(meta.per_seat_paise) || Math.round(failed.amount_paise / Math.max(1, holders.length));
    const seatPrices = (meta.seat_prices ?? {}) as Record<string, number>;
    const amount = toCreate.reduce((sum, h) => sum + (Number(seatPrices[h.user_id]) || perSeat), 0);

    const [venuePayment] = await tx.insert(payments).values({
      payer_user_id: bookerId,
      amount_paise:  amount,
      currency:      "INR",
      status:        "pending",
      provider:      "pay_at_venue",
      purpose:       "event_registration",
      ref_type:      failed.ref_type,
      ref_id:        event.id,
      metadata: {
        ...meta,
        seat_count:          toCreate.length,
        attendee_user_ids:   toCreate.filter((h) => h.booked_by).map((h) => h.user_id),
        base_paise:          meta.base_paise != null ? Math.round(Number(meta.base_paise) / Math.max(1, holders.length)) * toCreate.length : undefined,
        gst_paise:           meta.gst_paise != null ? Math.round(Number(meta.gst_paise) / Math.max(1, holders.length)) * toCreate.length : undefined,
        pay_at_venue:        true,
        replaces_payment_id: failed.id,
      },
    }).returning();

    const rows = await tx.insert(eventRegistrations).values(toCreate.map((h) => ({
      event_id:          event.id,
      user_id:           h.user_id,
      status:            "registered" as const,
      payment_id:        venuePayment.id,
      booked_by_user_id: h.booked_by,
    }))).returning({ id: eventRegistrations.id, user_id: eventRegistrations.user_id });

    await tx.update(events).set({
      registered_count: sql`${events.registered_count} + ${toCreate.length}`,
      updated_at: new Date(),
    }).where(eq(events.id, event.id));

    return { venuePayment, rows, amount };
  });

  const startsAt = new Date(event.starts_at);
  for (const r of result.rows) {
    notifyAsync({
      user_id: r.user_id,
      template_key: "event_registered",
      vars: {
        event_title: event.title,
        event_slug:  event.slug,
        event_date:  startsAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "medium" }),
        event_time:  startsAt.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", timeStyle: "short" }),
        event_venue: event.venue || (event.mode === "online" ? "Online" : "TBC"),
        cpe_hours:   event.cpe_hours ?? "",
        calendar_link: `${process.env.APP_URL ?? ""}/events`,
        joining_link_or_directions: `${event.online_url || event.venue || "Details will be shared closer to the date."}\n\nPayment: ₹${(result.amount / 100).toLocaleString("en-IN")} to be paid at the venue.`,
      },
      link_url: "/dashboard",
    });
  }

  return { payment_id: result.venuePayment.id, seats: result.rows.length };
}

// If an online payment the member thought had failed later succeeds, the
// seats booked as "pay at venue" are moved onto it and the venue dues are
// cancelled. Called from confirmPaymentAndFulfil after a success.
export async function settleVenueBookingPaidOnline(onlinePaymentId: string): Promise<void> {
  const venue = (await db.execute(sql`
    SELECT id FROM payments
    WHERE provider = 'pay_at_venue' AND status = 'pending'
      AND metadata->>'replaces_payment_id' = ${onlinePaymentId}`)) as unknown as Array<{ id: string }>;
  if (venue.length === 0) return;
  const ids = venue.map((v) => v.id);
  await db.update(eventRegistrations).set({ payment_id: onlinePaymentId }).where(inArray(eventRegistrations.payment_id, ids));
  await db.update(payments).set({
    status: "failed",
    rejected_reason: "Not needed — the online payment went through",
    updated_at: new Date(),
  }).where(inArray(payments.id, ids));
}
