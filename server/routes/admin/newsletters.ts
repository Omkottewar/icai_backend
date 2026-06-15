import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { branchNewsletters } from "../../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const newslettersAdminRouter = Router();

function parseDate(v: unknown): Date | null {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new ApiError(400, "Invalid date");
  return d;
}

function parseBody(input: any) {
  const title = need(trim(input.title), "Title");
  const month = Math.trunc(Number(input.issue_month));
  if (!(month >= 1 && month <= 12)) throw new ApiError(400, "Issue month must be 1-12");
  const year = Math.trunc(Number(input.issue_year));
  if (!(year >= 1950 && year <= 2100)) throw new ApiError(400, "Issue year is out of range");

  return {
    title,
    issue_month: month,
    issue_year:  year,
    pdf_file_id:   trim(input.pdf_file_id)   || null,
    cover_file_id: trim(input.cover_file_id) || null,
    editor_note:   trim(input.editor_note)   || null,
    published_at:  parseDate(input.published_at),
    hidden:        !!input.hidden,
  };
}

newslettersAdminRouter.get("/", async (_req, res, next) => {
  try {
    const rows = await db.select().from(branchNewsletters)
      .orderBy(desc(branchNewsletters.issue_year), desc(branchNewsletters.issue_month));
    res.json({ items: rows });
  } catch (err) { next(err); }
});

newslettersAdminRouter.post("/", async (req, res, next) => {
  try {
    const [row] = await db.insert(branchNewsletters).values(parseBody(req.body)).returning();
    res.json({ item: row });
  } catch (err) {
    // Unique-violation on (issue_year, issue_month) — surface a friendly message.
    if (err instanceof Error && /duplicate key/i.test(err.message)) {
      return handleApiError(new ApiError(409, "A newsletter for that month already exists"), res, next);
    }
    handleApiError(err, res, next);
  }
});

newslettersAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.update(branchNewsletters)
      .set({ ...parseBody(req.body), updated_at: new Date() })
      .where(eq(branchNewsletters.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Newsletter not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

newslettersAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.delete(branchNewsletters).where(eq(branchNewsletters.id, id)).returning();
    if (!row) throw new ApiError(404, "Newsletter not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
