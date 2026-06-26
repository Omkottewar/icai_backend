import { Router } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { announcements, files } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { storage } from "../../lib/storage.js";

const fileUrl = (path: string | null | undefined) =>
  path ? storage().url(path) : null;

export const announcementsAdminRouter = Router();

const AUDIENCES = ["all", "members", "students", "employers"] as const;

function parseDate(v: unknown): Date | null {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new ApiError(400, "Invalid date");
  return d;
}

function parseBody(input: any) {
  const title = need(trim(input.title), "Title");
  if (title.length > 200) throw new ApiError(400, "Title is too long (max 200 chars)");

  const body     = trim(input.body)     || null;
  const link_url = trim(input.link_url) || null;
  if (link_url && !/^https?:\/\//i.test(link_url)) {
    throw new ApiError(400, "Link URL must start with http:// or https://");
  }
  // Optional FK into the files table. Caller uploads via /api/admin/files
  // first, then passes the returned id here. Pass empty string / null to
  // clear an existing attachment.
  const file_id  = trim(input.file_id)  || null;

  const audience = AUDIENCES.includes(input.audience) ? input.audience : "all";
  const starts_at = parseDate(input.starts_at) ?? new Date();
  const ends_at   = parseDate(input.ends_at);
  if (ends_at && ends_at <= starts_at) {
    throw new ApiError(400, "Ends-at must be after starts-at");
  }

  const display_order = Number.isFinite(Number(input.display_order))
    ? Math.trunc(Number(input.display_order))
    : 0;

  return { title, body, link_url, file_id, audience, starts_at, ends_at, display_order };
}

// Enrich an announcement row with the resolved file URL. Used in both the
// list response and the single create/update returns so the admin UI can
// preview the existing attachment.
async function withFileUrl<T extends { file_id: string | null }>(row: T): Promise<T & { file_url: string | null; file_name: string | null; file_mime_type: string | null }> {
  if (!row.file_id) {
    return { ...row, file_url: null, file_name: null, file_mime_type: null };
  }
  const [f] = await db
    .select({ storage_path: files.storage_path, name: files.name, mime_type: files.mime_type })
    .from(files)
    .where(eq(files.id, row.file_id))
    .limit(1);
  return {
    ...row,
    file_url: fileUrl(f?.storage_path) ?? null,
    file_name: f?.name ?? null,
    file_mime_type: f?.mime_type ?? null,
  };
}

// ─── GET /api/admin/announcements ─────────────────────────────────────────
// Admin list — includes scheduled and expired rows so the admin can audit.
// Excludes soft-deleted rows by default; pass ?include_deleted=1 to see them.
announcementsAdminRouter.get("/", async (req, res, next) => {
  try {
    const includeDeleted = req.query.include_deleted === "1";
    const rows = await db
      .select()
      .from(announcements)
      .where(includeDeleted ? undefined as any : isNull(announcements.deleted_at))
      .orderBy(desc(announcements.created_at))
      .limit(500);
    // Resolve file_id → public URL for each row so the admin list can show
    // the attached filename / open the existing PDF inline.
    const items = await Promise.all(rows.map(withFileUrl));
    res.json({ items });
  } catch (err) { next(err); }
});

// ─── POST /api/admin/announcements ────────────────────────────────────────
announcementsAdminRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = parseBody(req.body);
    const [row] = await db.insert(announcements).values({
      ...parsed,
      created_by: req.user?.id ?? null,
    }).returning();
    res.json({ item: await withFileUrl(row) });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/admin/announcements/:id ───────────────────────────────────
announcementsAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const parsed = parseBody(req.body);
    const [row] = await db.update(announcements)
      .set({ ...parsed, updated_at: new Date() })
      .where(eq(announcements.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Announcement not found");
    res.json({ item: await withFileUrl(row) });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/admin/announcements/:id ──────────────────────────────────
// Soft-delete. Hard-delete intentionally unavailable to keep audit trail.
announcementsAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = req.params.id;
    const [row] = await db.update(announcements)
      .set({ deleted_at: new Date() })
      .where(and(eq(announcements.id, id), isNull(announcements.deleted_at)))
      .returning();
    if (!row) throw new ApiError(404, "Announcement not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
