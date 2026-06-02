import { Router } from "express";
import { and, asc, desc, gt, isNull, or, lte, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { announcements } from "../../schema/index.js";

export const announcementsRouter = Router();

// ─── GET /api/announcements ───────────────────────────────────────────────
// Public list of currently-active announcements. Used by the home page
// ticker. "Active" means starts_at ≤ now AND (ends_at IS NULL OR ends_at > now)
// AND deleted_at IS NULL.
//
// Ordered by display_order asc, then created_at desc — admin can manually
// pin items by setting display_order, and ties fall back to "newest first".
announcementsRouter.get("/", async (_req, res, next) => {
  try {
    const now = new Date();
    const rows = await db
      .select({
        id: announcements.id,
        title: announcements.title,
        body: announcements.body,
        link_url: announcements.link_url,
        audience: announcements.audience,
        starts_at: announcements.starts_at,
        ends_at: announcements.ends_at,
      })
      .from(announcements)
      .where(
        and(
          isNull(announcements.deleted_at),
          lte(announcements.starts_at, now),
          or(isNull(announcements.ends_at), gt(announcements.ends_at, now)),
        ),
      )
      .orderBy(asc(announcements.display_order), desc(announcements.created_at))
      .limit(20);
    res.set("cache-control", "public, max-age=60"); // 1-minute edge cache
    res.json({ items: rows });
  } catch (err) {
    next(err);
  }
});
