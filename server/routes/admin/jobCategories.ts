// Admin CRUD for the job category taxonomy. Mirrors the pattern used by
// /admin/student-suggestion-topics — same shape, same drawer, same policies.

import { Router } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { jobCategories } from "../../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const jobCategoriesAdminRouter = Router();

// ─── GET /api/admin/job-categories ───────────────────────────────────────
jobCategoriesAdminRouter.get("/", async (_req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(jobCategories)
      .orderBy(asc(jobCategories.sort_order), asc(jobCategories.name));
    res.json({ items: rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/job-categories ──────────────────────────────────────
jobCategoriesAdminRouter.post("/", async (req, res, next) => {
  try {
    const code = need(trim(req.body.code).toLowerCase().replace(/[^a-z0-9_]/g, "_"), "Code");
    const name = need(trim(req.body.name), "Name");
    const description = trim(req.body.description) || null;
    const active = req.body.active !== false;
    const sort_order = Number(req.body.sort_order) || 0;

    try {
      const [row] = await db.insert(jobCategories).values({
        code, name, description, active, sort_order,
      }).returning();
      res.status(201).json({ item: row });
    } catch (err: any) {
      if (err?.code === "23505") throw new ApiError(409, "A category with that code already exists");
      throw err;
    }
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/admin/job-categories/:id ─────────────────────────────────
jobCategoriesAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const patch: Record<string, unknown> = {};
    if (req.body.name !== undefined) patch.name = need(trim(req.body.name), "Name");
    if (req.body.description !== undefined) patch.description = trim(req.body.description) || null;
    if (req.body.active !== undefined) patch.active = Boolean(req.body.active);
    if (req.body.sort_order !== undefined) patch.sort_order = Number(req.body.sort_order) || 0;
    // Deliberately not exposing `code` for edit — changing the code would
    // break any external references (URLs, seeded data). Delete & recreate
    // if a rename is truly needed.

    const [row] = await db.update(jobCategories)
      .set(patch)
      .where(eq(jobCategories.id, String(req.params.id)))
      .returning();
    if (!row) throw new ApiError(404, "Category not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/admin/job-categories/:id ────────────────────────────────
// Hard-delete. Postings pointing at this category have category_id set to
// NULL by the FK's ON DELETE SET NULL — the posting itself survives. Alert
// subscriptions cascade-delete (they'd be useless without the category).
jobCategoriesAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const [row] = await db.delete(jobCategories)
      .where(eq(jobCategories.id, String(req.params.id)))
      .returning();
    if (!row) throw new ApiError(404, "Category not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
