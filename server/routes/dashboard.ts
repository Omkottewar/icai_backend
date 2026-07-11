import { Router } from "express";
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, notInArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../db/client.js";
import {
  events,
  eventRegistrations,
  memberProfiles,
  studentProfiles,
  dashboardLayouts,
  announcements,
  resourceBookmarks,
  paperPresentations,
  ejournalIssues,
  committees,
  files,
  users,
} from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { currentFy } from "../lib/fy.js";
import { storage } from "../lib/storage.js";

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

// Multiple dashboard surfaces (chairman insights, treasurer insights, …)
// share this endpoint via the ?scope= query. Unknown / missing scopes fall
// back to 'chairman' so pre-scope callers keep working unchanged.
const ALLOWED_SCOPES = new Set(["chairman", "treasurer"]);
function resolveScope(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  return ALLOWED_SCOPES.has(s) ? s : "chairman";
}

dashboardRouter.get("/layout", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const scope = resolveScope(req.query.scope);
    const [row] = await db
      .select({ layout: dashboardLayouts.layout, updated_at: dashboardLayouts.updated_at })
      .from(dashboardLayouts)
      .where(and(
        eq(dashboardLayouts.user_id, req.user!.id),
        eq(dashboardLayouts.scope, scope),
      ))
      .limit(1);
    res.json({
      layout: row?.layout ?? null,             // null → frontend uses its default
      updated_at: row?.updated_at ?? null,
    });
  } catch (err) { next(err); }
});

dashboardRouter.put("/layout", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const scope = resolveScope(req.query.scope);
    const layout = sanitizeLayout(req.body?.layout);
    await db
      .insert(dashboardLayouts)
      .values({ user_id: req.user!.id, scope, layout, updated_at: new Date() })
      .onConflictDoUpdate({
        target: [dashboardLayouts.user_id, dashboardLayouts.scope],
        set: { layout, updated_at: new Date() },
      });
    res.json({ ok: true, layout });
  } catch (err) { next(err); }
});

