// ─── /api/admin/events/:eventId/speakers ─────────────────────────────────
// Admin surface for managing "guest speakers" on an event. A speaker is a
// real users row with primary_role='guest' that's linked to a specific
// event via the event_speakers table. Once added:
//   • they can post in any of the event's chat channels (bypasses
//     assertRegistered / frozen / role-gates — see routes/eventChat.ts)
//   • they show a "Guest speaker" badge in the message list
//   • they get email + in-app notifications for their events (via the
//     normal notification pipeline once they sign in and link their
//     Auth0 account)
//
// Two ways to add a speaker:
//   1. POST with { user_id } — pick an existing account (e.g. a member
//      who's also speaking).
//   2. POST with { name, email, phone? } — create a fresh guest user
//      shell + link them. Sends an invite email pointing at the portal
//      login page; the speaker sets their Auth0 password on first login
//      and step 2 of findOrCreateUserFromAuth0 auto-links the shell row.
//
// Deactivation: to revoke access, delete the event_speakers row. The
// user's account stays intact for future events. To fully block a
// speaker, use the Users admin page to set status=inactive.

import { Router } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { eventSpeakers, events, users } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { sendEmail } from "../../lib/email.js";

export const eventSpeakersAdminRouter = Router({ mergeParams: true });

function normEmail(v: unknown) {
  return trim(v).toLowerCase();
}

