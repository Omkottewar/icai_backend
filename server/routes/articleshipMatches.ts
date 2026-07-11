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
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { and, desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../db/client.js";
import { articleshipMatches, events, files } from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { sameOrigin } from "../middleware/sameOrigin.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { storage } from "../lib/storage.js";

export const articleshipMatchesRouter = Router();

const FIRM_SIZES = new Set(["sole_practitioner", "small", "medium", "large", "big4"]);

// CV upload — PDF only, 5 MB cap. Sized for a résumé; anything larger is
// almost certainly a scan of a portfolio that belongs in the notes as a
// link rather than embedded in the file table.
const CV_MAX_BYTES = 5 * 1024 * 1024;

const submissionLimiter = rateLimit({
  standardHeaders: "draft-7",
  legacyHeaders: false,
  windowMs: 60 * 60 * 1000,
  limit: 2,
  // ipKeyGenerator normalises IPv6 to a /64 bucket for correct dedup.
  keyGenerator: (req: any) => req.user?.id ?? ipKeyGenerator(req.ip),
  message: {
    error: "rate_limited",
    message: "You've submitted an articleship form recently. Please wait an hour before another submission.",
  },
});

const cvUploadLimiter = rateLimit({
  standardHeaders: "draft-7",
  legacyHeaders: false,
  windowMs: 60 * 60 * 1000,
  limit: 6,
  keyGenerator: (req: any) => req.user?.id ?? ipKeyGenerator(req.ip),
  message: {
    error: "rate_limited",
    message: "Too many CV uploads recently. Wait a bit before trying again.",
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

    // Optional CV — the ID must be a file this same student uploaded via
    // /upload-cv above. Verifying uploaded_by prevents a student stashing
    // another student's file ID from a leaked API response.
    const cv_file_id = trim(req.body?.cv_file_id) || null;
    if (cv_file_id) {
      const [f] = await db.select({ id: files.id, uploaded_by: files.uploaded_by })
        .from(files).where(eq(files.id, cv_file_id)).limit(1);
      if (!f || f.uploaded_by !== user.id) {
        throw new ApiError(400, "Invalid CV file");
      }
    }

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
      cv_file_id,
      notes,
      status: "submitted",
    }).returning();

    res.status(201).json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/articleship-matches/upload-cv ───────────────────────────────
// Student-scoped CV upload. PDF only, 5 MB cap, written to the dedicated
// `articleship_cvs` bucket. Returns { id } — the caller attaches the id to
// the form submission below.
articleshipMatchesRouter.post("/upload-cv", sameOrigin, requireUser, cvUploadLimiter, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    if (user.primary_role !== "student") {
      throw new ApiError(403, "Only students can upload an articleship CV");
    }

    const name = need(trim(req.body?.name), "Filename");
    const mimeType = trim(req.body?.mime_type);
    if (mimeType !== "application/pdf") {
      throw new ApiError(400, "Only PDF files are accepted");
    }
    const dataB64 = typeof req.body?.data_base64 === "string" ? req.body.data_base64 : "";
    if (!dataB64) throw new ApiError(400, "File data is required");
    const stripped = dataB64.replace(/^data:[^;]+;base64,/, "");
    const buf = Buffer.from(stripped, "base64");
    if (buf.length === 0) throw new ApiError(400, "File data is empty or invalid base64");
    if (buf.length > CV_MAX_BYTES) {
      throw new ApiError(400, `CV exceeds ${Math.round(CV_MAX_BYTES / (1024 * 1024))} MB limit`);
    }
    // %PDF- magic-byte check so a renamed .jpg can't sneak in.
    if (buf.length < 5
      || buf[0] !== 0x25 || buf[1] !== 0x50 || buf[2] !== 0x44 || buf[3] !== 0x46 || buf[4] !== 0x2D) {
      throw new ApiError(400, "File doesn't look like a PDF (bad header)");
    }

    const ext = (name.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? ".pdf").toLowerCase();
    const filename = `${randomUUID()}${ext}`;
    const bucket = "articleship_cvs";
    const storage_path = await storage().put(bucket, filename, buf, mimeType);

    const [row] = await db.insert(files).values({
      name,
      mime_type: mimeType,
      size_bytes: buf.length,
      storage_path,
      bucket,
      uploaded_by: user.id,
    }).returning();

    res.status(201).json({
      id: row.id,
      name: row.name,
      size_bytes: row.size_bytes,
    });
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
      cv_file_id:                articleshipMatches.cv_file_id,
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
