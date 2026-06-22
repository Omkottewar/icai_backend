import { Router } from "express";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { mockTests, mockTestRegistrations, users } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const mockTestsAdminRouter = Router();

const LEVELS = ["foundation", "intermediate", "final"] as const;
const STATUSES = ["scheduled", "open_for_registration", "closed", "completed", "cancelled"] as const;
type Status = typeof STATUSES[number];

function pickLevel(v: unknown): typeof LEVELS[number] {
  if (LEVELS.includes(v as any)) return v as typeof LEVELS[number];
  throw new ApiError(400, "Invalid level. Use foundation | intermediate | final.");
}

function parseScheduledAt(v: unknown): Date {
  const s = trim(v);
  if (!s) throw new ApiError(400, "scheduled_at is required");
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new ApiError(400, "scheduled_at is not a valid datetime");
  return d;
}

// ─── GET /api/admin/mock-tests ────────────────────────────────────────────
mockTestsAdminRouter.get("/", async (req, res, next) => {
  try {
    const status = trim(req.query.status);
    const upcoming = req.query.upcoming === "1";
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const conds = [isNull(mockTests.deleted_at)] as any[];
    if (status && STATUSES.includes(status as Status)) conds.push(eq(mockTests.status, status));
    if (upcoming) conds.push(gt(mockTests.scheduled_at, new Date()));

    const rows = await db
      .select({
        id:            mockTests.id,
        title:         mockTests.title,
        series_name:   mockTests.series_name,
        level:         mockTests.level,
        group_no:      mockTests.group_no,
        paper_no:      mockTests.paper_no,
        scheduled_at:  mockTests.scheduled_at,
        duration_mins: mockTests.duration_mins,
        venue:         mockTests.venue,
        capacity:      mockTests.capacity,
        fee_paise:     mockTests.fee_paise,
        status:        mockTests.status,
        // Inline count of registrations for the listing UI.
        registered_count: sql<number>`(
          SELECT COUNT(*)::int FROM mock_test_registrations r
          WHERE r.mock_test_id = ${mockTests.id} AND r.status <> 'cancelled'
        )`.as("registered_count"),
      })
      .from(mockTests)
      .where(and(...conds))
      .orderBy(upcoming ? asc(mockTests.scheduled_at) : desc(mockTests.scheduled_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(mockTests)
      .where(and(...conds));

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/mock-tests ───────────────────────────────────────────
mockTestsAdminRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const title = need(trim(req.body?.title), "Title");
    const level = pickLevel(req.body?.level);
    const scheduled_at = parseScheduledAt(req.body?.scheduled_at);
    const series_name = trim(req.body?.series_name) || null;
    const venue = trim(req.body?.venue) || null;
    const group_no = req.body?.group_no != null ? Math.trunc(Number(req.body.group_no)) : null;
    const paper_no = req.body?.paper_no != null ? Math.trunc(Number(req.body.paper_no)) : null;
    const duration_mins = req.body?.duration_mins != null ? Math.trunc(Number(req.body.duration_mins)) : 180;
    const capacity = req.body?.capacity != null ? Math.trunc(Number(req.body.capacity)) : null;
    const fee_paise = req.body?.fee_paise != null ? Math.trunc(Number(req.body.fee_paise)) : 0;

    if (group_no !== null && ![1, 2].includes(group_no)) {
      throw new ApiError(400, "group_no must be 1 or 2 (or null for combined)");
    }
    if (paper_no !== null && (paper_no < 1 || paper_no > 8)) {
      throw new ApiError(400, "paper_no must be between 1 and 8");
    }

    // Hybrid-engine fields (migration 0040).
    const description = trim(req.body?.description) || null;
    const practice_paper_file_id = trim(req.body?.practice_paper_file_id) || null;
    const answer_key_file_id = trim(req.body?.answer_key_file_id) || null;
    const max_score = req.body?.max_score != null ? Math.max(1, Math.trunc(Number(req.body.max_score))) : 100;
    const registration_close_at = req.body?.registration_close_at
      ? new Date(String(req.body.registration_close_at))
      : null;
    // Online-attempt opt-in (migration 0047). Defaults to false so
    // existing paper-at-venue tests don't surprise anyone.
    const supports_online = !!req.body?.supports_online;

    const [row] = await db.insert(mockTests).values({
      title, level, scheduled_at, series_name, venue,
      group_no, paper_no, duration_mins, capacity, fee_paise,
      description, practice_paper_file_id, answer_key_file_id,
      max_score, registration_close_at, supports_online,
      created_by: req.user?.id ?? null,
    }).returning();
    res.status(201).json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/admin/mock-tests/:id ──────────────────────────────────────
mockTestsAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mock test ID");
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (typeof req.body?.title === "string") patch.title = trim(req.body.title);
    if (typeof req.body?.series_name === "string") patch.series_name = trim(req.body.series_name) || null;
    if (typeof req.body?.venue === "string") patch.venue = trim(req.body.venue) || null;
    if (req.body?.scheduled_at) patch.scheduled_at = parseScheduledAt(req.body.scheduled_at);
    if (req.body?.level) patch.level = pickLevel(req.body.level);
    if ("group_no" in req.body) patch.group_no = req.body.group_no == null ? null : Math.trunc(Number(req.body.group_no));
    if ("paper_no" in req.body) patch.paper_no = req.body.paper_no == null ? null : Math.trunc(Number(req.body.paper_no));
    if (req.body?.duration_mins != null) patch.duration_mins = Math.trunc(Number(req.body.duration_mins));
    if ("capacity" in req.body) patch.capacity = req.body.capacity == null ? null : Math.trunc(Number(req.body.capacity));
    if (req.body?.fee_paise != null) patch.fee_paise = Math.trunc(Number(req.body.fee_paise));
    if (req.body?.status && STATUSES.includes(req.body.status)) patch.status = req.body.status;
    // Hybrid-engine fields.
    if ("description" in req.body) patch.description = trim(req.body.description) || null;
    if ("practice_paper_file_id" in req.body) patch.practice_paper_file_id = trim(req.body.practice_paper_file_id) || null;
    if ("answer_key_file_id" in req.body) patch.answer_key_file_id = trim(req.body.answer_key_file_id) || null;
    if (req.body?.max_score != null) patch.max_score = Math.max(1, Math.trunc(Number(req.body.max_score)));
    if ("registration_close_at" in req.body) {
      patch.registration_close_at = req.body.registration_close_at
        ? new Date(String(req.body.registration_close_at))
        : null;
    }
    if ("supports_online" in req.body) patch.supports_online = !!req.body.supports_online;

    const [row] = await db.update(mockTests)
      .set(patch as any)
      .where(and(eq(mockTests.id, id), isNull(mockTests.deleted_at)))
      .returning();
    if (!row) throw new ApiError(404, "Mock test not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/admin/mock-tests/:id ─────────────────────────────────────
mockTestsAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mock test ID");
    const [row] = await db.update(mockTests)
      .set({ deleted_at: new Date(), updated_at: new Date() })
      .where(and(eq(mockTests.id, id), isNull(mockTests.deleted_at)))
      .returning();
    if (!row) throw new ApiError(404, "Mock test not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/mock-tests/:id/registrations ──────────────────────────
mockTestsAdminRouter.get("/:id/registrations", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mock test ID");
    const rows = await db.select({
      id:           mockTestRegistrations.id,
      status:       mockTestRegistrations.status,
      score:        mockTestRegistrations.score,
      registered_at: mockTestRegistrations.registered_at,
      attended_at:  mockTestRegistrations.attended_at,
      user_id:      mockTestRegistrations.user_id,
      user_name:    users.name,
      user_email:   users.email,
    })
      .from(mockTestRegistrations)
      .leftJoin(users, eq(users.id, mockTestRegistrations.user_id))
      .where(eq(mockTestRegistrations.mock_test_id, id))
      .orderBy(desc(mockTestRegistrations.registered_at));
    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/mock-tests/:id/marks ────────────────────────────────
//
// Bulk-update scores + status on a test's registrations. WICASA grades
// the papers offline and uses this endpoint to push the marks in one go.
//
// Body shape: { entries: [{ registration_id, score, status }] }
//   • score:  integer ≥ 0 and ≤ max_score (per parent test). Null/empty
//             clears the previously-entered score.
//   • status: 'attended' | 'absent' | 'registered' | 'cancelled'.
//
// We intentionally don't auto-flip status to "attended" just because a
// score was entered — WICASA may want to record a score for someone who
// gets marked "absent" later (e.g. disputed attendance). Status is the
// authoritative attendance signal.
mockTestsAdminRouter.post("/:id/marks", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mock test ID");
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : null;
    if (!entries) throw new ApiError(400, "Body.entries must be an array");

    const [parent] = await db.select({ id: mockTests.id, max_score: mockTests.max_score })
      .from(mockTests)
      .where(and(eq(mockTests.id, id), isNull(mockTests.deleted_at)))
      .limit(1);
    if (!parent) throw new ApiError(404, "Mock test not found");

    const allowed = new Set(["registered", "attended", "absent", "cancelled"]);

    let updated = 0;
    await db.transaction(async (tx) => {
      for (const raw of entries) {
        const regId = trim(raw?.registration_id);
        if (!regId) continue;
        const patch: Record<string, unknown> = {};

        if ("score" in raw) {
          const v = raw.score;
          if (v === null || v === "" || v === undefined) {
            patch.score = null;
          } else {
            const n = Math.trunc(Number(v));
            if (!Number.isFinite(n) || n < 0) throw new ApiError(400, `Score must be ≥ 0 for ${regId}`);
            if (n > parent.max_score) throw new ApiError(400, `Score exceeds max_score (${parent.max_score})`);
            patch.score = n;
          }
        }
        if ("status" in raw) {
          if (!allowed.has(raw.status)) throw new ApiError(400, `Invalid status '${raw.status}'`);
          patch.status = raw.status;
          if (raw.status === "attended" && !raw.attended_at) {
            patch.attended_at = new Date();
          }
        }
        if (Object.keys(patch).length === 0) continue;

        const [done] = await tx.update(mockTestRegistrations)
          .set(patch)
          .where(and(
            eq(mockTestRegistrations.id, regId),
            eq(mockTestRegistrations.mock_test_id, id),
          ))
          .returning({ id: mockTestRegistrations.id });
        if (done) updated += 1;
      }
    });

    res.json({ ok: true, updated });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/mock-tests/:id/publish-results ──────────────────────
//
// Sets the parent test's `result_published_at` and flips status to
// 'completed'. Students will start seeing their scores + the answer key
// (if uploaded) immediately after this. Idempotent — calling twice
// doesn't overwrite the first timestamp.
mockTestsAdminRouter.post("/:id/publish-results", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mock test ID");
    const [row] = await db.update(mockTests)
      .set({
        result_published_at: sql`COALESCE(result_published_at, NOW())`,
        status: "completed",
        updated_at: new Date(),
      })
      .where(and(eq(mockTests.id, id), isNull(mockTests.deleted_at)))
      .returning();
    if (!row) throw new ApiError(404, "Mock test not found");
    res.json({ ok: true, item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/mock-tests/:id/unpublish-results ────────────────────
// Reverse the publish action — for when admin spots an error in the
// marks and needs to retract before re-publishing.
mockTestsAdminRouter.post("/:id/unpublish-results", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mock test ID");
    const [row] = await db.update(mockTests)
      .set({ result_published_at: null, updated_at: new Date() })
      .where(and(eq(mockTests.id, id), isNull(mockTests.deleted_at)))
      .returning();
    if (!row) throw new ApiError(404, "Mock test not found");
    res.json({ ok: true, item: row });
  } catch (err) { handleApiError(err, res, next); }
});
