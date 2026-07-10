// Public scholarship listing + application endpoints.
//
// Read (list/detail) is fully public — visitors browsing the site can see
// what scholarships the branch runs. Applying requires a signed-in student.
//
// Application uniqueness: one row per (scholarship, student) — the DB
// unique constraint enforces it. Withdrawing is a status change, not a
// delete, so we still preserve the audit trail.

import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "../../db/client.js";
import { scholarships, scholarshipApplications, files } from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { sameOrigin } from "../middleware/sameOrigin.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { storage } from "../lib/storage.js";

export const scholarshipsRouter = Router();

const applyLimiter = rateLimit({
  standardHeaders: "draft-7",
  legacyHeaders: false,
  windowMs: 60 * 60 * 1000,
  limit: 6,
  keyGenerator: (req: any) => req.user?.id ?? ipKeyGenerator(req.ip),
  message: {
    error: "rate_limited",
    message: "You've applied to several scholarships recently. Please wait an hour and try again.",
  },
});

// Uploads are cheap but each request carries a base64-encoded file, so we
// rate-limit to prevent a student's browser from uploading 30 large PDFs
// in a burst before the apply hits the DB.
const uploadLimiter = rateLimit({
  standardHeaders: "draft-7",
  legacyHeaders: false,
  windowMs: 60 * 60 * 1000,
  limit: 12,
  keyGenerator: (req: any) => req.user?.id ?? ipKeyGenerator(req.ip),
  message: {
    error: "rate_limited",
    message: "Too many uploads recently. Wait a bit before trying again.",
  },
});

// Allow-list of MIME types students can upload as scholarship evidence.
// PDF for scanned mark sheets / income certificates, common image formats
// for phone photos of documents. We intentionally exclude video / audio /
// office docs — they're not evidence a committee would want.
const UPLOAD_ALLOWED_MIME = new Set([
  "application/pdf",
  "image/jpeg", "image/png", "image/webp",
]);
const UPLOAD_MAX_BYTES = 8 * 1024 * 1024; // 8 MB per file — a scan of a mark sheet fits well within this.

// ─── Details JSONB validators ──────────────────────────────────────────────
// Whitelisted keys for the JSONB `details` blob so a caller can't stash
// arbitrary junk into the row. Anything outside the whitelist is dropped
// on validate — same defensive pattern used by the dashboard-layout endpoint.
const DETAIL_TEXT_FIELDS = [
  "ca_level",              // "foundation" | "intermediate" | "final"
  "srn",                   // student registration number
  "exam_group",            // "group_1" | "group_2" | "both" | ""
  "exam_result",           // "Passed with 62% (rank 12)" etc — free text
  "coaching_institute",
  "twelfth_board",         // "CBSE" | "ICSE" | "Maharashtra State Board" etc
  "twelfth_percentage",    // stored as string to keep decimal precision easy
  "graduation_details",    // "B.Com from Nagpur University, 74%"
  "father_name",
  "father_occupation",
  "mother_name",
  "mother_occupation",
  "annual_family_income_bucket", // "<2L" | "2-5L" | "5-10L" | "10L+" | "declined"
  "siblings_education",    // free text — sibling names + level
  "category",              // "general" | "obc" | "sc" | "st" | "other" | "declined"
  "other_scholarships_details", // free text
] as const;
const DETAIL_NUMBER_FIELDS = [
  "num_dependents",
] as const;
const DETAIL_BOOLEAN_FIELDS = [
  "other_scholarships_receiving",
  "declaration_accepted",
  "photo_consent",
] as const;
const MAX_DETAIL_TEXT = 2000;

function sanitizeDetails(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object") return {};
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of DETAIL_TEXT_FIELDS) {
    const v = src[key];
    if (typeof v === "string" && v.trim()) {
      out[key] = v.trim().slice(0, MAX_DETAIL_TEXT);
    }
  }
  for (const key of DETAIL_NUMBER_FIELDS) {
    const v = src[key];
    if (v == null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0 && n <= 100) out[key] = n;
  }
  for (const key of DETAIL_BOOLEAN_FIELDS) {
    if (typeof src[key] === "boolean") out[key] = src[key];
  }
  return out;
}

