import { Router } from "express";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { paperPresentations } from "../../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const paperPresentationsAdminRouter = Router();

// Same canonical committee tags used on the public ResourcesPage card colours.
// Free-form text accepted at the DB level — this set just keeps the dropdown
// honest in the admin UI.
const COMMITTEE_TAGS = [
  "GST", "Direct Tax", "IT", "Audit", "CPE", "WICASA", "Branch",
] as const;

function parseDate(v: unknown): Date | null {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new ApiError(400, "Invalid date");
  return d;
}

function parseBody(input: any) {
  const title = need(trim(input.title), "Title");
  if (title.length > 300) throw new ApiError(400, "Title is too long (max 300 chars)");
  const speaker_name = need(trim(input.speaker_name), "Speaker name");

  const tag = trim(input.committee_tag);
  const committee_tag = tag ? tag : null;

  const presented_on = parseDate(input.presented_on);

  return {
    title,
    speaker_name,
    committee_tag,
    event_id:    trim(input.event_id)    || null,
    pdf_file_id: trim(input.pdf_file_id) || null,
    description: trim(input.description) || null,
    presented_on: presented_on ? presented_on.toISOString().slice(0, 10) : null,
    hidden:     !!input.hidden,
    sort_order: Number.isFinite(Number(input.sort_order))
                  ? Math.trunc(Number(input.sort_order))
                  : 0,
  };
}

paperPresentationsAdminRouter.get("/", async (_req, res, next) => {
  try {
    const rows = await db.select().from(paperPresentations)
      .orderBy(asc(paperPresentations.sort_order), desc(paperPresentations.presented_on));
    res.json({ items: rows });
  } catch (err) { next(err); }
});

paperPresentationsAdminRouter.post("/", async (req, res, next) => {
  try {
    const parsed = parseBody(req.body);
    const [row] = await db.insert(paperPresentations).values(parsed).returning();
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

paperPresentationsAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const parsed = parseBody(req.body);
    const [row] = await db.update(paperPresentations)
      .set({ ...parsed, updated_at: new Date() })
      .where(eq(paperPresentations.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Paper presentation not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

paperPresentationsAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.delete(paperPresentations).where(eq(paperPresentations.id, id)).returning();
    if (!row) throw new ApiError(404, "Paper presentation not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
