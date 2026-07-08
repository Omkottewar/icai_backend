// Admin scholarship management + application review.
//
// Two exported routers (mounted under different paths so the admin UI can
// pick either resource):
//   /api/admin/scholarships              — CRUD the offer catalogue
//   /api/admin/scholarship-applications  — review + status flip

import { Router } from "express";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { scholarships, scholarshipApplications, users, files } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { storage } from "../../lib/storage.js";

export const scholarshipsAdminRouter = Router();
export const scholarshipApplicationsAdminRouter = Router();

const STATUS_VALUES = new Set([
  "submitted", "under_review", "shortlisted",
  "awarded", "rejected", "withdrawn",
]);

// Very small slugifier — lowercase, ascii-safe, dashes only. Chairman can
// override via req.body.slug if they want a specific one.
function slugify(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

// ─── LIST /api/admin/scholarships ─────────────────────────────────────────
scholarshipsAdminRouter.get("/", async (req, res, next) => {
  try {
    const activeFilter = trim(req.query.active);
    const conds: any[] = [isNull(scholarships.deleted_at)];
    if (activeFilter === "true")  conds.push(eq(scholarships.active, true));
    if (activeFilter === "false") conds.push(eq(scholarships.active, false));

    const rows = await db.select({
      id:                 scholarships.id,
      slug:               scholarships.slug,
      title:              scholarships.title,
      summary:            scholarships.summary,
      award_amount_paise: scholarships.award_amount_paise,
      deadline_at:        scholarships.deadline_at,
      applications_open:  scholarships.applications_open,
      external_url:       scholarships.external_url,
      active:             scholarships.active,
      sort_order:         scholarships.sort_order,
      created_at:         scholarships.created_at,
      updated_at:         scholarships.updated_at,
      applications_count: sql<number>`(
        SELECT COUNT(*)::int FROM ${scholarshipApplications}
        WHERE ${scholarshipApplications}.scholarship_id = ${scholarships}.id
      )`.as("applications_count"),
    })
      .from(scholarships)
      .where(and(...conds))
      .orderBy(asc(scholarships.sort_order), desc(scholarships.created_at));

    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── CREATE /api/admin/scholarships ───────────────────────────────────────
scholarshipsAdminRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const title = need(trim(req.body?.title), "Title");
    const description = need(trim(req.body?.description), "Description");
    const summary     = trim(req.body?.summary) || null;
    const eligibility = trim(req.body?.eligibility) || null;
    const external_url = trim(req.body?.external_url) || null;
    const rawSlug = trim(req.body?.slug) || slugify(title);
    if (!rawSlug) throw new ApiError(400, "Slug could not be derived from the title");

    const awardRaw = req.body?.award_amount_paise;
    const award_amount_paise = awardRaw == null || awardRaw === ""
      ? null
      : Number(awardRaw);
    if (award_amount_paise != null && (!Number.isFinite(award_amount_paise) || award_amount_paise < 0)) {
      throw new ApiError(400, "Award amount must be a non-negative amount in paise");
    }

    const deadlineRaw = trim(req.body?.deadline_at);
    const deadline_at = deadlineRaw ? new Date(deadlineRaw) : null;
    if (deadline_at && Number.isNaN(deadline_at.getTime())) {
      throw new ApiError(400, "Invalid deadline");
    }

    try {
      const [row] = await db.insert(scholarships).values({
        slug: rawSlug,
        title, description, summary, eligibility,
        award_amount_paise, deadline_at, external_url,
        applications_open: req.body?.applications_open !== false,
        active: req.body?.active !== false,
        sort_order: Number(req.body?.sort_order) || 0,
        created_by: req.user?.id ?? null,
      }).returning();
      res.status(201).json({ item: row });
    } catch (err: any) {
      if (err?.code === "23505") throw new ApiError(409, "Slug already in use");
      throw err;
    }
  } catch (err) { handleApiError(err, res, next); }
});

// ─── UPDATE /api/admin/scholarships/:id ───────────────────────────────────
scholarshipsAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Scholarship ID");
    const patch: Record<string, any> = { updated_at: new Date() };

    for (const key of ["title", "summary", "description", "eligibility", "external_url", "slug"] as const) {
      if (req.body?.[key] !== undefined) {
        const v = trim(req.body[key]);
        patch[key] = v || (key === "title" || key === "description" || key === "slug" ? undefined : null);
        if ((key === "title" || key === "description" || key === "slug") && !v) {
          throw new ApiError(400, `${key} cannot be empty`);
        }
      }
    }
    if (req.body?.deadline_at !== undefined) {
      const raw = trim(req.body.deadline_at);
      const d = raw ? new Date(raw) : null;
      if (d && Number.isNaN(d.getTime())) throw new ApiError(400, "Invalid deadline");
      patch.deadline_at = d;
    }
    if (req.body?.award_amount_paise !== undefined) {
      const raw = req.body.award_amount_paise;
      const n = raw == null || raw === "" ? null : Number(raw);
      if (n != null && (!Number.isFinite(n) || n < 0)) throw new ApiError(400, "Invalid award");
      patch.award_amount_paise = n;
    }
    if (req.body?.applications_open !== undefined) patch.applications_open = !!req.body.applications_open;
    if (req.body?.active !== undefined) patch.active = !!req.body.active;
    if (req.body?.sort_order !== undefined) patch.sort_order = Number(req.body.sort_order) || 0;
    if (req.body?.cover_file_id !== undefined) patch.cover_file_id = trim(req.body.cover_file_id) || null;

    const [row] = await db.update(scholarships).set(patch)
      .where(and(eq(scholarships.id, id), isNull(scholarships.deleted_at)))
      .returning();
    if (!row) throw new ApiError(404, "Scholarship not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/admin/scholarships/:id (soft) ────────────────────────────
scholarshipsAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Scholarship ID");
    await db.update(scholarships)
      .set({ deleted_at: new Date(), active: false, updated_at: new Date() })
      .where(eq(scholarships.id, id));
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ═══════════════════════════════════════════════════════════════════════════
// Application review
// ═══════════════════════════════════════════════════════════════════════════

// ─── LIST /api/admin/scholarship-applications ─────────────────────────────
scholarshipApplicationsAdminRouter.get("/", async (req, res, next) => {
  try {
    const status = trim(req.query.status);
    const scholarship_id = trim(req.query.scholarship_id);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const conds: any[] = [];
    if (status && STATUS_VALUES.has(status)) conds.push(eq(scholarshipApplications.status, status));
    if (scholarship_id) conds.push(eq(scholarshipApplications.scholarship_id, scholarship_id));

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
      student_user_id:   scholarshipApplications.student_user_id,
      student_name:      users.name,
      student_email:     users.email,
      scholarship_title: scholarships.title,
    })
      .from(scholarshipApplications)
      .leftJoin(users, eq(users.id, scholarshipApplications.student_user_id))
      .leftJoin(scholarships, eq(scholarships.id, scholarshipApplications.scholarship_id))
      .where(conds.length ? and(...conds) : sql`true`)
      .orderBy(desc(scholarshipApplications.created_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db.select({ total: sql<number>`count(*)::int`.as("total") })
      .from(scholarshipApplications)
      .where(conds.length ? and(...conds) : sql`true`);

    // Hydrate document references so the review UI can render download
    // links without a second round trip. Collect every unique file ID
    // across all rows and fetch them in one query.
    const allDocIds = Array.from(new Set(rows.flatMap((r) => r.document_file_ids || [])));
    const docsById = new Map<string, { id: string; name: string; mime_type: string; url: string }>();
    if (allDocIds.length > 0) {
      const docs = await db.select({
        id: files.id, name: files.name, mime_type: files.mime_type, storage_path: files.storage_path,
      }).from(files).where(inArray(files.id, allDocIds));
      for (const d of docs) {
        docsById.set(d.id, {
          id: d.id, name: d.name, mime_type: d.mime_type,
          url: storage().url(d.storage_path),
        });
      }
    }
    const enriched = rows.map((r) => ({
      ...r,
      documents: (r.document_file_ids || []).map((id) => docsById.get(id)).filter(Boolean),
    }));

    res.json({ rows: enriched, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/scholarship-applications/export.csv ───────────────────
// Committee-facing CSV export. Committees typically decide offline, so
// exporting all applications for a scholarship into a single spreadsheet
// they can print / discuss / mark up is the highest-value review tool
// here. Includes every column the review drawer shows.
scholarshipApplicationsAdminRouter.get("/export.csv", async (req, res, next) => {
  try {
    const scholarship_id = trim(req.query.scholarship_id);
    const status = trim(req.query.status);
    const conds: any[] = [];
    if (scholarship_id) conds.push(eq(scholarshipApplications.scholarship_id, scholarship_id));
    if (status && STATUS_VALUES.has(status)) conds.push(eq(scholarshipApplications.status, status));

    const rows = await db.select({
      id: scholarshipApplications.id,
      created_at: scholarshipApplications.created_at,
      status: scholarshipApplications.status,
      scholarship_title: scholarships.title,
      student_name: users.name,
      student_email: users.email,
      contact_phone: scholarshipApplications.contact_phone,
      details: scholarshipApplications.details,
      why_applying: scholarshipApplications.why_applying,
      current_situation: scholarshipApplications.current_situation,
      reviewer_note: scholarshipApplications.reviewer_note,
      document_file_ids: scholarshipApplications.document_file_ids,
    })
      .from(scholarshipApplications)
      .leftJoin(users, eq(users.id, scholarshipApplications.student_user_id))
      .leftJoin(scholarships, eq(scholarships.id, scholarshipApplications.scholarship_id))
      .where(conds.length ? and(...conds) : sql`true`)
      .orderBy(desc(scholarshipApplications.created_at));

    const headers = [
      "Application ID", "Submitted", "Status", "Scholarship",
      "Student", "Email", "Phone",
      "CA Level", "SRN", "Exam group", "Exam result", "Coaching institute",
      "12th board", "12th %", "Graduation",
      "Father", "Father occupation", "Mother", "Mother occupation",
      "Family income", "Dependents", "Siblings' education",
      "Category",
      "Other scholarships?", "Other scholarships detail",
      "Documents attached",
      "Why applying", "Current situation",
      "Reviewer note",
    ];

    function csv(v: unknown): string {
      if (v == null) return "";
      const s = String(v);
      if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
      return s;
    }

    const lines = [headers.join(",")];
    for (const r of rows) {
      const d = (r.details ?? {}) as Record<string, unknown>;
      lines.push([
        r.id,
        r.created_at?.toISOString?.() ?? "",
        r.status,
        r.scholarship_title ?? "",
        r.student_name ?? "",
        r.student_email ?? "",
        r.contact_phone ?? "",
        d.ca_level ?? "",
        d.srn ?? "",
        d.exam_group ?? "",
        d.exam_result ?? "",
        d.coaching_institute ?? "",
        d.twelfth_board ?? "",
        d.twelfth_percentage ?? "",
        d.graduation_details ?? "",
        d.father_name ?? "",
        d.father_occupation ?? "",
        d.mother_name ?? "",
        d.mother_occupation ?? "",
        d.annual_family_income_bucket ?? "",
        d.num_dependents ?? "",
        d.siblings_education ?? "",
        d.category ?? "",
        d.other_scholarships_receiving ? "Yes" : "No",
        d.other_scholarships_details ?? "",
        (r.document_file_ids || []).length,
        r.why_applying ?? "",
        r.current_situation ?? "",
        r.reviewer_note ?? "",
      ].map(csv).join(","));
    }

    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", `attachment; filename="scholarship-applications-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join("\n"));
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/admin/scholarship-applications/:id ────────────────────────
scholarshipApplicationsAdminRouter.patch("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Application ID");
    const status = trim(req.body?.status);
    if (!STATUS_VALUES.has(status)) throw new ApiError(400, "Invalid status");
    const reviewer_note = trim(req.body?.reviewer_note) || null;
    const terminal = new Set(["awarded", "rejected"]);
    const [row] = await db.update(scholarshipApplications)
      .set({
        status,
        reviewer_note,
        reviewer_user_id: req.user?.id ?? null,
        decided_at: terminal.has(status) ? new Date() : null,
        updated_at: new Date(),
      })
      .where(eq(scholarshipApplications.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Application not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});