async function assertEvent(eventId: string): Promise<{ id: string; title: string; slug: string; starts_at: Date; ends_at: Date; venue: string | null }> {
  const [ev] = await db
    .select({
      id: events.id,
      title: events.title,
      slug: events.slug,
      starts_at: events.starts_at,
      ends_at: events.ends_at,
      venue: events.venue,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!ev) throw new ApiError(404, "Event not found");
  return ev;
}

// ─── GET /api/admin/events/:eventId/speakers ─────────────────────────────
eventSpeakersAdminRouter.get("/", async (req, res, next) => {
  try {
    const eventId = String((req.params as any).eventId);
    await assertEvent(eventId);

    const rows = await db
      .select({
        id:            eventSpeakers.id,
        user_id:       eventSpeakers.user_id,
        name:          users.name,
        email:         users.email,
        phone:         users.phone,
        status:        users.status,
        last_login_at: users.last_login_at,
        added_at:      eventSpeakers.added_at,
      })
      .from(eventSpeakers)
      .innerJoin(users, eq(users.id, eventSpeakers.user_id))
      .where(eq(eventSpeakers.event_id, eventId))
      .orderBy(desc(eventSpeakers.added_at));

    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/events/:eventId/speakers ────────────────────────────
// Body — either shape:
//   { user_id: "uuid" }                              → link existing user
//   { name: "...", email: "...", phone?: "..." }     → create + link new
eventSpeakersAdminRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const eventId = String((req.params as any).eventId);
    const event = await assertEvent(eventId);

    const bodyUserId = trim(req.body?.user_id);
    let userId: string;
    let createdNewUser = false;
    let userRow: { id: string; name: string; email: string } | null = null;

    if (bodyUserId) {
      // Path 1 — existing user.
      const [existing] = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(and(eq(users.id, bodyUserId), isNull(users.deleted_at)))
        .limit(1);
      if (!existing) throw new ApiError(404, "User not found");
      userId = existing.id;
      userRow = existing;
    } else {
      // Path 2 — new guest user shell.
      const name = need(trim(req.body?.name), "Name");
      const email = need(normEmail(req.body?.email), "Email");
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "Email is not valid");
      const phone = trim(req.body?.phone) || null;

      // If an account already exists at this email, reuse it instead of
      // failing on the unique constraint. This lets the admin re-invite
      // someone who signed up earlier without hunting for their user id.
      const [byEmail] = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(and(eq(users.email, email), isNull(users.deleted_at)))
        .limit(1);

      if (byEmail) {
        userId = byEmail.id;
        userRow = byEmail;
      } else {
        const [created] = await db
          .insert(users)
          .values({
            name,
            email,
            phone,
            primary_role: "guest",
            status: "active",
          })
          .returning({ id: users.id, name: users.name, email: users.email });
        userId = created.id;
        userRow = created;
        createdNewUser = true;
      }
    }

    // Link (idempotent — the unique index on (event_id, user_id) means
    // re-adding an existing speaker is a no-op we treat as success).
    try {
      await db
        .insert(eventSpeakers)
        .values({
          event_id: eventId,
          user_id: userId,
          added_by: req.user!.id,
        });
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && (e as any).code === "23505") {
        // Already a speaker — fall through and return the current row.
      } else {
        throw e;
      }
    }

    // Fetch the joined row we'll return (matches the shape of GET /).
    const [row] = await db
      .select({
        id:            eventSpeakers.id,
        user_id:       eventSpeakers.user_id,
        name:          users.name,
        email:         users.email,
        phone:         users.phone,
        status:        users.status,
        last_login_at: users.last_login_at,
        added_at:      eventSpeakers.added_at,
      })
      .from(eventSpeakers)
      .innerJoin(users, eq(users.id, eventSpeakers.user_id))
      .where(and(eq(eventSpeakers.event_id, eventId), eq(eventSpeakers.user_id, userId)))
      .limit(1);

    // Await the invite email so we can surface the delivery status back to
    // the admin. sendEmail() never throws — it returns { status } with the
    // reason recorded on the row when it silently skipped (missing Resend
    // key in dev, ICAI domain on the blocklist, etc.), so the admin's
    // toast can say "email skipped: resend_not_configured_dev" instead of
    // pretending success.
    let emailResult: { status: string; reason?: string; error?: string; messageId?: string } | null = null;
    if (userRow) {
      const loginUrl = `${process.env.APP_URL ?? ""}/login`;
      const chatUrl = `${process.env.APP_URL ?? ""}/events/${event.slug}?chat=1`;
      const eventDate = event.starts_at.toLocaleString("en-IN", {
        dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata",
      });
      const bodyText = createdNewUser
        ? `Hi ${userRow.name},\n\nYou've been added as a guest speaker for "${event.title}" at ICAI Nagpur Branch on ${eventDate}${event.venue ? ` (${event.venue})` : ""}.\n\nAn account has been created for you at ${userRow.email}. To activate it:\n  1. Open ${loginUrl}\n  2. Click "Sign up" and use this same email — you'll set your password there.\n  3. Once signed in, open ${chatUrl} to post updates, answer questions, and interact with attendees.\n\nThank you for taking the time to speak.\n— ICAI Nagpur Branch`
        : `Hi ${userRow.name},\n\nYou've been added as a guest speaker for "${event.title}" at ICAI Nagpur Branch on ${eventDate}${event.venue ? ` (${event.venue})` : ""}.\n\nSign in with your existing account at ${loginUrl} and open ${chatUrl} to post updates and answer attendee questions.\n\nThank you for taking the time to speak.\n— ICAI Nagpur Branch`;
      const html = `
        <p>Hi ${userRow.name},</p>
        <p>You've been added as a <strong>guest speaker</strong> for <strong>${event.title}</strong> at ICAI Nagpur Branch on ${eventDate}${event.venue ? ` (${event.venue})` : ""}.</p>
        ${createdNewUser ? `
          <p>An account has been created for you at <strong>${userRow.email}</strong>. To activate it:</p>
          <ol>
            <li>Open <a href="${loginUrl}">${loginUrl}</a></li>
            <li>Click <em>Sign up</em> and use this same email address — you'll set your password there.</li>
            <li>Once signed in, go to <a href="${chatUrl}">the event's chat</a> to post updates, answer questions, and interact with attendees.</li>
          </ol>
        ` : `
          <p>Sign in with your existing account at <a href="${loginUrl}">${loginUrl}</a> and open <a href="${chatUrl}">the event's chat</a> to post updates and answer attendee questions.</p>
        `}
        <p>Thank you for taking the time to speak.<br/>— ICAI Nagpur Branch</p>
      `;
      emailResult = await sendEmail({
        to: userRow.email,
        subject: `You're speaking at ${event.title}`,
        body: bodyText,
        html,
      });
      // eslint-disable-next-line no-console
      console.log(`[eventSpeakers] invite email to ${userRow.email} → ${JSON.stringify(emailResult)}`);
    }

    res.status(201).json({ ...row, invited: createdNewUser, email: emailResult });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/admin/events/:eventId/speakers/:id ──────────────────────
eventSpeakersAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const eventId = String((req.params as any).eventId);
    const id = String(req.params.id);
    const result = await db
      .delete(eventSpeakers)
      .where(and(eq(eventSpeakers.event_id, eventId), eq(eventSpeakers.id, id)))
      .returning({ id: eventSpeakers.id });
    if (result.length === 0) throw new ApiError(404, "Speaker not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
