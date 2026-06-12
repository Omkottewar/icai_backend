import { Router } from "express";
import { and, asc, eq, gt, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  events,
  eventRegistrations,
  cpeCredits,
  memberProfiles,
  studentProfiles,
  dashboardLayouts,
} from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { currentFy } from "../lib/fy.js";

export const dashboardRouter = Router();

// ─── Customizable layout endpoints ──────────────────────────────────────────
// Per-user widget layout for the customizable dashboard. The widget registry
// lives on the frontend; this endpoint stores opaque { id, size } items in
// render order. We sanity-check that the body is an array of objects with
// string id + size ∈ {sm, md, lg}, but we don't validate the ids themselves
// against a catalog — unknown ids are silently dropped client-side so the
// backend stays evergreen as widgets are added/renamed.
const ALLOWED_SIZES = new Set(["sm", "md", "lg"]);

function sanitizeLayout(input: unknown): Array<{ id: string; size: "sm" | "md" | "lg" }> {
  if (!Array.isArray(input)) return [];
  const out: Array<{ id: string; size: "sm" | "md" | "lg" }> = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const id = (raw as { id?: unknown }).id;
    const size = (raw as { size?: unknown }).size;
    if (typeof id !== "string" || id.length === 0 || id.length > 64) continue;
    if (typeof size !== "string" || !ALLOWED_SIZES.has(size)) continue;
    if (seen.has(id)) continue;     // dedupe — a widget appears at most once
    seen.add(id);
    out.push({ id, size: size as "sm" | "md" | "lg" });
    if (out.length >= 60) break;    // hard cap so a hostile payload can't blow up
  }
  return out;
}

dashboardRouter.get("/layout", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [row] = await db
      .select({ layout: dashboardLayouts.layout, updated_at: dashboardLayouts.updated_at })
      .from(dashboardLayouts)
      .where(eq(dashboardLayouts.user_id, req.user!.id))
      .limit(1);
    res.json({
      layout: row?.layout ?? null,             // null → frontend uses its default
      updated_at: row?.updated_at ?? null,
    });
  } catch (err) { next(err); }
});

dashboardRouter.put("/layout", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const layout = sanitizeLayout(req.body?.layout);
    await db
      .insert(dashboardLayouts)
      .values({ user_id: req.user!.id, layout, updated_at: new Date() })
      .onConflictDoUpdate({
        target: dashboardLayouts.user_id,
        set: { layout, updated_at: new Date() },
      });
    res.json({ ok: true, layout });
  } catch (err) { next(err); }
});

dashboardRouter.delete("/layout", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    await db.delete(dashboardLayouts).where(eq(dashboardLayouts.user_id, req.user!.id));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// FY helper now lives in lib/fy.ts (single source of truth). The previous
// local copy had a corrupted en-dash byte sequence that rendered as
// "FY 2026 - 27" mojibake in the dashboard CPE badge.

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
      // numeric() comes back as string from postgres-js - coerce to number on read.
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
