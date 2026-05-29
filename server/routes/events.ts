import { Router } from "express";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { events, committees, files } from "../../schema/index.js";
import { handleApiError, ApiError, trim } from "../lib/apiError.js";

export const publicEventsRouter = Router();

// â”€â”€â”€ GET /api/events â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Public, no auth. Returns published, non-deleted, future events with the
// committee name + banner URL joined for direct rendering.
publicEventsRouter.get("/", async (req, res, next) => {
  try {
    const audience = trim(req.query.audience);
    const committeeCode = trim(req.query.committee);

    const conds = [
      isNull(events.deleted_at),
      eq(events.status, "published"),
      gt(events.starts_at, new Date()),
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
        capacity: events.capacity,
        registered_count: events.registered_count,
        banner_path: files.storagePath,
        program_type: events.program_type,
        highlights: events.highlights,
      })
      .from(events)
      .leftJoin(committees, eq(committees.id, events.committee_id))
      .leftJoin(files, eq(files.id, events.banner_id))
      .where(and(...conds))
      .orderBy(asc(events.starts_at));

    res.json({
      rows: rows.map((r) => ({
        ...r,
        banner_url: r.banner_path ? `/uploads/${r.banner_path}` : null,
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
        capacity: events.capacity,
        registered_count: events.registered_count,
        banner_path: files.storagePath,
        program_type: events.program_type,
        highlights: events.highlights,
        status: events.status,
      })
      .from(events)
      .leftJoin(committees, eq(committees.id, events.committee_id))
      .leftJoin(files, eq(files.id, events.banner_id))
      .where(and(eq(events.slug, req.params.slug), isNull(events.deleted_at)))
      .limit(1);

    if (!row || row.status !== "published") throw new ApiError(404, "Event not found");

    res.json({
      ...row,
      banner_url: row.banner_path ? `/uploads/${row.banner_path}` : null,
    });
  } catch (err) { handleApiError(err, res, next); }
});
