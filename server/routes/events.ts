import { Router } from "express";
import { and, asc, desc, eq, gt, isNull, lte, or } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../db/client.js";
import { events, committees, files } from "../../schema/index.js";
import { handleApiError, ApiError, trim } from "../lib/apiError.js";
import { storage } from "../lib/storage.js";

// We need to join `files` twice in the same query (once for the event banner,
// once for the speaker photo). Drizzle requires a table alias to disambiguate.
const bannerFiles  = alias(files, "banner_files");
const speakerFiles = alias(files, "speaker_files");

export const publicEventsRouter = Router();

// â”€â”€â”€ GET /api/events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Public, no auth. Returns published, non-deleted, future events with the
// committee name + banner URL joined for direct rendering.
publicEventsRouter.get("/", async (req, res, next) => {
  try {
    const audience = trim(req.query.audience);
    const committeeCode = trim(req.query.committee);
    // ?past=1 returns events that have already finished (ends_at in the
    // past, falling back to starts_at for legacy rows where ends_at is
    // null). Default behaviour (no flag) returns upcoming-only — the
    // original contract every existing caller relies on.
    const wantsPast = trim(req.query.past) === "1";
    const now = new Date();

    const conds = [
      isNull(events.deleted_at),
      eq(events.status, "published"),
      wantsPast
        ? or(
            lte(events.ends_at, now),
            and(isNull(events.ends_at), lte(events.starts_at, now)),
          )
        : gt(events.starts_at, now),
    ];
    if (audience === "members" || audience === "students" || audience === "all") {
      conds.push(eq(events.audience, audience as any));
    }
    if (committeeCode) {
      conds.push(eq(committees.code, committeeCode));
    }

    const rows = await db
      .select({
        id: events.id,
        slug: events.slug,
        title: events.title,
        description: events.description,
        committee_id: events.committee_id,
        committee_code: committees.code,
        committee_name: committees.name,
        audience: events.audience,
        mode: events.mode,
        venue: events.venue,
        online_url: events.online_url,
        starts_at: events.starts_at,
        ends_at: events.ends_at,
        cpe_hours: events.cpe_hours,
        fee_paise: events.fee_paise,
        gst_applicable: events.gst_applicable,
        gst_percent: events.gst_percent,
        capacity: events.capacity,
        registered_count: events.registered_count,
        banner_path: bannerFiles.storage_path,
        program_type: events.program_type,
        highlights: events.highlights,
        speaker_name: events.speaker_name,
        speaker_bio: events.speaker_bio,
        speaker_photo_path: speakerFiles.storage_path,
      })
      .from(events)
      .leftJoin(committees, eq(committees.id, events.committee_id))
      .leftJoin(bannerFiles,  eq(bannerFiles.id,  events.banner_id))
      .leftJoin(speakerFiles, eq(speakerFiles.id, events.speaker_photo_id))
      .where(and(...conds))
      // Upcoming: soonest first (asc) so members see what's next.
      // Past: most-recent first (desc) so the archive's freshest content
      // sits at the top — feels like a chronological feed.
      .orderBy(wantsPast ? desc(events.starts_at) : asc(events.starts_at));

    res.json({
      rows: rows.map((r) => ({
        ...r,
        banner_url: r.banner_path ? storage().url(r.banner_path) : null,
        speaker_photo_url: r.speaker_photo_path ? storage().url(r.speaker_photo_path) : null,
      })),
    });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ GET /api/events/:slug â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
publicEventsRouter.get("/:slug", async (req, res, next) => {
  try {
    const [row] = await db
      .select({
        id: events.id,
        slug: events.slug,
        title: events.title,
        description: events.description,
        committee_code: committees.code,
        committee_name: committees.name,
        audience: events.audience,
        mode: events.mode,
        venue: events.venue,
        online_url: events.online_url,
        starts_at: events.starts_at,
        ends_at: events.ends_at,
        cpe_hours: events.cpe_hours,
        fee_paise: events.fee_paise,
        gst_applicable: events.gst_applicable,
        gst_percent: events.gst_percent,
        capacity: events.capacity,
        registered_count: events.registered_count,
        banner_path: bannerFiles.storage_path,
        program_type: events.program_type,
        highlights: events.highlights,
        status: events.status,
        speaker_name: events.speaker_name,
        speaker_bio: events.speaker_bio,
        speaker_photo_path: speakerFiles.storage_path,
      })
      .from(events)
      .leftJoin(committees, eq(committees.id, events.committee_id))
      .leftJoin(bannerFiles,  eq(bannerFiles.id,  events.banner_id))
      .leftJoin(speakerFiles, eq(speakerFiles.id, events.speaker_photo_id))
      .where(and(eq(events.slug, req.params.slug), isNull(events.deleted_at)))
      .limit(1);

    if (!row || row.status !== "published") throw new ApiError(404, "Event not found");

    res.json({
      ...row,
      banner_url: row.banner_path ? storage().url(row.banner_path) : null,
      speaker_photo_url: row.speaker_photo_path ? storage().url(row.speaker_photo_path) : null,
    });
  } catch (err) { handleApiError(err, res, next); }
});
