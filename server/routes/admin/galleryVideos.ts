import { Router } from "express";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { galleryVideos } from "../../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const galleryVideosAdminRouter = Router();

const VISIBILITIES = new Set(["public", "members", "private"]);
const PROVIDERS    = new Set(["youtube", "vimeo", "external"]);
const EVENT_TYPES  = new Set(["Technical", "Cultural", "Sports", "Press", "Social", "Visit", "Other"]);

function parseDate(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new ApiError(400, "Invalid date");
  return d.toISOString().slice(0, 10);
}

// Extract the bare ID from a pasted YouTube/Vimeo URL so admins can drop in
// any of the common share-URL shapes without manually trimming. Returns the
// original input if we don't recognise the shape — the public page will
// still try to embed it as-is for `external` provider.
function extractYouTubeId(input: string): string {
  const s = input.trim();
  const m1 = s.match(/[?&]v=([A-Za-z0-9_-]{6,})/);
  if (m1) return m1[1];
  const m2 = s.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/);
  if (m2) return m2[1];
  const m3 = s.match(/youtube\.com\/embed\/([A-Za-z0-9_-]{6,})/);
  if (m3) return m3[1];
  const m4 = s.match(/youtube\.com\/shorts\/([A-Za-z0-9_-]{6,})/);
  if (m4) return m4[1];
  return s;
}

function extractVimeoId(input: string): string {
  const s = input.trim();
  const m = s.match(/vimeo\.com\/(?:video\/)?(\d{6,})/);
  return m ? m[1] : s;
}

function parseBody(input: any) {
  const provider = PROVIDERS.has(trim(input.provider)) ? trim(input.provider) : "youtube";
  const rawId = need(trim(input.video_id) || trim(input.video_url), "video_id or video_url");

  let video_id = rawId;
  if (provider === "youtube") video_id = extractYouTubeId(rawId);
  else if (provider === "vimeo") video_id = extractVimeoId(rawId);

  const vis = trim(input.visibility);
  const eventType = trim(input.event_type);
  const duration  = Number(input.duration_secs);

  return {
    title:          need(trim(input.title), "Title"),
    description:    trim(input.description) || null,
    provider,
    video_id,
    video_url:      trim(input.video_url) || null,
    poster_file_id: trim(input.poster_file_id) || null,
    event_id:       trim(input.event_id) || null,
    committee_tag:  trim(input.committee_tag) || null,
    event_type:     EVENT_TYPES.has(eventType) ? eventType : null,
    occurred_on:    parseDate(input.occurred_on),
    duration_secs:  Number.isFinite(duration) && duration > 0 ? Math.trunc(duration) : null,
    visibility:     VISIBILITIES.has(vis) ? vis : "public",
    hidden:         !!input.hidden,
    is_featured:    !!input.is_featured,
    sort_order:     Number.isFinite(Number(input.sort_order))
                      ? Math.trunc(Number(input.sort_order)) : 0,
  };
}

galleryVideosAdminRouter.get("/", async (_req, res, next) => {
  try {
    const rows = await db.select().from(galleryVideos)
      .orderBy(asc(galleryVideos.sort_order), desc(galleryVideos.occurred_on));
    res.json({ items: rows });
  } catch (err) { next(err); }
});

galleryVideosAdminRouter.get("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.select().from(galleryVideos).where(eq(galleryVideos.id, id));
    if (!row) throw new ApiError(404, "Video not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

galleryVideosAdminRouter.post("/", async (req, res, next) => {
  try {
    const [row] = await db.insert(galleryVideos).values(parseBody(req.body)).returning();
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

galleryVideosAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.update(galleryVideos)
      .set({ ...parseBody(req.body), updated_at: new Date() })
      .where(eq(galleryVideos.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Video not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

galleryVideosAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.delete(galleryVideos).where(eq(galleryVideos.id, id)).returning();
    if (!row) throw new ApiError(404, "Video not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
