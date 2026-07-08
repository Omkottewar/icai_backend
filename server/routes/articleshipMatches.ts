// Public articleship matchmaking endpoints for students.
//
// Companion to backend/server/routes/admin/articleshipMatches.ts.
//
// Flow (Section N.9 of the client requirements):
//   1. Student attends a WICASA articleship seminar (event with an
//      articleship-oriented committee).
//   2. Student POSTs the matchmaking form → row inserted with
//      status='submitted' and student_user_id from the session.
//   3. WICASA admin sees the submission, computes/edits recommended firms,
//      and later marks placement.
//
// Fields the student fills:
//   • seminar_event_id       — optional; the event they attended
//   • preferred_specialisations[] — e.g. ["Direct Tax", "Audit"]
//   • preferred_location     — free text (city / area)
//   • preferred_firm_size    — sole_practitioner | small | medium | large | big4
//   • expected_stipend_paise — integer, optional
//   • cv_file_id             — optional (upload flow is deferred; a URL
//                              string in `notes` works as a stopgap)
//
// Rate-limited to prevent form spam (2/hour/user). Each student typically
// submits once per seminar; higher-frequency posts almost always come from
// scripted abuse.

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { articleshipMatches, events } from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { sameOrigin } from "../middleware/sameOrigin.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";

export const articleshipMatchesRouter = Router();

const FIRM_SIZES = new Set(["sole_practitioner", "small", "medium", "large", "big4"]);

const submissionLimiter = rateLimit({
  standardHeaders: "draft-7",
  legacyHeaders: false,
  windowMs: 60 * 60 * 1000,
  limit: 2,
  keyGenerator: (req: any) => req.user?.id ?? req.ip,
  message: {
    error: "rate_limited",
    message: "You've submitted an articleship form recently. Please wait an hour before another submission.",
  },
});

function parseSpecialisations(raw: unknown): string[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(",");
  return arr
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s.length > 0 && s.length <= 60)
    .slice(0, 10);
}

// ─── POST /api/articleship-matches ────────────────────────────────────────
articleshipMatchesRouter.post("/", sameOrigin, requireUser, submissionLimiter, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    if (user.primary_role !== "student") {
      throw new ApiError(403, "Only students can submit articleship preferences");
    }

    const seminar_event_id = trim(req.body?.seminar_event_id) || null;
    const preferred_specialisations = parseSpecialisations(req.body?.preferred_specialisations);
    if (preferred_specialisations.length === 0) {
      throw new ApiError(400, "Pick at least one specialisation of interest");
    }
    const preferred_location = trim(req.body?.preferred_location) || null;
    const preferred_firm_size = trim(req.body?.preferred_firm_size) || null;
    if (preferred_firm_size && !FIRM_SIZES.has(preferred_firm_size)) {
      throw new ApiError(400, "Invalid firm size");
    }
    const stipendRaw = req.body?.expected_stipend_paise;
    const expected_stipend_paise = stipendRaw == null || stipendRaw === "" ? null : Number(stipendRaw);
    if (expected_stipend_paise != null && (!Number.isFinite(expected_stipend_paise) || expected_stipend_paise < 0)) {
      throw new ApiError(400, "Expected stipend must be a non-negative amount");
    }
    const notes = trim(req.body?.notes) || null;
    if (notes && notes.length > 2000) throw new ApiError(400, "Notes must be 2000 characters or less");

    // If the student named a seminar event, verify it exists. We don't
    // enforce attendance because attendance-marking runs late and shouldn't
    // block the form.
    if (seminar_event_id) {
      const [ev] = await db.select({ id: events.id }).from(events).where(eq(events.id, seminar_event_id)).limit(1);
      if (!ev) throw new ApiError(400, "Invalid seminar event");
    }

    const [row] = await db.insert(articleshipMatches).values({
      student_user_id: user.id,
      seminar_event_id,
      preferred_specialisations,
      preferred_location,
      preferred_firm_size,
      expected_stipend_paise,
      notes,
      status: "submitted",
    }).returning();

    res.status(201).json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/articleship-matches/my ───────────────────────────────────────
articleshipMatchesRouter.get("/my", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    const rows = await db.select({
      id:                        articleshipMatches.id,
      seminar_event_id:          articleshipMatches.seminar_event_id,
      preferred_specialisations: articleshipMatches.preferred_specialisations,
      preferred_location:        articleshipMatches.preferred_location,
      preferred_firm_size:       articleshipMatches.preferred_firm_size,
      expected_stipend_paise:    articleshipMatches.expected_stipend_paise,
      status:                    articleshipMatches.status,
      notes:                     articleshipMatches.notes,
      recommended_firm_ids:      articleshipMatches.recommended_firm_ids,
      placed_firm_id:            articleshipMatches.placed_firm_id,
      created_at:                articleshipMatches.created_at,
      updated_at:                articleshipMatches.updated_at,
    })
      .from(articleshipMatches)
      .where(eq(articleshipMatches.student_user_id, user.id))
      .orderBy(desc(articleshipMatches.created_at))
      .limit(20);
    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/articleship-matches/:id/cancel ──────────────────────────────
articleshipMatchesRouter.post("/:id/cancel", sameOrigin, requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    const id = need(trim(req.params.id), "Submission ID");
    const [row] = await db.update(articleshipMatches)
      .set({ status: "cancelled", updated_at: new Date() })
      .where(and(
        eq(articleshipMatches.id, id),
        eq(articleshipMatches.student_user_id, user.id),
      ))
      .returning();
    if (!row) throw new ApiError(404, "Submission not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});
