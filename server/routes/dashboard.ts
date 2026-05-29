import { Router } from "express";
import { and, asc, eq, gt, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  events,
  eventRegistrations,
  cpeCredits,
  memberProfiles,
  studentProfiles,
} from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";

export const dashboardRouter = Router();

/**
 * Indian Financial Year (Apr 1 â€“ Mar 31) covering `now`.
 * cpe_credits.year is a calendar-year integer per the schema comment, so we
 * filter on issued_at instead â€” that lets a single FY span two calendar years
 * without us having to OR two year buckets together.
 */
function currentFy(now = new Date()) {
  const month = now.getUTCMonth();
  const year = now.getUTCFullYear();
  const startYear = month >= 3 ? year : year - 1;
  const endYear = startYear + 1;
  return {
    label: `FY ${startYear}â€“${String(endYear).slice(-2)}`,
    start: new Date(Date.UTC(startYear, 3, 1)),
    end: new Date(Date.UTC(endYear, 3, 1)),
  };
}

/** Upcoming events the current user is registered/waitlisted for. */
async function getUpcomingEvents(userId: string, now: Date) {
  return db
    .select({
      id: events.id,
      slug: events.slug,
      title: events.title,
      starts_at: events.starts_at,
      cpe_hours: events.cpe_hours,
      mode: events.mode,
      venue: events.venue,
      status: eventRegistrations.status,
    })
    .from(eventRegistrations)
    .innerJoin(events, eq(events.id, eventRegistrations.event_id))
    .where(
      and(
        eq(eventRegistrations.user_id, userId),
        isNull(eventRegistrations.deleted_at),
        isNull(events.deleted_at),
        inArray(eventRegistrations.status, ["registered", "waitlisted"]),
        gt(events.starts_at, now),
      ),
    )
    .orderBy(asc(events.starts_at))
    .limit(5);
}

dashboardRouter.get("/", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    const now = new Date();
    const upcomingEvents = await getUpcomingEvents(user.id, now);

    if (user.primary_role === "member") {
      const [profile] = await db
        .select()
        .from(memberProfiles)
        .where(
          and(eq(memberProfiles.user_id, user.id), isNull(memberProfiles.deleted_at)),
        )
        .limit(1);

      const fy = currentFy(now);

      // Sum CPE hours in the current FY split by structured/unstructured.
      // numeric() comes back as string from postgres-js â€” coerce to number on read.
      const cpeRows = await db
        .select({
          type: cpeCredits.type,
          hours: sql<string>`coalesce(sum(${cpeCredits.hours}), 0)::text`.as("hours"),
        })
        .from(cpeCredits)
        .where(
          and(
            eq(cpeCredits.user_id, user.id),
            isNull(cpeCredits.deleted_at),
            gte(cpeCredits.issued_at, fy.start),
            lt(cpeCredits.issued_at, fy.end),
          ),
        )
        .groupBy(cpeCredits.type);

      const structured = Number(cpeRows.find((r) => r.type === "structured")?.hours ?? 0);
      const unstructured = Number(cpeRows.find((r) => r.type === "unstructured")?.hours ?? 0);

      return res.json({
        role: "member",
        profile: profile
          ? {
              mrn: profile.mrn,
              is_fca: profile.is_fca,
              cop_status: profile.cop_status,
              cop_number: profile.cop_number,
              is_practising: profile.is_practising,
              member_since: profile.member_since,
              city: profile.city,
              pincode: profile.pincode,
            }
          : null,
        cpe: {
          fy_label: fy.label,
          fy_start: fy.start.toISOString(),
          fy_end: fy.end.toISOString(),
          structured_hours: structured,
          unstructured_hours: unstructured,
          total_hours: structured + unstructured,
          target: 40,
          three_year_block_target: 120,
        },
        upcomingEvents,
        recentUdins: [],
      });
    }

    if (user.primary_role === "student") {
      const [profile] = await db
        .select()
        .from(studentProfiles)
        .where(
          and(eq(studentProfiles.user_id, user.id), isNull(studentProfiles.deleted_at)),
        )
        .limit(1);

      const [attended] = await db
        .select({
          count: sql<number>`count(*)::int`.as("count"),
        })
        .from(eventRegistrations)
        .where(
          and(
            eq(eventRegistrations.user_id, user.id),
            eq(eventRegistrations.status, "attended"),
            isNull(eventRegistrations.deleted_at),
          ),
        );

      return res.json({
        role: "student",
        profile: profile
          ? {
              srn: profile.srn,
              level: profile.level,
              articleship_status: profile.articleship_status,
              articleship_start: profile.articleship_start,
              exam_attempts: profile.exam_attempts,
            }
          : null,
        eventsAttended: attended?.count ?? 0,
        upcomingEvents,
      });
    }

    // Employer / staff / mcm / chairman / admin: no role-specific dashboard yet.
    // Return the shared block so the UI can render a basic view without crashing.
    return res.json({ role: user.primary_role, upcomingEvents });
  } catch (err) {
    next(err);
  }
});
