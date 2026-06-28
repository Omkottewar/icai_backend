import { Router } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { files } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { storage } from "../../lib/storage.js";
import { isImageMime, processImageUpload } from "../../lib/imagePipeline.js";
import { randomUUID } from "node:crypto";

export const filesAdminRouter = Router();

// Image types pass through the sharp pipeline (variants + EXIF strip).
// Non-image types we just write straight to storage as-is.
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "application/pdf",
  // Video types — used for event banners. Cross-browser playable formats
  // only. MOV is accepted because iPhone camera output is MOV; everything
  // else (avi, mkv, wmv) is intentionally excluded since browsers can't
  // play them inline.
  "video/mp4", "video/webm", "video/quicktime",
]);
const VIDEO_MIMES = new Set(["video/mp4", "video/webm", "video/quicktime"]);
// Per-type size caps. Images are tiny after the sharp pipeline; videos
// need real headroom. The express.json body limit in server/index.ts must
// be at least 1.4× whichever is bigger here (base64 overhead).
//
// Note for longer recordings: the in-event banner is meant for short
// teaser clips (30–90 sec). Full seminar / AGM recordings should be
// uploaded to YouTube and added via /admin/gallery-videos (Video Gallery,
// F22) — that path has no size cap and gives members a proper streaming
// player instead of a download-then-play banner.
const MAX_IMAGE_BYTES = 6   * 1024 * 1024;   //   6 MB
const MAX_VIDEO_BYTES = 100 * 1024 * 1024;   // 100 MB

// ─── POST /api/admin/files ────────────────────────────────────────────────────
// Body: { name, mime_type, bucket, data_base64, alt_text? }
//
// Images go through the sharp pipeline:
//   - EXIF stripped (privacy + smaller files)
//   - resized to a max width of 2400 (so a 50 MP camera dump doesn't blow up storage)
//   - re-encoded to WebP for the original + two variants (thumb 240, medium 800)
//
// Non-images (PDFs, etc.) are written as-is.
//
// Response includes `url`, `thumb_url`, `medium_url` — callers should prefer
// the thumb/medium variants in <img> tags and only hit the original for
// downloads.
filesAdminRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const name     = need(trim(req.body.name), "Filename");
    const mimeType = need(trim(req.body.mime_type), "MIME type");
    const bucket   = trim(req.body.bucket) || "banners";
    const altText  = trim(req.body.alt_text) || null;
    const dataB64: string = typeof req.body.data_base64 === "string" ? req.body.data_base64 : "";

    if (!dataB64) throw new ApiError(400, "File data is required");
    if (!ALLOWED_MIME.has(mimeType)) throw new ApiError(400, "Unsupported file type");

    const stripped = dataB64.replace(/^data:[^;]+;base64,/, "");
    const buf = Buffer.from(stripped, "base64");
    if (buf.length === 0) throw new ApiError(400, "File data is empty or invalid base64");
    const isVideo = VIDEO_MIMES.has(mimeType);
    const cap = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (buf.length > cap) {
      throw new ApiError(400, `File exceeds ${Math.round(cap / (1024 * 1024))} MB limit`);
    }

    let storage_path: string;
    let thumb_path: string | null = null;
    let medium_path: string | null = null;
    let width: number | null = null;
    let height: number | null = null;
    let finalMime = mimeType;
    let finalSize = buf.length;

    if (isImageMime(mimeType)) {
      const processed = await processImageUpload(buf, bucket, mimeType);
      storage_path = processed.storage_path;
      thumb_path   = processed.thumb_path;
      medium_path  = processed.medium_path;
      width        = processed.width;
      height       = processed.height;
      finalMime    = processed.mime_type;
      finalSize    = processed.size_bytes;
    } else {
      // Non-image (PDF, etc.) — straight write, no processing.
      const ext = (name.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? "").toLowerCase();
      const filename = `${randomUUID()}${ext}`;
      storage_path = await storage().put(bucket, filename, buf, mimeType);
    }

    const [row] = await db.insert(files).values({
      name,
      mime_type:    finalMime,
      size_bytes:   finalSize,
      storage_path,
      bucket,
      thumb_path,
      medium_path,
      width,
      height,
      alt_text:     altText,
      uploaded_by:  req.user!.id,
    }).returning();

    res.status(201).json({
      id:           row.id,
      bucket:       row.bucket,
      storage_path: row.storage_path,
      url:          storage().url(row.storage_path),
      thumb_url:    row.thumb_path  ? storage().url(row.thumb_path)  : null,
      medium_url:   row.medium_path ? storage().url(row.medium_path) : null,
      width:        row.width,
      height:       row.height,
      size_bytes:   row.size_bytes,
      mime_type:    row.mime_type,
      name:         row.name,
      alt_text:     row.alt_text,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/admin/files/:id ─────────────────────────────────────────────
// Lets the gallery admin edit alt text without re-uploading. Other fields are
// immutable — replace, don't mutate.
filesAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const altText = trim(req.body.alt_text);
    const [row] = await db.update(files)
      .set({ alt_text: altText || null })
      .where(and(eq(files.id, id), isNull(files.deleted_at)))
      .returning();
    if (!row) throw new ApiError(404, "File not found");
    res.json({ ok: true, alt_text: row.alt_text });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/admin/files/:id ──────────────────────────────────────────────
// Soft-delete on the DB row + best-effort hard-delete of bytes from storage.
// The storage delete is fire-and-forget — orphans are okay since the row that
// pointed to them is gone.
filesAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const [row] = await db.update(files)
      .set({ deleted_at: new Date() })
      .where(and(eq(files.id, req.params.id), isNull(files.deleted_at)))
      .returning();
    if (!row) throw new ApiError(404, "File not found");

    const paths = [row.storage_path, row.thumb_path, row.medium_path].filter(Boolean) as string[];
    await Promise.all(paths.map((p) => storage().remove(p).catch(() => {})));

    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
