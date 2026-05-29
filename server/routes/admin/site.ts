import { Router } from "express";
import { db } from "../../../db/client.js";
import { siteContent, siteSettings } from "../../../schema/index.js";
import { isValidSlug, isValidSettingKey } from "../../../lib/siteContentSlots.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";

export const siteAdminRouter = Router();

// â”€â”€â”€ PUT /api/admin/site/content/:slug â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Replaces the JSON payload for a single slot. Slug must match the fixed
// enum in src/lib/siteContentSlots.ts; anything else 400s so typos in the
// admin UI don't quietly create orphan rows.
siteAdminRouter.put("/content/:slug", async (req: AuthedRequest, res, next) => {
  try {
    const slug = need(trim(req.params.slug), "Slug");
    if (!isValidSlug(slug)) throw new ApiError(400, `Unknown content slug: ${slug}`);

    const data = req.body?.data;
    if (data === undefined || data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new ApiError(400, "Body must be { data: {...} }");
    }

    const now = new Date();
    const [row] = await db.insert(siteContent).values({
      slug,
      data,
      updated_by: req.user!.id,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: siteContent.slug,
      set: { data, updated_by: req.user!.id, updated_at: now },
    })
    .returning();

    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ PUT /api/admin/site/settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Accepts a partial flat object and upserts each known key. Unknown keys
// are silently ignored â€” never persisted â€” so the admin form can't seed
// arbitrary key/value rows.
siteAdminRouter.put("/settings", async (req: AuthedRequest, res, next) => {
  try {
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(400, "Body must be a flat key/value object");
    }

    const accepted: Array<{ key: string; value: string }> = [];
    for (const [key, value] of Object.entries(body)) {
      if (!isValidSettingKey(key)) continue;
      if (typeof value !== "string") continue;
      accepted.push({ key, value });
    }

    if (accepted.length === 0) {
      return res.json({ updated: 0 });
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      for (const { key, value } of accepted) {
        await tx.insert(siteSettings).values({
          key, value,
          updated_by: req.user!.id,
          updated_at: now,
        })
        .onConflictDoUpdate({
          target: siteSettings.key,
          set: { value, updated_by: req.user!.id, updated_at: now },
        });
      }
    });

    res.json({ updated: accepted.length });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ GET /api/admin/site/content â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Same as the public read, but includes updated_by + updated_at metadata
// the admin table needs. Admin auth already enforced by the parent router.
siteAdminRouter.get("/content", async (_req, res, next) => {
  try {
    const rows = await db.select().from(siteContent);
    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ GET /api/admin/site/settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
siteAdminRouter.get("/settings", async (_req, res, next) => {
  try {
    const rows = await db.select().from(siteSettings);
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    res.json(out);
  } catch (err) { handleApiError(err, res, next); }
});

