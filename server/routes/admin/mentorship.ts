import { Router } from "express";
import { aliasedTable, and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { mentorshipRequests, users } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { notify } from "../../lib/notify.js";
import { logAudit, saveVersion, actorFromReq } from "../../lib/audit.js";
import { buildCsv, sendCsv } from "../../lib/csv.js";

export const mentorshipAdminRouter = Router();

const STATUSES = ["pending", "matched", "scheduled", "completed", "cancelled"] as const;
type Status = typeof STATUSES[number];

function publicBaseUrl(): string {
  return (
    process.env.PUBLIC_APP_URL ||
    process.env.VITE_PUBLIC_APP_URL ||
    "https://icainagpur.in"
  ).replace(/\/+$/, "");
}

// ─── GET /api/admin/mentorship ────────────────────────────────────────────
mentorshipAdminRouter.get("/", async (req, res, next) => {
  try {
    const status = trim(req.query.status);
    const q      = trim(req.query.q);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const studentU = aliasedTable(users, "student_u");
    const mentorU  = aliasedTable(users, "mentor_u");

    const conds = [] as any[];
    if (status && STATUSES.includes(status as Status)) conds.push(eq(mentorshipRequests.status, status));
    if (q) {
      conds.push(or(
        ilike(studentU.name, `%${q}%`),
        ilike(studentU.email, `%${q}%`),
        ilike(mentorshipRequests.topic, `%${q}%`),
      )!);
    }

    const rows = await db
      .select({
        id:              mentorshipRequests.id,
        topic:           mentorshipRequests.topic,
        preferred_window: mentorshipRequests.preferred_window,
        status:          mentorshipRequests.status,
        notes:           mentorshipRequests.notes,
        matched_at:      mentorshipRequests.matched_at,
        scheduled_at:    mentorshipRequests.scheduled_at,
        completed_at:    mentorshipRequests.completed_at,
        created_at:      mentorshipRequests.created_at,
        student_user_id: mentorshipRequests.student_user_id,
        student_name:    studentU.name,
        student_email:   studentU.email,
        mentor_user_id:  mentorshipRequests.mentor_user_id,
        mentor_name:     mentorU.name,
        mentor_email:    mentorU.email,
      })
      .from(mentorshipRequests)
      .leftJoin(studentU, eq(studentU.id, mentorshipRequests.student_user_id))
      .leftJoin(mentorU,  eq(mentorU.id,  mentorshipRequests.mentor_user_id))
      .where(conds.length ? and(...conds) : sql`true`)
      .orderBy(desc(mentorshipRequests.created_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(mentorshipRequests)
      .where(conds.length ? and(...conds) : sql`true`);

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/mentorship/mentors/search ─────────────────────────────
// Mentor picker source for the assign drawer. Returns members who've
// opted into the mentor pool (users.willing_to_mentor = TRUE). Substring
// name / email search is optional; without a query it returns the whole
// willing pool (capped at 200) so the admin can browse.
mentorshipAdminRouter.get("/mentors/search", async (req, res, next) => {
  try {
    const q = trim(req.query.q);
    const conds: any[] = [
      eq(users.willing_to_mentor, true),
      eq(users.primary_role, "member"),
      isNull(users.deleted_at),
    ];
    if (q) {
      const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      const orClause = or(ilike(users.name, like), ilike(users.email, like));
      if (orClause) conds.push(orClause);
    }
    const rows = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
    })
      .from(users)
      .where(and(...conds))
      .orderBy(users.name)
      .limit(200);
    res.json({ items: rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/mentorship/:id/assign-mentor ─────────────────────────
// Assigns a mentor to a pending request and fires two notifications:
// one to the student ("your mentor is X") and one to the mentor ("you're
// paired with Y"). Notifications are best-effort — a template-render
// failure is logged but doesn't roll back the assignment.
mentorshipAdminRouter.post("/:id/assign-mentor", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mentorship request ID");
    const mentor_user_id = need(trim(req.body?.mentor_user_id), "Mentor user ID");
    const admin_notes = trim(req.body?.notes) || null;

    // Validate the mentor: must be an active member who's opted into the
    // pool. Prevents WICASA from pairing a random UUID or an inactive
    // account. Also lets us surface the mentor's contact details in the
    // notification body.
    const [mentor] = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      willing_to_mentor: users.willing_to_mentor,
      role: users.primary_role,
      deleted_at: users.deleted_at,
    }).from(users).where(eq(users.id, mentor_user_id)).limit(1);
    if (!mentor) throw new ApiError(400, "Mentor account not found");
    if (mentor.deleted_at) throw new ApiError(400, "Mentor account is inactive");
    if (mentor.role !== "member") throw new ApiError(400, "Only members can be assigned as mentors");
    if (!mentor.willing_to_mentor) throw new ApiError(400, "This member hasn't opted into the mentor pool");

    // Snapshot before-state for the audit trail.
    const [before] = await db.select().from(mentorshipRequests)
      .where(eq(mentorshipRequests.id, id)).limit(1);

    const [row] = await db.update(mentorshipRequests)
      .set({
        mentor_user_id,
        status: "matched",
        matched_at: new Date(),
        notes: admin_notes,
        updated_at: new Date(),
      })
      .where(and(eq(mentorshipRequests.id, id), eq(mentorshipRequests.status, "pending")))
      .returning();
    if (!row) throw new ApiError(404, "Request not found or already matched");

    const actor = actorFromReq(req);
    await logAudit({
      entity_type: "mentorship_requests",
      entity_id: row.id,
      action: "reassigned",
      actor,
      before,
      after: row,
      note: `Assigned ${mentor.name} as mentor` + (admin_notes ? `. ${admin_notes}` : ""),
    });
    await saveVersion({
      entity_type: "mentorship_requests",
      entity_id: row.id,
      snapshot: row,
      actor,
      change_note: `Mentor assigned: ${mentor.name}`,
    });

    // Fire two notifications — one per party. Independent try/catch each
    // so a failure on one side doesn't skip the other.
    const base = publicBaseUrl();
    const dashboardUrl = `${base}/dashboard#mentorship`;
    const memberDashboardUrl = `${base}/dashboard`;

    // Fetch student contact for the mentor's notification.
    const [student] = await db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
    }).from(users).where(eq(users.id, row.student_user_id)).limit(1);

    const mentorContactLine = [mentor.phone, mentor.email].filter(Boolean).join(" · ") || "See dashboard for contact details";
    const studentContactLine = student ? ([student.phone, student.email].filter(Boolean).join(" · ") || "See dashboard for contact details") : "See dashboard for contact details";
    const preferredWindowLine = row.preferred_window || "(not specified)";
    const adminNotesLine = admin_notes ? `Notes from WICASA: ${admin_notes}\n\n` : "";

    try {
      await notify({
        user_id: row.student_user_id,
        template_key: "mentorship_assigned_to_student",
        link_url: dashboardUrl,
        vars: {
          mentor_name: mentor.name,
          mentor_contact_line: mentorContactLine,
          topic: row.topic,
          link_url: dashboardUrl,
        },
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[mentorship] notify student failed", e);
    }

    try {
      await notify({
        user_id: mentor.id,
        template_key: "mentorship_assigned_as_mentor",
        link_url: memberDashboardUrl,
        vars: {
          student_name: student?.name || "your mentee",
          student_contact_line: studentContactLine,
          topic: row.topic,
          preferred_window_line: preferredWindowLine,
          admin_notes_line: adminNotesLine,
          link_url: memberDashboardUrl,
        },
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error("[mentorship] notify mentor failed", e);
    }

    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/mentorship/:id/schedule ──────────────────────────────
mentorshipAdminRouter.post("/:id/schedule", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mentorship request ID");
    const scheduledAtStr = trim(req.body?.scheduled_at);
    const scheduled_at = scheduledAtStr ? new Date(scheduledAtStr) : new Date();
    if (Number.isNaN(scheduled_at.getTime())) throw new ApiError(400, "Invalid scheduled_at");

    const [row] = await db.update(mentorshipRequests)
      .set({ status: "scheduled", scheduled_at, updated_at: new Date() })
      .where(and(eq(mentorshipRequests.id, id), eq(mentorshipRequests.status, "matched")))
      .returning();
    if (!row) throw new ApiError(404, "Request not found or not in matched state");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/mentorship/:id/complete ──────────────────────────────
mentorshipAdminRouter.post("/:id/complete", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mentorship request ID");
    const notes = trim(req.body?.notes) || null;
    const [row] = await db.update(mentorshipRequests)
      .set({ status: "completed", completed_at: new Date(), notes, updated_at: new Date() })
      .where(eq(mentorshipRequests.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Request not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/mentorship/:id/cancel ────────────────────────────────
mentorshipAdminRouter.post("/:id/cancel", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mentorship request ID");
    const notes = trim(req.body?.notes) || null;
    const [row] = await db.update(mentorshipRequests)
      .set({ status: "cancelled", notes, updated_at: new Date() })
      .where(eq(mentorshipRequests.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Request not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/mentorship/export.csv ─────────────────────────────────
mentorshipAdminRouter.get("/export.csv", async (req, res, next) => {
  try {
    const status = trim(req.query.status);
    const q      = trim(req.query.q);

    const studentU = aliasedTable(users, "student_u");
    const mentorU  = aliasedTable(users, "mentor_u");

    const conds: any[] = [];
    if (status && STATUSES.includes(status as Status)) conds.push(eq(mentorshipRequests.status, status));
    if (q) {
      conds.push(or(
        ilike(studentU.name, `%${q}%`),
        ilike(studentU.email, `%${q}%`),
        ilike(mentorshipRequests.topic, `%${q}%`),
      )!);
    }

    const rows = await db.select({
      created_at:      mentorshipRequests.created_at,
      status:          mentorshipRequests.status,
      student_name:    studentU.name,
      student_email:   studentU.email,
      topic:           mentorshipRequests.topic,
      preferred_window: mentorshipRequests.preferred_window,
      mentor_name:     mentorU.name,
      mentor_email:    mentorU.email,
      matched_at:      mentorshipRequests.matched_at,
      scheduled_at:    mentorshipRequests.scheduled_at,
      completed_at:    mentorshipRequests.completed_at,
      notes:           mentorshipRequests.notes,
    })
      .from(mentorshipRequests)
      .leftJoin(studentU, eq(studentU.id, mentorshipRequests.student_user_id))
      .leftJoin(mentorU,  eq(mentorU.id,  mentorshipRequests.mentor_user_id))
      .where(conds.length ? and(...conds) : sql`true`)
      .orderBy(desc(mentorshipRequests.created_at))
      .limit(20_000);

    const csv = buildCsv(
      ["Requested", "Status", "Student", "Student email", "Topic",
       "Preferred window", "Mentor", "Mentor email",
       "Matched at", "Scheduled at", "Completed at", "Notes"],
      rows,
      (r) => [
        r.created_at, r.status, r.student_name, r.student_email,
        r.topic, r.preferred_window,
        r.mentor_name, r.mentor_email,
        r.matched_at, r.scheduled_at, r.completed_at, r.notes,
      ],
    );
    sendCsv(res, "mentorship", csv);
  } catch (err) { handleApiError(err, res, next); }
});
