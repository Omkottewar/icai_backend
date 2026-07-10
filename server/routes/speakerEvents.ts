// ─── /api/my-speaker-events ──────────────────────────────────────────────
// Personal dashboard endpoint for users added as guest speakers on one or
// more events. The frontend MySpeakerEventsPage lists these so a speaker
// can jump straight into the event's chat without hunting through the
// public event listing.
//
// Any signed-in user can hit this — the response is naturally empty for
// people who aren't linked as a speaker anywhere. That means the endpoint
// works for both dedicated 'guest' accounts and member accounts that
// happen to be speaking (e.g. an MCM who's also on a panel).

import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { eventSpeakers, events, committees } from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { handleApiError } from "../lib/apiError.js";

export const speakerEventsRouter = Router();

speakerEventsRouter.get("/", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db
      .select({
        event_id:      events.id,
        title:         events.title,
        slug:          events.slug,
        starts_at:     events.starts_at,
        ends_at:       events.ends_at,
        venue:         events.venue,
        mode:          events.mode,
        status:        events.status,
        committee_id:  committees.id,
        committee_name: committees.name,
        added_at:      eventSpeakers.added_at,
      })
      .from(eventSpeakers)
      .innerJoin(events, eq(events.id, eventSpeakers.event_id))
      .leftJoin(committees, eq(committees.id, events.committee_id))
      .where(eq(eventSpeakers.user_id, req.user!.id))
      .orderBy(desc(events.starts_at));

    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});