// ─── GET /api/scholarships ────────────────────────────────────────────────
// Public listing. Filters out soft-deleted + inactive rows; deadline-passed
// scholarships still show (with an implicit "closed" state derivable client-side).
scholarshipsRouter.get("/", async (_req, res, next) => {
  try {
    const rows = await db.select({
      id:                 scholarships.id,
      slug:               scholarships.slug,
      title:              scholarships.title,
      summary:            scholarships.summary,
      award_amount_paise: scholarships.award_amount_paise,
      deadline_at:        scholarships.deadline_at,
      applications_open:  scholarships.applications_open,
      external_url:       scholarships.external_url,
      cover_path:         files.storage_path,
      created_at:         scholarships.created_at,
    })
      .from(scholarships)
      .leftJoin(files, eq(files.id, scholarships.cover_file_id))
      .where(and(eq(scholarships.active, true), isNull(scholarships.deleted_at)))
      .orderBy(asc(scholarships.sort_order), desc(scholarships.created_at));

    const items = rows.map((r) => ({
      ...r,
      cover_url: r.cover_path ? storage().url(r.cover_path) : null,
    }));

    res.json({ items });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/scholarships/:slug ──────────────────────────────────────────
scholarshipsRouter.get("/:slug", async (req, res, next) => {
  try {
    const slug = need(trim(req.params.slug), "Slug");
    const [row] = await db.select({
      id:                 scholarships.id,
      slug:               scholarships.slug,
      title:              scholarships.title,
      summary:            scholarships.summary,
      description:        scholarships.description,
      eligibility:        scholarships.eligibility,
      award_amount_paise: scholarships.award_amount_paise,
      deadline_at:        scholarships.deadline_at,
      applications_open:  scholarships.applications_open,
      external_url:       scholarships.external_url,
      cover_path:         files.storage_path,
      created_at:         scholarships.created_at,
    })
      .from(scholarships)
      .leftJoin(files, eq(files.id, scholarships.cover_file_id))
      .where(and(eq(scholarships.slug, slug), isNull(scholarships.deleted_at)))
      .limit(1);
    if (!row) throw new ApiError(404, "Scholarship not found");
    res.json({
      item: {
        ...row,
        cover_url: row.cover_path ? storage().url(row.cover_path) : null,
      },
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/scholarships/uploads ───────────────────────────────────────
// Student-scoped file upload for scholarship application evidence.
// Distinct from /api/admin/files (admin-only) — this route is limited to
// authenticated students, allows only a small PDF/image whitelist, and
// caps size at 8 MB. Returns { id, url, name } — the client stores the ID
// on the application row via document_file_ids[].
scholarshipsRouter.post("/uploads", sameOrigin, requireUser, uploadLimiter, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    if (user.primary_role !== "student") {
      throw new ApiError(403, "Only students can upload scholarship documents");
    }

    const name = need(trim(req.body?.name), "Filename");
    const mimeType = need(trim(req.body?.mime_type), "MIME type");
    if (!UPLOAD_ALLOWED_MIME.has(mimeType)) {
      throw new ApiError(400, "Only PDF or image files (JPEG / PNG / WebP) are accepted");
    }
    const dataB64 = typeof req.body?.data_base64 === "string" ? req.body.data_base64 : "";
    if (!dataB64) throw new ApiError(400, "File data is required");
    const stripped = dataB64.replace(/^data:[^;]+;base64,/, "");
    const buf = Buffer.from(stripped, "base64");
    if (buf.length === 0) throw new ApiError(400, "File data is empty or invalid base64");
    if (buf.length > UPLOAD_MAX_BYTES) {
      throw new ApiError(400, `File exceeds ${Math.round(UPLOAD_MAX_BYTES / (1024 * 1024))} MB limit`);
    }

    // We don't run the sharp image pipeline here — scholarship docs are
    // one-shot evidence, not a gallery photo. Straight write to storage
    // keeps mark-sheet PDFs untouched.
    const ext = (name.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? "").toLowerCase();
    const filename = `${randomUUID()}${ext}`;
    const bucket = "scholarship_documents";
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
      mime_type: row.mime_type,
      size_bytes: row.size_bytes,
      url: storage().url(row.storage_path),
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/scholarships/:id/apply ─────────────────────────────────────
// Students only. Duplicates rejected by the unique constraint (the caller
// gets a friendly 409 rather than the raw pg error).
//
// Body shape (all optional except why_applying + declaration_accepted):
//   why_applying, current_situation, contact_phone     — legacy top-level
//   details: { …structured fields, see DETAIL_* whitelists }
//   document_file_ids: [uuid, …]                        — max 5 file IDs
scholarshipsRouter.post("/:id/apply", sameOrigin, requireUser, applyLimiter, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    if (user.primary_role !== "student") {
      throw new ApiError(403, "Only students can apply for scholarships");
    }
    const scholarship_id = need(trim(req.params.id), "Scholarship ID");
    const why_applying = need(trim(req.body?.why_applying), "Please tell us why you're applying");
    if (why_applying.length > 4000) throw new ApiError(400, "'Why applying' must be 4000 characters or less");
    const current_situation = trim(req.body?.current_situation) || null;
    if (current_situation && current_situation.length > 4000) {
      throw new ApiError(400, "'Current situation' must be 4000 characters or less");
    }
    const contact_phone = trim(req.body?.contact_phone) || null;
    if (contact_phone && contact_phone.length > 20) {
      throw new ApiError(400, "Contact phone looks too long");
    }

    const details = sanitizeDetails(req.body?.details);
    if (!details.declaration_accepted) {
      throw new ApiError(400, "You must accept the declaration before submitting");
    }

    // Documents: max 5 file IDs, each must be an existing file uploaded
    // by THIS student (prevents ID guessing from attaching someone else's
    // marksheet to your application).
    const rawIds = Array.isArray(req.body?.document_file_ids) ? req.body.document_file_ids : [];
    const documentIds = rawIds
      .filter((v: unknown) => typeof v === "string" && v.length >= 8 && v.length <= 64)
      .slice(0, 5);
    if (documentIds.length > 0) {
      const rows = await db.select({ id: files.id, uploaded_by: files.uploaded_by })
        .from(files)
        .where(and(inArray(files.id, documentIds), isNull(files.deleted_at)));
      if (rows.length !== documentIds.length) throw new ApiError(400, "One or more attached documents don't exist");
      const ownedByOther = rows.find((r) => r.uploaded_by !== user.id);
      if (ownedByOther) throw new ApiError(403, "You can only attach documents you uploaded");
    }

    // Confirm the scholarship exists + is accepting applications right now.
    const [scholarship] = await db.select({
      id: scholarships.id,
      applications_open: scholarships.applications_open,
      deadline_at: scholarships.deadline_at,
      external_url: scholarships.external_url,
    })
      .from(scholarships)
      .where(and(eq(scholarships.id, scholarship_id), isNull(scholarships.deleted_at), eq(scholarships.active, true)))
      .limit(1);
    if (!scholarship) throw new ApiError(404, "Scholarship not found");
    if (!scholarship.applications_open) throw new ApiError(409, "Applications are closed for this scholarship");
    if (scholarship.deadline_at && new Date(scholarship.deadline_at) < new Date()) {
      throw new ApiError(409, "The application deadline has passed");
    }
    if (scholarship.external_url) {
      throw new ApiError(409, "This scholarship uses an external application form");
    }

    try {
      const [row] = await db.insert(scholarshipApplications).values({
        scholarship_id,
        student_user_id: user.id,
        why_applying,
        current_situation,
        contact_phone,
        details: details as any,
        document_file_ids: documentIds,
        status: "submitted",
      }).returning();
      res.status(201).json({ item: row });
    } catch (err: any) {
      // 23505 = unique_violation → dup application
      if (err?.code === "23505") {
        throw new ApiError(409, "You've already applied for this scholarship");
      }
      throw err;
    }
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/scholarships/applications/my ────────────────────────────────
scholarshipsRouter.get("/applications/my", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    const rows = await db.select({
      id:                scholarshipApplications.id,
      scholarship_id:    scholarshipApplications.scholarship_id,
      status:            scholarshipApplications.status,
      why_applying:      scholarshipApplications.why_applying,
      current_situation: scholarshipApplications.current_situation,
      contact_phone:     scholarshipApplications.contact_phone,
      details:           scholarshipApplications.details,
      document_file_ids: scholarshipApplications.document_file_ids,
      reviewer_note:     scholarshipApplications.reviewer_note,
      decided_at:        scholarshipApplications.decided_at,
      created_at:        scholarshipApplications.created_at,
      scholarship_title: scholarships.title,
      scholarship_slug:  scholarships.slug,
    })
      .from(scholarshipApplications)
      .leftJoin(scholarships, eq(scholarships.id, scholarshipApplications.scholarship_id))
      .where(eq(scholarshipApplications.student_user_id, user.id))
      .orderBy(desc(scholarshipApplications.created_at))
      .limit(30);
    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/scholarships/applications/:id/withdraw ─────────────────────
scholarshipsRouter.post("/applications/:id/withdraw", sameOrigin, requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    const id = need(trim(req.params.id), "Application ID");
    const [row] = await db.update(scholarshipApplications)
      .set({ status: "withdrawn", updated_at: new Date() })
      .where(and(
        eq(scholarshipApplications.id, id),
        eq(scholarshipApplications.student_user_id, user.id),
      ))
      .returning();
    if (!row) throw new ApiError(404, "Application not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});
