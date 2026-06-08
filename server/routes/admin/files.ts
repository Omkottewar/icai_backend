import { Router } from "express";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { files } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const filesAdminRouter = Router();

const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "application/pdf",
]);
const MAX_BYTES = 6 * 1024 * 1024; // 6 MB
const UPLOAD_DIR = "uploads";

// â”€â”€â”€ POST /api/admin/files â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Accepts a JSON body with a base64-encoded file (avoids needing multer).
// Body: { name, mime_type, bucket, data_base64 }
filesAdminRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const name = need(trim(req.body.name), "Filename");
    const mimeType = need(trim(req.body.mime_type), "MIME type");
    const bucket = trim(req.body.bucket) || "banners";
    const dataB64: string = typeof req.body.data_base64 === "string" ? req.body.data_base64 : "";
    if (!dataB64) throw new ApiError(400, "File data is required");
    if (!ALLOWED_MIME.has(mimeType)) throw new ApiError(400, "Unsupported file type");

    // Strip any data: URL prefix the client may have included.
    const stripped = dataB64.replace(/^data:[^;]+;base64,/, "");
    const buf = Buffer.from(stripped, "base64");
    if (buf.length === 0) throw new ApiError(400, "File data is empty or invalid base64");
    if (buf.length > MAX_BYTES) throw new ApiError(400, "File exceeds 6 MB limit");

    const ext = (name.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? "").toLowerCase();
    const objectName = `${randomUUID()}${ext}`;
    const dirAbs = join(process.cwd(), UPLOAD_DIR, bucket);
    if (!existsSync(dirAbs)) await mkdir(dirAbs, { recursive: true });
    await writeFile(join(dirAbs, objectName), buf);

    const storagePath = `${bucket}/${objectName}`;

    const [row] = await db.insert(files).values({
      name,
      mime_type: mimeType,
      size_bytes: buf.length,
      storage_path: storagePath,
      bucket,
      uploaded_by: req.user!.id,
    }).returning();

    res.status(201).json({
      id: row.id,
      bucket: row.bucket,
      storage_path: row.storage_path,
      url: `/uploads/${row.storage_path}`,
      size_bytes: row.size_bytes,
      mime_type: row.mime_type,
      name: row.name,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ DELETE /api/admin/files/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
filesAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const [row] = await db.update(files)
      .set({ deleted_at: new Date() })
      .where(and(eq(files.id, req.params.id), isNull(files.deleted_at)))
      .returning();
    if (!row) throw new ApiError(404, "File not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
