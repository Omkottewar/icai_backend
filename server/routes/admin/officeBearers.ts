import { Router } from "express";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { officeBearers } from "../../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const officeBearersAdminRouter = Router();

// Canonical role codes — the public About page filters by these. role_label
// (display string) is free-text so a "Joint Secretary" can exist without a
// new code.
const ROLE_CODES = [
  "chairman",
  "vice_chairman",
  "secretary",
  "treasurer",
  "wicasa_chairman",
  "imm_past_chairman",
  "managing_committee",
  "member",
] as const;

function parseDate(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new ApiError(400, "Invalid date");
  return d.toISOString().slice(0, 10);
}

function parseBody(input: any) {
  const term_label = need(trim(input.term_label), "Term label");
  if (!/^\d{4}(-\d{2,4})?$/.test(term_label)) {
    throw new ApiError(400, "Term label should look like 2025-26 or 2025");
  }

  const code = trim(input.role_code);
  const role_code = code ? (ROLE_CODES.includes(code as any) ? code : null) : null;

  return {
    term_label,
    role_label:   need(trim(input.role_label), "Role label"),
    role_code,
    person_name:  need(trim(input.person_name), "Person name"),
    photo_file_id: trim(input.photo_file_id) || null,
    bio:          trim(input.bio) || null,
    email:        trim(input.email) || null,
    phone:        trim(input.phone) || null,
    is_current:   !!input.is_current,
    tenure_start: parseDate(input.tenure_start),
    tenure_end:   parseDate(input.tenure_end),
    sort_order:   Number.isFinite(Number(input.sort_order))
                    ? Math.trunc(Number(input.sort_order))
                    : 0,
    hidden:       !!input.hidden,
  };
}

officeBearersAdminRouter.get("/", async (req, res, next) => {
  try {
    const term = trim(req.query.term);
    const rows = await db.select().from(officeBearers)
      .where(term ? eq(officeBearers.term_label, term) : undefined as any)
      .orderBy(desc(officeBearers.term_label), asc(officeBearers.sort_order));
    res.json({ items: rows });
  } catch (err) { next(err); }
});

officeBearersAdminRouter.post("/", async (req, res, next) => {
  try {
    const [row] = await db.insert(officeBearers).values(parseBody(req.body)).returning();
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

officeBearersAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.update(officeBearers)
      .set({ ...parseBody(req.body), updated_at: new Date() })
      .where(eq(officeBearers.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Office bearer not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

officeBearersAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.delete(officeBearers).where(eq(officeBearers.id, id)).returning();
    if (!row) throw new ApiError(404, "Office bearer not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
