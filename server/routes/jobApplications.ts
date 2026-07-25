// Job applications — the member/student "Apply" side.
//
// Endpoints:
//   POST   /api/job-applications                    — auth — apply to a posting
//   GET    /api/job-applications/mine               — auth — my applications
//   POST   /api/job-applications/:id/withdraw       — auth — withdraw mine
//
// Employer-side (viewing applicants, updating status) lives in
// routes/employer.ts under the same middleware chain that already gates
// req.employer. Duplicating that here would just complicate role logic.

import { Router } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  jobApplications, jobPostings, users, files, employers, firms, employerUsers,
} from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { sameOrigin } from "../middleware/sameOrigin.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { notify } from "../lib/notify.js";
import { storage } from "../lib/storage.js";

export const jobApplicationsRouter = Router();

function orgLabel(row: { firm_name: string | null; employer_name: string | null }): string {
  return row.firm_name || row.employer_name || "ICAI Nagpur";
}

// ─── POST /api/job-applications ──────────────────────────────────────────
// Body: { posting_id, cover_message? }
// Snapshots users.resume_file_id + name/email/phone into the row. Notifies
// the posting owner (all employer_users of the employer OR the poster).
jobApplicationsRouter.post("/", requireUser, sameOrigin, async (req: AuthedRequest, res, next) => {
  try {
    const userRole = req.user!.primary_role;
    if (userRole !== "member" && userRole !== "student") {
      throw new ApiError(403, "Applications are for members and students");
    }

    const posting_id = need(trim(req.body.posting_id), "Posting");
    const cover_message = trim(req.body.cover_message) || null;

    const [posting] = await db
      .select({
        id: jobPostings.id,
        type: jobPostings.type,
        title: jobPostings.title,
        status: jobPostings.status,
        employer_id: jobPostings.employer_id,
        firm_id: jobPostings.firm_id,
        poster_user_id: jobPostings.poster_user_id,
        firm_name: firms.name,
        employer_name: employers.company_name,
      })
      .from(jobPostings)
      .leftJoin(firms, eq(firms.id, jobPostings.firm_id))
      .leftJoin(employers, eq(employers.id, jobPostings.employer_id))
      .where(and(eq(jobPostings.id, posting_id), isNull(jobPostings.deleted_at)))
      .limit(1);
    if (!posting) throw new ApiError(404, "Posting not found");
    if (posting.status !== "active") throw new ApiError(400, "This posting is no longer accepting applications");

    const [me] = await db.select({
      name: users.name, email: users.email, phone: users.phone,
      resume_file_id: users.resume_file_id,
    }).from(users).where(eq(users.id, req.user!.id)).limit(1);

    if (!me?.resume_file_id) {
      throw new ApiError(400, "Please upload a resume from your profile before applying");
    }

    const applicant_snapshot = {
      name: me.name,
      email: me.email,
      phone: me.phone,
      applied_at: new Date().toISOString(),
    };

    let row;
    try {
      [row] = await db.insert(jobApplications).values({
        posting_id,
        user_id: req.user!.id,
        resume_file_id: me.resume_file_id,
        cover_message,
        applicant_snapshot,
      }).returning();
    } catch (err: any) {
      // Unique constraint on (posting_id, user_id).
      if (err?.code === "23505") throw new ApiError(409, "You've already applied to this posting");
      throw err;
    }

    // Notify the posting owner(s): every employer_users row for the linked
    // employer, plus the original poster if not covered by that. Firm-posted
    // rows (no employer_id) only ping the poster.
    const notifyTargets = new Set<string>();
    if (posting.employer_id) {
      const emps = await db.select({ user_id: employerUsers.user_id })
        .from(employerUsers)
        .where(eq(employerUsers.employer_id, posting.employer_id));
      for (const e of emps) notifyTargets.add(e.user_id);
    }
    if (posting.poster_user_id) notifyTargets.add(posting.poster_user_id);

    const org_name = orgLabel(posting);
    const applicantsUrlBase = process.env.PUBLIC_APP_URL || "https://icainagpur.in";
    const applicants_url = `${applicantsUrlBase.replace(/\/+$/, "")}/employer/postings#${posting.id}`;
    const applicant_phone_line = me.phone ? `\n  Phone: ${me.phone}` : "";

    for (const uid of notifyTargets) {
      await notify({
        user_id: uid,
        template_key: "job_application_received",
        link_url: applicants_url,
        vars: {
          posting_title: posting.title,
          org_name,
          applicant_name: me.name,
          applicant_email: me.email,
          applicant_phone_line,
          applicants_url,
        },
      });
    }

    res.status(201).json({ ok: true, item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/job-applications/mine ──────────────────────────────────────
jobApplicationsRouter.get("/mine", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db
      .select({
        id: jobApplications.id,
        posting_id: jobApplications.posting_id,
        posting_title: jobPostings.title,
        posting_type: jobPostings.type,
        firm_name: firms.name,
        employer_name: employers.company_name,
        status: jobApplications.status,
        status_note: jobApplications.status_note,
        cover_message: jobApplications.cover_message,
        created_at: jobApplications.created_at,
        withdrawn_at: jobApplications.withdrawn_at,
        resume_file_id: jobApplications.resume_file_id,
      })
      .from(jobApplications)
      .leftJoin(jobPostings, eq(jobPostings.id, jobApplications.posting_id))
      .leftJoin(firms, eq(firms.id, jobPostings.firm_id))
      .leftJoin(employers, eq(employers.id, jobPostings.employer_id))
      .where(eq(jobApplications.user_id, req.user!.id))
      .orderBy(desc(jobApplications.created_at));
    res.json({ items: rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/job-applications/:id/withdraw ─────────────────────────────
jobApplicationsRouter.post("/:id/withdraw", requireUser, sameOrigin, async (req: AuthedRequest, res, next) => {
  try {
    const [row] = await db.update(jobApplications)
      .set({
        status: "withdrawn",
        withdrawn_at: new Date(),
        updated_at: new Date(),
      })
      .where(and(
        eq(jobApplications.id, String(req.params.id)),
        eq(jobApplications.user_id, req.user!.id),
      ))
      .returning();
    if (!row) throw new ApiError(404, "Application not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/job-applications/:id/resume ────────────────────────────────
// Returns a fresh signed URL for the application's snapshotted resume.
// Only the applicant (owner) or an employer_users row for the posting's
// employer may fetch. Firm-only postings fall back to the poster_user_id
// as the "owner".
jobApplicationsRouter.get("/:id/resume", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const [app] = await db
      .select({
        id: jobApplications.id,
        user_id: jobApplications.user_id,
        posting_id: jobApplications.posting_id,
        resume_file_id: jobApplications.resume_file_id,
        posting_employer_id: jobPostings.employer_id,
        posting_poster_user_id: jobPostings.poster_user_id,
      })
      .from(jobApplications)
      .leftJoin(jobPostings, eq(jobPostings.id, jobApplications.posting_id))
      .where(eq(jobApplications.id, String(req.params.id)))
      .limit(1);
    if (!app) throw new ApiError(404, "Application not found");

    let permitted = app.user_id === req.user!.id || app.posting_poster_user_id === req.user!.id;
    if (!permitted && app.posting_employer_id) {
      const [eu] = await db.select({ user_id: employerUsers.user_id })
        .from(employerUsers)
        .where(and(
          eq(employerUsers.employer_id, app.posting_employer_id),
          eq(employerUsers.user_id, req.user!.id),
        )).limit(1);
      permitted = Boolean(eu);
    }
    if (!permitted) throw new ApiError(403, "Not allowed");
    if (!app.resume_file_id) throw new ApiError(404, "Resume is no longer available");

    const [f] = await db.select().from(files).where(eq(files.id, app.resume_file_id)).limit(1);
    if (!f) throw new ApiError(404, "Resume is no longer available");
    res.json({ url: storage().url(f.storage_path), name: f.name, mime_type: f.mime_type });
  } catch (err) { handleApiError(err, res, next); }
});
