// User self-service endpoints. Anything a signed-in user can do "to their own
// profile" without needing admin privileges belongs here. Today: resume
// upload/replace/delete used by the jobs board apply flow.
//
// The heavy lifting (base64 → buffer → storage) is done inline here rather
// than by delegating to /api/admin/files because admin/files is admin-only
// (requireAdmin) and the resume bucket has different constraints anyway
// (PDF-only, smaller cap, private-ish).

import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../db/client.js";
import { files, users } from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { sameOrigin } from "../middleware/sameOrigin.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { storage } from "../lib/storage.js";

export const meRouter = Router();
meRouter.use(requireUser);

const RESUME_BUCKET = "resumes";
const MAX_RESUME_BYTES = 5 * 1024 * 1024; // 5 MB — resumes are text-heavy PDFs

// ─── GET /api/me/resume ──────────────────────────────────────────────────
// Returns metadata + a fresh URL for the currently-attached resume.
meRouter.get("/resume", async (req: AuthedRequest, res, next) => {
  try {
    const [me] = await db.select({ resume_file_id: users.resume_file_id })
      .from(users).where(eq(users.id, req.user!.id)).limit(1);
    if (!me?.resume_file_id) return res.json({ item: null });

    const [f] = await db.select().from(files)
      .where(and(eq(files.id, me.resume_file_id), isNull(files.deleted_at)))
      .limit(1);
    if (!f) return res.json({ item: null });
    res.json({
      item: {
        id: f.id,
        name: f.name,
        size_bytes: f.size_bytes,
        mime_type: f.mime_type,
        url: storage().url(f.storage_path),
        uploaded_at: f.created_at,
      },
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/me/resume ─────────────────────────────────────────────────
// Body: { name, data_base64 }
// PDF only, ≤ 5 MB. Replaces (and soft-deletes) any existing resume.
meRouter.post("/resume", sameOrigin, async (req: AuthedRequest, res, next) => {
  try {
    const name = need(trim(req.body.name), "Filename");
    const dataB64: string = typeof req.body.data_base64 === "string" ? req.body.data_base64 : "";
    if (!dataB64) throw new ApiError(400, "File data is required");

    const stripped = dataB64.replace(/^data:[^;]+;base64,/, "");
    const buf = Buffer.from(stripped, "base64");
    if (buf.length === 0) throw new ApiError(400, "File data is empty or invalid base64");
    if (buf.length > MAX_RESUME_BYTES) {
      throw new ApiError(400, "Resume must be under 5 MB");
    }
    // Rough PDF-only guard: the first 5 bytes of every PDF are "%PDF-".
    // Prevents someone renaming a JPEG to `.pdf` and uploading a picture.
    const header = buf.slice(0, 5).toString("ascii");
    if (header !== "%PDF-") throw new ApiError(400, "Only PDF resumes are accepted");

    const ext = ".pdf";
    const filename = `${req.user!.id}/${randomUUID()}${ext}`;
    const storage_path = await storage().put(RESUME_BUCKET, filename, buf, "application/pdf");

    const [row] = await db.insert(files).values({
      name,
      mime_type: "application/pdf",
      size_bytes: buf.length,
      storage_path,
      bucket: RESUME_BUCKET,
      uploaded_by: req.user!.id,
    }).returning();

    // Read the current resume id so we can soft-delete it after we swap in
    // the new one. Not strictly required (the FK would just point to the
    // new row) but keeps the files table clean of orphans.
    const [me] = await db.select({ resume_file_id: users.resume_file_id })
      .from(users).where(eq(users.id, req.user!.id)).limit(1);
    const oldFileId = me?.resume_file_id ?? null;

    await db.update(users)
      .set({ resume_file_id: row.id, updated_at: new Date() })
      .where(eq(users.id, req.user!.id));

    if (oldFileId) {
      await db.update(files).set({ deleted_at: new Date() })
        .where(eq(files.id, oldFileId));
    }

    res.status(201).json({
      item: {
        id: row.id,
        name: row.name,
        size_bytes: row.size_bytes,
        mime_type: row.mime_type,
        url: storage().url(row.storage_path),
        uploaded_at: row.created_at,
      },
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/me/resume ───────────────────────────────────────────────
meRouter.delete("/resume", sameOrigin, async (req: AuthedRequest, res, next) => {
  try {
    const [me] = await db.select({ resume_file_id: users.resume_file_id })
      .from(users).where(eq(users.id, req.user!.id)).limit(1);
    if (!me?.resume_file_id) return res.json({ ok: true });
    await db.update(files).set({ deleted_at: new Date() }).where(eq(files.id, me.resume_file_id));
    await db.update(users).set({ resume_file_id: null, updated_at: new Date() })
      .where(eq(users.id, req.user!.id));
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
