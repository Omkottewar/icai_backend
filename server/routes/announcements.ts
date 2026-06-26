import { Router } from "express";
import { and, asc, desc, eq, gt, isNull, or, lte } from "drizzle-orm";
import { db } from "../../db/client.js";
import { announcements, files } from "../../schema/index.js";
import { storage } from "../lib/storage.js";

export const announcementsRouter = Router();

// Helper: turn a row's storage_path into a public URL (or null if no file).
const fileUrl = (path: string | null | undefined) =>
  path ? storage().url(path) : null;

// ─── GET /api/announcements ───────────────────────────────────────────────
// Public list of currently-active announcements. Used by the home page
// ticker AND the /announcements archive page. "Active" means
// starts_at ≤ now AND (ends_at IS NULL OR ends_at > now) AND deleted_at IS NULL.
//
// Joined with the files table so the response includes file_url +
// file_mime_type for announcements that have a PDF (or any file) attached.
// The frontend prefers file_url over link_url when both are set.
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
        file_id: announcements.file_id,
        file_storage_path: files.storage_path,
        file_mime_type: files.mime_type,
        file_name: files.name,
      })
      .from(announcements)
      .leftJoin(files, eq(files.id, announcements.file_id))
      .where(
        and(
          isNull(announcements.deleted_at),
          lte(announcements.starts_at, now),
          or(isNull(announcements.ends_at), gt(announcements.ends_at, now)),
        ),
      )
      .orderBy(asc(announcements.display_order), desc(announcements.created_at))
      .limit(20);

    const items = rows.map((r) => ({
      id: r.id,
      title: r.title,
      body: r.body,
      link_url: r.link_url,
      audience: r.audience,
      starts_at: r.starts_at,
      ends_at: r.ends_at,
      // Public URL the frontend can link to directly. Null when no file
      // is attached. The storage path is intentionally not exposed.
      file_url: fileUrl(r.file_storage_path),
      file_mime_type: r.file_mime_type,
      file_name: r.file_name,
    }));

    res.set("cache-control", "public, max-age=60"); // 1-minute edge cache
    res.json({ items });
  } catch (err) {
    next(err);
  }
});