dashboardRouter.delete("/layout", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const scope = resolveScope(req.query.scope);
    await db.delete(dashboardLayouts).where(and(
      eq(dashboardLayouts.user_id, req.user!.id),
      eq(dashboardLayouts.scope, scope),
    ));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// FY helper now lives in lib/fy.ts (single source of truth). The previous
// local copy had a corrupted en-dash byte sequence that rendered as
// "FY 2026 - 27" mojibake in the dashboard CPE badge.

/** Upcoming events the current user is registered/waitlisted for.
 *  Includes `booked_by_name` when someone else paid for this seat so the
 *  dashboard can show a "Booked by CA X" chip on the event card. */
async function getUpcomingEvents(userId: string, now: Date) {
  const bookerUsers = alias(users, "booker_users");
  return db
    .select({
      id: events.id,
      slug: events.slug,
      title: events.title,
      starts_at: events.starts_at,
      ends_at: events.ends_at,
      cpe_hours: events.cpe_hours,
      mode: events.mode,
      venue: events.venue,
      status: eventRegistrations.status,
      booked_by_user_id: eventRegistrations.booked_by_user_id,
      booked_by_name:    bookerUsers.name,
    })
    .from(eventRegistrations)
    .innerJoin(events, eq(events.id, eventRegistrations.event_id))
    .leftJoin(bookerUsers, eq(bookerUsers.id, eventRegistrations.booked_by_user_id))
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

// Past events the user attended — eligible for attendance certificate
// download. Capped at 10 most recent for the dashboard tile; fuller
// "all certificates" history can come later as a dedicated page.
async function getRecentCertificates(userId: string) {
  return db
    .select({
      id: events.id,
      slug: events.slug,
      title: events.title,
      starts_at: events.starts_at,
      cpe_hours: events.cpe_hours,
    })
    .from(eventRegistrations)
    .innerJoin(events, eq(events.id, eventRegistrations.event_id))
    .where(
      and(
        eq(eventRegistrations.user_id, userId),
        isNull(eventRegistrations.deleted_at),
        isNull(events.deleted_at),
        eq(eventRegistrations.status, "attended"),
      ),
    )
    .orderBy(desc(events.starts_at))
    .limit(10);
}

dashboardRouter.get("/", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    const now = new Date();
    const upcomingEvents = await getUpcomingEvents(user.id, now);
    const recentCertificates = user.primary_role === "member"
      ? await getRecentCertificates(user.id)
      : [];

    if (user.primary_role === "member") {
      // Profile + phone in one round-trip so the dashboard payload has
      // everything the edit drawer needs without a follow-up fetch.
      const [profileRow] = await db
        .select({
          user_id: memberProfiles.user_id,
          mrn: memberProfiles.mrn,
          is_fca: memberProfiles.is_fca,
          cop_status: memberProfiles.cop_status,
          cop_number: memberProfiles.cop_number,
          is_practising: memberProfiles.is_practising,
          gender: memberProfiles.gender,
          member_since: memberProfiles.member_since,
          areas_of_practice: memberProfiles.areas_of_practice,
          address: memberProfiles.address,
          city: memberProfiles.city,
          pincode: memberProfiles.pincode,
          phone: users.phone,
        })
        .from(memberProfiles)
        .innerJoin(users, eq(users.id, memberProfiles.user_id))
        .where(
          and(eq(memberProfiles.user_id, user.id), isNull(memberProfiles.deleted_at)),
        )
        .limit(1);
      const profile = profileRow ?? null;

      const fy = currentFy(now);

      // CPE feature removed in migration 0087 — the upstream ICAI publish
      // API is no longer available, so the branch stopped tracking hours.

      // Run the four "extras" in parallel — they're independent reads and
      // each is cheap, so the request stays well under 100ms.
      const [
        eventsAttendedFyRow,
        bookmarkCountRow,
        bookmarkRows,
        announcementRows,
        registeredEventIdRows,
      ] = await Promise.all([
        // Events attended in current FY (drives stat tile).
        db.select({ count: sql<number>`count(*)::int`.as("count") })
          .from(eventRegistrations)
          .innerJoin(events, eq(events.id, eventRegistrations.event_id))
          .where(and(
            eq(eventRegistrations.user_id, user.id),
            eq(eventRegistrations.status, "attended"),
            isNull(eventRegistrations.deleted_at),
            gte(events.starts_at, fy.start),
            lt(events.starts_at, fy.end),
          )),
        // Total saved papers/issues count for the stats row.
        db.select({ count: sql<number>`count(*)::int`.as("count") })
          .from(resourceBookmarks)
          .where(eq(resourceBookmarks.user_id, user.id)),
        // Three most-recent bookmarks for the My Library teaser.
        db.select({
            id: resourceBookmarks.id,
            resource_type: resourceBookmarks.resource_type,
            resource_id: resourceBookmarks.resource_id,
            created_at: resourceBookmarks.created_at,
          })
          .from(resourceBookmarks)
          .where(eq(resourceBookmarks.user_id, user.id))
          .orderBy(desc(resourceBookmarks.created_at))
          .limit(3),
        // Active announcements scoped to "all" or "members".
        db.select({
            id: announcements.id,
            title: announcements.title,
            body: announcements.body,
            link_url: announcements.link_url,
            starts_at: announcements.starts_at,
          })
          .from(announcements)
          .where(and(
            isNull(announcements.deleted_at),
            inArray(announcements.audience, ["all", "members"]),
            lte(announcements.starts_at, now),
            or(isNull(announcements.ends_at), gt(announcements.ends_at, now)),
          ))
          .orderBy(asc(announcements.display_order), desc(announcements.created_at))
          .limit(3),
        // Event ids the user is already registered for (used to suggest
        // *other* upcoming events).
        db.select({ event_id: eventRegistrations.event_id })
          .from(eventRegistrations)
          .where(and(
            eq(eventRegistrations.user_id, user.id),
            isNull(eventRegistrations.deleted_at),
            inArray(eventRegistrations.status, ["registered", "waitlisted", "attended"]),
          )),
      ]);

      // Hydrate bookmark rows with title + cover for the dashboard teaser.
      const paperIds = bookmarkRows.filter((b) => b.resource_type === "paper").map((b) => b.resource_id);
      const journalIds = bookmarkRows.filter((b) => b.resource_type === "ejournal").map((b) => b.resource_id);
      const [paperHits, journalHits] = await Promise.all([
        paperIds.length === 0 ? Promise.resolve([] as any[]) :
          db.select({
              id: paperPresentations.id, slug: paperPresentations.slug,
              title: paperPresentations.title, speaker_name: paperPresentations.speaker_name,
              cover_path: files.storage_path,
            })
            .from(paperPresentations)
            .leftJoin(files, eq(files.id, paperPresentations.cover_file_id))
            .where(inArray(paperPresentations.id, paperIds)),
        journalIds.length === 0 ? Promise.resolve([] as any[]) :
          db.select({
              id: ejournalIssues.id, slug: ejournalIssues.slug,
              title: ejournalIssues.title, issue_label: ejournalIssues.issue_label,
              cover_path: files.storage_path,
            })
            .from(ejournalIssues)
            .leftJoin(files, eq(files.id, ejournalIssues.cover_file_id))
            .where(inArray(ejournalIssues.id, journalIds)),
      ]);
      const paperMap = new Map<string, any>(paperHits.map((p) => [p.id, p]));
      const journalMap = new Map<string, any>(journalHits.map((j) => [j.id, j]));
      const recentBookmarks = bookmarkRows
        .map((b) => {
          if (b.resource_type === "paper") {
            const p = paperMap.get(b.resource_id);
            if (!p) return null;
            return {
              bookmark_id: b.id, resource_type: "paper" as const,
              slug: p.slug, title: p.title, subtitle: p.speaker_name,
              cover_url: p.cover_path ? storage().url(p.cover_path) : null,
            };
          }
          const j = journalMap.get(b.resource_id);
          if (!j) return null;
          return {
            bookmark_id: b.id, resource_type: "ejournal" as const,
            slug: j.slug, title: j.title, subtitle: j.issue_label,
            cover_url: j.cover_path ? storage().url(j.cover_path) : null,
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null);

      // Suggested upcoming events the user isn't already on. Audience scope
      // includes 'all' + 'members'. We exclude every event they've ever
      // touched (registered/waitlisted/attended) so the list is genuinely
      // new to them.
      //
      // Personalisation: when the member has `areas_of_practice` filled in
      // ("GST", "Direct Tax", …) we score each candidate by how well its
      // committee code matches one of those areas (case-insensitive). The
      // top 3 highest-scoring rows come back; ties break by date. Members
      // without areas of practice just get the next-3-chronological — same
      // behaviour as before.
      const registeredIds = registeredEventIdRows.map((r) => r.event_id);
      const areas = (profile?.areas_of_practice ?? []).filter((a): a is string => !!a);
      const suggestedConds = [
        isNull(events.deleted_at),
        eq(events.status, "published"),
        gt(events.starts_at, now),
        inArray(events.audience, ["all", "members"] as any),
      ];
      if (registeredIds.length > 0) {
        suggestedConds.push(notInArray(events.id, registeredIds));
      }
      // `match_score` is 1 when a committee code matches one of the
      // member's areas of practice (lower(code) IN (lower(area), ...)),
      // 0 otherwise. Sort by it desc, then by date asc.
      //
      // Two important details about the empty case:
      //   • We *omit* the score from ORDER BY when areas is empty. A bare
      //     literal `0` in ORDER BY is interpreted by Postgres as
      //     "ordinal column position 0" (positions start at 1) and the
      //     query errors with 42P10 — we hit that bug in dev before
      //     guarding here.
      //   • We *omit* the score from SELECT too in that case so the row
      //     shape stays clean; the frontend doesn't read it anyway.
      const personalised = areas.length > 0;
      const matchScoreSql = personalised
        ? sql<number>`case when lower(${committees.code}) in (${sql.join(areas.map((a) => sql`lower(${a})`), sql`, `)}) then 1 else 0 end`
        : null;
      const baseCols = {
        id: events.id, slug: events.slug, title: events.title,
        starts_at: events.starts_at, cpe_hours: events.cpe_hours,
        mode: events.mode, venue: events.venue,
        committee_code: committees.code,
      };
      const suggestedEvents = await (personalised
        ? db
            .select({ ...baseCols, match_score: matchScoreSql!.as("match_score") })
            .from(events)
            .leftJoin(committees, eq(committees.id, events.committee_id))
            .where(and(...suggestedConds))
            .orderBy(desc(matchScoreSql!), asc(events.starts_at))
            .limit(3)
        : db
            .select(baseCols)
            .from(events)
            .leftJoin(committees, eq(committees.id, events.committee_id))
            .where(and(...suggestedConds))
            .orderBy(asc(events.starts_at))
            .limit(3));

      return res.json({
        role: "member",
        profile: profile
          ? {
              mrn: profile.mrn,
              is_fca: profile.is_fca,
              cop_status: profile.cop_status,
              cop_number: profile.cop_number,
              is_practising: profile.is_practising,
              gender: profile.gender,
              member_since: profile.member_since,
              address: profile.address,
              city: profile.city,
              pincode: profile.pincode,
              areas_of_practice: profile.areas_of_practice,
              phone: profile.phone,
            }
          : null,
        upcomingEvents,
        recentCertificates,
        eventsAttendedFy: eventsAttendedFyRow[0]?.count ?? 0,
        bookmarksCount: bookmarkCountRow[0]?.count ?? 0,
        recentBookmarks,
        announcements: announcementRows,
        suggestedEvents,
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
