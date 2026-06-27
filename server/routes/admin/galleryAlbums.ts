import { Router } from "express";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { galleryAlbums, galleryPhotos, files } from "../../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { storage } from "../../lib/storage.js";

const adminFileUrl = (p: string | null) => (p ? storage().url(p) : null);

export const galleryAdminRouter = Router();

function parseDate(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new ApiError(400, "Invalid date");
  return d.toISOString().slice(0, 10);
}

const VISIBILITIES = new Set(["public", "members", "private"]);
const LAYOUTS      = new Set(["grid", "masonry", "story"]);
const EVENT_TYPES  = new Set(["Technical", "Cultural", "Sports", "Press", "Social", "Visit", "Other"]);

function parseAlbumBody(input: any) {
  const vis = trim(input.visibility);
  const layout = trim(input.layout);
  const eventType = trim(input.event_type);
  // Featured position is 1..4 (1 = hero, 2-4 = sidekick tiles). Anything
  // else collapses to null so a bad payload can't violate the CHECK
  // constraint and 500 the admin save.
  const rawPos = Number(input.featured_position);
  const featured_position = Number.isFinite(rawPos) && rawPos >= 1 && rawPos <= 4
    ? Math.trunc(rawPos) : null;
  const is_featured = !!input.is_featured && featured_position !== null;
  return {
    title:        need(trim(input.title), "Title"),
    event_id:     trim(input.event_id)      || null,
    committee_tag: trim(input.committee_tag) || null,
    event_type:    EVENT_TYPES.has(eventType) ? eventType : null,
    occurred_on:  parseDate(input.occurred_on),
    description:  trim(input.description)   || null,
    cover_file_id: trim(input.cover_file_id) || null,
    visibility:   VISIBILITIES.has(vis) ? vis : "public",
    hidden:     !!input.hidden,
    sort_order: Number.isFinite(Number(input.sort_order))
                  ? Math.trunc(Number(input.sort_order))
                  : 0,
    // ── New layout / featured fields (migration 0061) ───────────────
    is_featured,
    featured_position,
    layout: LAYOUTS.has(layout) ? layout : "grid",
  };
}

// ─── ALBUMS ────────────────────────────────────────────────────────────────────

galleryAdminRouter.get("/", async (_req, res, next) => {
  try {
    const rows = await db.select().from(galleryAlbums)
      .orderBy(asc(galleryAlbums.sort_order), desc(galleryAlbums.occurred_on));
    res.json({ items: rows });
  } catch (err) { next(err); }
});

galleryAdminRouter.get("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [album] = await db.select().from(galleryAlbums).where(eq(galleryAlbums.id, id));
    if (!album) throw new ApiError(404, "Album not found");
    // Join files so the admin can see thumbnails + edit alt text inline.
    const photos = await db.select({
      id:          galleryPhotos.id,
      file_id:     galleryPhotos.file_id,
      caption:     galleryPhotos.caption,
      sort_order:  galleryPhotos.sort_order,
      is_featured: galleryPhotos.is_featured,
      path:        files.storage_path,
      thumb_path:  files.thumb_path,
      alt_text:    files.alt_text,
    })
      .from(galleryPhotos)
      .leftJoin(files, eq(files.id, galleryPhotos.file_id))
      .where(eq(galleryPhotos.album_id, id))
      .orderBy(asc(galleryPhotos.sort_order));

    res.json({
      album,
      photos: photos.map((p) => ({
        id:          p.id,
        file_id:     p.file_id,
        caption:     p.caption,
        sort_order:  p.sort_order,
        is_featured: p.is_featured,
        url:         adminFileUrl(p.path),
        thumb_url:   adminFileUrl(p.thumb_path) ?? adminFileUrl(p.path),
        alt:         p.alt_text ?? '',
      })),
    });
  } catch (err) { handleApiError(err, res, next); }
});

galleryAdminRouter.post("/", async (req, res, next) => {
  try {
    const [row] = await db.insert(galleryAlbums).values(parseAlbumBody(req.body)).returning();
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

galleryAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.update(galleryAlbums)
      .set({ ...parseAlbumBody(req.body), updated_at: new Date() })
      .where(eq(galleryAlbums.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Album not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

galleryAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.delete(galleryAlbums).where(eq(galleryAlbums.id, id)).returning();
    if (!row) throw new ApiError(404, "Album not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PHOTOS ────────────────────────────────────────────────────────────────────
// Photos are nested under their album. POSTing a photo accepts a list of
// already-uploaded file_ids — the admin uploads to /api/admin/files first,
// then attaches by ID. This matches the existing file-handling pattern.
//
// Reorder is a single POST that takes an ordered array of photo IDs and
// rewrites their sort_order in one transaction. Cleaner than N PATCH calls
// when the admin drags 30 photos around.

galleryAdminRouter.post("/:id/photos/reorder", async (req, res, next) => {
  try {
    const albumId = String(req.params.id);
    const ids: string[] = Array.isArray(req.body.photo_ids) ? req.body.photo_ids : [];
    if (ids.length === 0) throw new ApiError(400, "photo_ids array required");

    // One UPDATE per row in a single transaction. For ~100 photos this is
    // ~50ms total; if it ever becomes a bottleneck we can switch to a
    // single CASE statement.
    await db.transaction(async (tx) => {
      for (let i = 0; i < ids.length; i++) {
        await tx.update(galleryPhotos)
          .set({ sort_order: i })
          .where(and(eq(galleryPhotos.id, ids[i]), eq(galleryPhotos.album_id, albumId)));
      }
    });
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

galleryAdminRouter.post("/:id/photos", async (req, res, next) => {
  try {
    const albumId = String(req.params.id);
    const list = Array.isArray(req.body.photos) ? req.body.photos : [];
    if (list.length === 0) throw new ApiError(400, "No photos provided");

    const rows = await db.insert(galleryPhotos).values(
      list.map((p: any, i: number) => ({
        album_id:   albumId,
        file_id:    need(trim(p.file_id), "file_id"),
        caption:    trim(p.caption) || null,
        sort_order: Number.isFinite(Number(p.sort_order)) ? Math.trunc(Number(p.sort_order)) : i,
      })),
    ).returning();
    res.json({ items: rows });
  } catch (err) { handleApiError(err, res, next); }
});

galleryAdminRouter.patch("/:id/photos/:photoId", async (req, res, next) => {
  try {
    const photoId = String(req.params.photoId);
    // Build the patch incrementally — only update what the caller passed
    // so a "toggle is_featured" request doesn't accidentally blank the
    // caption or sort order. Lets the admin row-toggle without re-sending
    // every field.
    const patch: Record<string, unknown> = {};
    if (req.body.caption !== undefined)     patch.caption     = trim(req.body.caption) || null;
    if (req.body.sort_order !== undefined && Number.isFinite(Number(req.body.sort_order))) {
      patch.sort_order = Math.trunc(Number(req.body.sort_order));
    }
    if (req.body.is_featured !== undefined) patch.is_featured = !!req.body.is_featured;
    if (Object.keys(patch).length === 0) throw new ApiError(400, "Nothing to update");

    const [row] = await db.update(galleryPhotos).set(patch)
      .where(eq(galleryPhotos.id, photoId)).returning();
    if (!row) throw new ApiError(404, "Photo not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

galleryAdminRouter.delete("/:id/photos/:photoId", async (req, res, next) => {
  try {
    const photoId = String(req.params.photoId);
    const [row] = await db.delete(galleryPhotos).where(eq(galleryPhotos.id, photoId)).returning();
    if (!row) throw new ApiError(404, "Photo not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
