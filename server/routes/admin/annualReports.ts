import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { annualReports } from "../../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const annualReportsAdminRouter = Router();

function parseDate(v: unknown): Date | null {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new ApiError(400, "Invalid date");
  return d;
}

function parseBody(input: any) {
  const fy_label = need(trim(input.fy_label), "FY label");
  // Accept both "2024-25" and "2024-2025" — normalise to the short form so
  // /api/annual-reports?fy=2024-25 works regardless of how the row was saved.
  const normalised = fy_label.replace(/^(\d{4})-(\d{4})$/, (_, a: string, b: string) => `${a}-${b.slice(2)}`);
  if (!/^\d{4}-\d{2}$/.test(normalised)) {
    throw new ApiError(400, "FY label should look like 2024-25");
  }

  return {
    fy_label:      normalised,
    title:         trim(input.title) || null,
    pdf_file_id:   trim(input.pdf_file_id)   || null,
    cover_file_id: trim(input.cover_file_id) || null,
    summary:       trim(input.summary) || null,
    published_at:  parseDate(input.published_at),
    hidden:        !!input.hidden,
  };
}

annualReportsAdminRouter.get("/", async (_req, res, next) => {
  try {
    const rows = await db.select().from(annualReports).orderBy(desc(annualReports.fy_label));
    res.json({ items: rows });
  } catch (err) { next(err); }
});

annualReportsAdminRouter.post("/", async (req, res, next) => {
  try {
    const [row] = await db.insert(annualReports).values(parseBody(req.body)).returning();
    res.json({ item: row });
  } catch (err) {
    if (err instanceof Error && /duplicate key/i.test(err.message)) {
      return handleApiError(new ApiError(409, "An annual report for that FY already exists"), res, next);
    }
    handleApiError(err, res, next);
  }
});

annualReportsAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.update(annualReports)
      .set({ ...parseBody(req.body), updated_at: new Date() })
      .where(eq(annualReports.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Annual report not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

annualReportsAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.delete(annualReports).where(eq(annualReports.id, id)).returning();
    if (!row) throw new ApiError(404, "Annual report not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
