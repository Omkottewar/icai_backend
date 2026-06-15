import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { storage } from "./storage.js";

// Image processing pipeline used by /api/admin/files.
//
// On upload of an image, we generate two WebP variants alongside the original:
//   - thumb  ~240px wide  — used in grid tiles
//   - medium ~800px wide  — used in lightbox / cards
//
// The original is kept too (re-encoded if it's a wasteful PNG/large JPG, but
// otherwise written as-is) so that "Download original" remains lossless.
//
// EXIF is stripped on every variant — sharp does this by default unless you
// pass `withMetadata()`. GPS coordinates and camera serials should not leave
// the upload endpoint.
//
// `bucket` is the same bucket name the route asked for. Variants live in
// `<bucket>/<uuid>.webp`, with sibling `<uuid>-thumb.webp` and `<uuid>-md.webp`.
// We use one base filename per upload so cleanup / migration scripts can find
// all three variants by glob.

const THUMB_WIDTH  = 240;
const MEDIUM_WIDTH = 800;
const MAX_ORIGINAL = 2400;  // soft cap so a 50 MP camera dump doesn't blow up storage

const SUPPORTED_INPUT = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
]);

export function isImageMime(mime: string): boolean {
  return SUPPORTED_INPUT.has(mime);
}

export interface ProcessedImage {
  storage_path: string;      // original path
  thumb_path:   string;
  medium_path:  string;
  width:        number;
  height:       number;
  size_bytes:   number;      // size of original after processing
  mime_type:    string;      // what we ended up writing (could be webp)
}

/**
 * Process an image upload — strip EXIF, generate thumb + medium variants,
 * keep an original. Returns the storage paths + final dimensions.
 *
 * Animated GIFs are left as GIF (sharp's WebP can't keep animation on every
 * platform). All other input formats are re-encoded to WebP for the variants
 * and re-encoded to WebP for the original too (better compression at the
 * cost of "I uploaded a PNG and downloaded a WebP" — acceptable for an
 * event gallery, never for archival of designs).
 */
export async function processImageUpload(
  buffer: Buffer,
  bucket: string,
  inputMime: string,
): Promise<ProcessedImage> {
  const base = randomUUID();

  // The first sharp instance reads metadata; subsequent calls re-read the
  // buffer each time. Reading once and rotating gives us EXIF orientation
  // for free (phones tag photos with rotation metadata instead of rotating
  // pixels).
  const probe = sharp(buffer, { failOn: "none" });
  const meta = await probe.metadata();
  const isAnimatedGif = inputMime === "image/gif" && (meta.pages ?? 1) > 1;

  // Animated GIFs we leave alone — sharp's WebP output drops animation in
  // some sharp versions. Store the original as-is + a still WebP thumb.
  if (isAnimatedGif) {
    const originalPath = await storage().put(bucket, `${base}.gif`, buffer, "image/gif");
    const thumbBuf = await sharp(buffer, { animated: false })
      .rotate()
      .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
    const thumbPath = await storage().put(bucket, `${base}-thumb.webp`, thumbBuf, "image/webp");
    const mediumBuf = await sharp(buffer, { animated: false })
      .rotate()
      .resize({ width: MEDIUM_WIDTH, withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer();
    const mediumPath = await storage().put(bucket, `${base}-md.webp`, mediumBuf, "image/webp");
    return {
      storage_path: originalPath,
      thumb_path:   thumbPath,
      medium_path:  mediumPath,
      width:        meta.width  ?? 0,
      height:       meta.height ?? 0,
      size_bytes:   buffer.length,
      mime_type:    "image/gif",
    };
  }

  // Pipeline for stills: rotate per EXIF, resize, re-encode WebP. Three
  // separate sharp instances because piping mutates the chain and we need
  // independent outputs.
  const original = await sharp(buffer)
    .rotate()                                      // honour EXIF orientation
    .resize({ width: MAX_ORIGINAL, withoutEnlargement: true })
    .webp({ quality: 88 })
    .toBuffer({ resolveWithObject: true });

  const thumb = await sharp(buffer)
    .rotate()
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer();

  const medium = await sharp(buffer)
    .rotate()
    .resize({ width: MEDIUM_WIDTH, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();

  const [originalPath, thumbPath, mediumPath] = await Promise.all([
    storage().put(bucket, `${base}.webp`,       original.data, "image/webp"),
    storage().put(bucket, `${base}-thumb.webp`, thumb,         "image/webp"),
    storage().put(bucket, `${base}-md.webp`,    medium,        "image/webp"),
  ]);

  return {
    storage_path: originalPath,
    thumb_path:   thumbPath,
    medium_path:  mediumPath,
    width:        original.info.width,
    height:       original.info.height,
    size_bytes:   original.info.size,
    mime_type:    "image/webp",
  };
}
