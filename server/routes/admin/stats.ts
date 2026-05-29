import { Router } from "express";
import { and, eq, gt, gte, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { events, eventRegistrations, users } from "../../../schema/index.js";
import { handleApiError } from "../../lib/apiError.js";

export const statsAdminRouter = Router();

statsAdminRouter.get("/", async (_req, res, next) => {
  try {
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [{ members }] = await db
      .select({ members: sql<number>`count(*)::int`.as("members") })
      .from(users)
      .where(and(eq(users.primary_role, "member"), isNull(users.deleted_at)));

    const [{ students }] = await db
      .select({ students: sql<number>`count(*)::int`.as("students") })
      .from(users)
      .where(and(eq(users.primary_role, "student"), isNull(users.deleted_at)));

    const [{ totalEvents }] = await db
      .select({ totalEvents: sql<number>`count(*)::int`.as("totalEvents") })
      .from(events)
      .where(isNull(events.deleted_at));

    const [{ upcomingEvents }] = await db
      .select({ upcomingEvents: sql<number>`count(*)::int`.as("upcomingEvents") })
      .from(events)
      .where(and(
        eq(events.status, "published"),
        gt(events.starts_at, now),
        isNull(events.deleted_at),
      ));

    const [{ registrationsWeek }] = await db
      .select({ registrationsWeek: sql<number>`count(*)::int`.as("registrationsWeek") })
      .from(eventRegistrations)
      .where(and(
        gte(eventRegistrations.registered_at, sevenDaysAgo),
        isNull(eventRegistrations.deleted_at),
      ));

    res.json({
      members,
      students,
      total_events: totalEvents,
      upcoming_events: upcomingEvents,
      registrations_week: registrationsWeek,
      // Placeholders for entities not yet wired into the admin UI.
      pending_approvals: 0,
      revenue_fy_paise: 0,
    });
  } catch (err) { handleApiError(err, res, next); }
});
