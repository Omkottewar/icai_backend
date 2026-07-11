import { Router } from "express";
import { and, asc, desc, eq, ne } from "drizzle-orm";
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

  // Best Paper award (migration 0089). is_winner must be paired with an
  // award_year — enforced here so the DB partial unique index can't be
  // tripped from a UI that only sent the boolean. If admin unchecks the
  // winner box, we clear the year too.
  const is_winner = !!input.is_winner;
  const yearRaw = input.award_year;
  const yearNum = yearRaw === "" || yearRaw === null || yearRaw === undefined ? null : Number(yearRaw);
  if (is_winner) {
    if (!Number.isFinite(yearNum) || (yearNum as number) < 2000 || (yearNum as number) > 2100) {
      throw new ApiError(400, "Award year is required when marking a paper as Best Paper (e.g. 2026)");
    }
  }
  const award_year = is_winner ? Math.trunc(yearNum as number) : null;

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
    is_winner,
    award_year,
  };
}

function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "paper";
}

async function uniqueSlug(base: string): Promise<string> {
  for (let i = 1; i <= 60; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const [exists] = await db.select({ id: paperPresentations.id })
      .from(paperPresentations).where(eq(paperPresentations.slug, candidate)).limit(1);
    if (!exists) return candidate;
  }
  throw new ApiError(500, "Could not generate a unique slug");
}

// When admin flags a new winner for a given year, transactionally clear
// any pre-existing winner for that same year. The partial unique index
// on (award_year) WHERE is_winner catches it as a fallback, but the
// explicit unset gives a friendlier UX than the admin seeing a 409.
async function unsetPreviousWinnerForYear(year: number, exceptId: string | null) {
  const conds = [eq(paperPresentations.is_winner, true), eq(paperPresentations.award_year, year)];
  if (exceptId) conds.push(ne(paperPresentations.id, exceptId));
  await db.update(paperPresentations)
    .set({ is_winner: false, award_year: null, updated_at: new Date() })
    .where(and(...conds));
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
    if (parsed.is_winner && parsed.award_year != null) {
      await unsetPreviousWinnerForYear(parsed.award_year, null);
    }
    // Schema requires slug NOT NULL UNIQUE (public paper pages are routed
    // by slug). Derive it from the title and disambiguate against existing
    // rows so two papers with the same title don't collide.
    const slug = await uniqueSlug(slugify(parsed.title));
    const [row] = await db.insert(paperPresentations).values({ ...parsed, slug }).returning();
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

paperPresentationsAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const parsed = parseBody(req.body);
    if (parsed.is_winner && parsed.award_year != null) {
      await unsetPreviousWinnerForYear(parsed.award_year, id);
    }
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
