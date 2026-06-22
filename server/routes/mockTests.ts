import { Router } from "express";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { mockTests, mockTestRegistrations, files, studentProfiles } from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { ApiError, handleApiError, trim } from "../lib/apiError.js";
import { storage } from "../lib/storage.js";

// Public + authenticated mock-test endpoints used by the student-facing
// portal. The admin-side CRUD lives in routes/admin/mockTests.ts; here we
// only surface what students need: browse, register, see my history.
//
// Visibility rules:
//   • GET / and GET /:id are public (anyone can see what's coming up).
//   • POST /:id/register and DELETE /:id/register require login.
//   • GET /my requires login and only returns the caller's own rows.
//   • A student's `score` is hidden until the parent test's
//     result_published_at is set — WICASA explicitly releases results.

export const mockTestsRouter = Router();

// Small helper — strip non-public fields when responding to students.
// `viewerUserId` may be undefined for an anonymous viewer; we use it
// to attach the caller's own registration status to the row.
function publicShape(
  row: typeof mockTests.$inferSelect & {
    practice_paper_url?: string | null;
    answer_key_url?: string | null;
  },
  options?: { showAnswerKey?: boolean },
) {
  const showKey = !!options?.showAnswerKey;
  return {
    id:                row.id,
    title:             row.title,
    description:       row.description,
    series_name:       row.series_name,
    level:             row.level,
    group_no:          row.group_no,
    paper_no:          row.paper_no,
    scheduled_at:      row.scheduled_at,
    duration_mins:     row.duration_mins,
    venue:             row.venue,
    capacity:          row.capacity,
    fee_paise:         row.fee_paise,
    status:            row.status,
    max_score:         row.max_score,
    result_published_at:   row.result_published_at,
    registration_close_at: row.registration_close_at,
    practice_paper_url: row.practice_paper_url ?? null,
    // Answer key only shown after results are published — pre-publish
    // the file might be uploaded by WICASA but isn't ready to share.
    answer_key_url:     showKey ? (row.answer_key_url ?? null) : null,
    supports_online:    !!row.supports_online,
  };
}

// ─── GET /api/mock-tests ──────────────────────────────────────────────────
// Public list. Defaults to upcoming + active rows ordered by date asc.
// Filters: ?level=foundation|intermediate|final, ?status=open_for_registration
mockTestsRouter.get("/", async (req, res, next) => {
  try {
    const level = trim(req.query.level);
    const status = trim(req.query.status);

    const conds = [
      isNull(mockTests.deleted_at),
      // Show anything still in the future OR currently completed and
      // recently scheduled (so students can see the "results released"
      // entry until WICASA archives it).
      sql`(${mockTests.scheduled_at} > NOW() - INTERVAL '60 days')`,
    ];
    if (level === "foundation" || level === "intermediate" || level === "final") {
      conds.push(eq(mockTests.level, level));
    }
    if (status) conds.push(eq(mockTests.status, status));

    const paperFiles = (await import("../../schema/index.js")).files;
    const keyFiles = paperFiles; // alias for clarity — we re-join the same table twice via separate alias below

    // Drizzle doesn't support two LEFT JOINs to the same table without
    // aliases; we work around by fetching the bare row and then
    // resolving file URLs in a second pass. Keeps the SQL simple and
    // avoids the alias plumbing for what's effectively two scalar
    // lookups per row.
    const rows = await db
      .select()
      .from(mockTests)
      .where(and(...conds))
      .orderBy(asc(mockTests.scheduled_at))
      .limit(50);

    const fileIds = [
      ...rows.map((r) => r.practice_paper_file_id),
      ...rows.map((r) => r.answer_key_file_id),
    ].filter((x): x is string => !!x);
    const fileMap = new Map<string, string | null>();
    if (fileIds.length > 0) {
      const fileRows = await db
        .select({ id: files.id, storage_path: files.storage_path })
        .from(files)
        .where(sql`${files.id} = ANY(${fileIds})`);
      for (const f of fileRows) {
        fileMap.set(f.id, f.storage_path ? storage().url(f.storage_path) : null);
      }
    }

    // Per-row registered count so the listing UI can show
    // "X / capacity registered" without N+1.
    const regCountRows = rows.length === 0 ? [] : await db
      .select({
        mock_test_id: mockTestRegistrations.mock_test_id,
        n: sql<number>`count(*) filter (where status <> 'cancelled')::int`.as("n"),
      })
      .from(mockTestRegistrations)
      .where(sql`${mockTestRegistrations.mock_test_id} = ANY(${rows.map((r) => r.id)})`)
      .groupBy(mockTestRegistrations.mock_test_id);
    const regCount = new Map(regCountRows.map((r) => [r.mock_test_id, r.n]));

    res.json({
      rows: rows.map((r) => ({
        ...publicShape({
          ...r,
          practice_paper_url: r.practice_paper_file_id ? fileMap.get(r.practice_paper_file_id) ?? null : null,
          answer_key_url:     r.answer_key_file_id     ? fileMap.get(r.answer_key_file_id)     ?? null : null,
        }, { showAnswerKey: r.result_published_at != null }),
        registered_count: regCount.get(r.id) ?? 0,
      })),
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/mock-tests/my ──────────────────────────────────────────────
// Authenticated. Returns every mock-test registration the current user
// has, with the parent test's metadata and the user's own score (only
// when the parent test's result_published_at is set).
mockTestsRouter.get("/my", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const rows = await db
      .select({
        registration_id: mockTestRegistrations.id,
        status:          mockTestRegistrations.status,
        score:           mockTestRegistrations.score,
        registered_at:   mockTestRegistrations.registered_at,
        attended_at:     mockTestRegistrations.attended_at,
        // Parent test
        mock_test_id:    mockTests.id,
        title:           mockTests.title,
        level:           mockTests.level,
        group_no:        mockTests.group_no,
        paper_no:        mockTests.paper_no,
        scheduled_at:    mockTests.scheduled_at,
        duration_mins:   mockTests.duration_mins,
        venue:           mockTests.venue,
        max_score:       mockTests.max_score,
        result_published_at: mockTests.result_published_at,
        answer_key_file_id:  mockTests.answer_key_file_id,
      })
      .from(mockTestRegistrations)
      .innerJoin(mockTests, eq(mockTests.id, mockTestRegistrations.mock_test_id))
      .where(and(
        eq(mockTestRegistrations.user_id, userId),
        isNull(mockTests.deleted_at),
      ))
      .orderBy(desc(mockTests.scheduled_at));

    // Resolve answer-key URLs only for tests whose results have been
    // published — pre-publish we hide the file entirely.
    const keyFileIds = rows
      .filter((r) => r.result_published_at && r.answer_key_file_id)
      .map((r) => r.answer_key_file_id!) as string[];
    const keyMap = new Map<string, string>();
    if (keyFileIds.length > 0) {
      const keyRows = await db.select({ id: files.id, storage_path: files.storage_path })
        .from(files)
        .where(sql`${files.id} = ANY(${keyFileIds})`);
      for (const k of keyRows) {
        if (k.storage_path) keyMap.set(k.id, storage().url(k.storage_path));
      }
    }

    res.json({
      rows: rows.map((r) => ({
        registration_id: r.registration_id,
        status:          r.status,
        // Hide score until the parent test publishes results.
        score:           r.result_published_at ? r.score : null,
        registered_at:   r.registered_at,
        attended_at:     r.attended_at,
        mock_test: {
          id:            r.mock_test_id,
          title:         r.title,
          level:         r.level,
          group_no:      r.group_no,
          paper_no:      r.paper_no,
          scheduled_at:  r.scheduled_at,
          duration_mins: r.duration_mins,
          venue:         r.venue,
          max_score:     r.max_score,
          result_published_at: r.result_published_at,
          answer_key_url: r.result_published_at && r.answer_key_file_id
            ? keyMap.get(r.answer_key_file_id) ?? null
            : null,
        },
      })),
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/mock-tests/:id ──────────────────────────────────────────────
// Public detail page. Includes the caller's own registration row when
// they're signed in (so the page can show "Register" vs "Cancel" without
// a second call).
mockTestsRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    if (!id) throw new ApiError(400, "Mock test id is required");

    const [row] = await db
      .select()
      .from(mockTests)
      .where(and(eq(mockTests.id, id), isNull(mockTests.deleted_at)))
      .limit(1);
    if (!row) throw new ApiError(404, "Mock test not found");

    // Resolve practice paper + answer key URLs.
    const fileIds = [row.practice_paper_file_id, row.answer_key_file_id].filter((x): x is string => !!x);
    const fileMap = new Map<string, string | null>();
    if (fileIds.length > 0) {
      const fileRows = await db.select({ id: files.id, storage_path: files.storage_path })
        .from(files)
        .where(sql`${files.id} = ANY(${fileIds})`);
      for (const f of fileRows) {
        fileMap.set(f.id, f.storage_path ? storage().url(f.storage_path) : null);
      }
    }

    // Caller's own registration row, if any. Anonymous viewers get null.
    let myRegistration: { id: string; status: string; score: number | null } | null = null;
    if (req.user) {
      const [my] = await db
        .select({
          id:     mockTestRegistrations.id,
          status: mockTestRegistrations.status,
          score:  mockTestRegistrations.score,
        })
        .from(mockTestRegistrations)
        .where(and(
          eq(mockTestRegistrations.mock_test_id, id),
          eq(mockTestRegistrations.user_id, req.user.id),
        ))
        .limit(1);
      if (my) {
        myRegistration = {
          id: my.id,
          status: my.status,
          // Score visibility follows the parent's publish flag.
          score: row.result_published_at ? my.score : null,
        };
      }
    }

    const [{ n }] = await db
      .select({ n: sql<number>`count(*) filter (where status <> 'cancelled')::int`.as("n") })
      .from(mockTestRegistrations)
      .where(eq(mockTestRegistrations.mock_test_id, id));

    res.json({
      item: {
        ...publicShape({
          ...row,
          practice_paper_url: row.practice_paper_file_id ? fileMap.get(row.practice_paper_file_id) ?? null : null,
          answer_key_url:     row.answer_key_file_id     ? fileMap.get(row.answer_key_file_id)     ?? null : null,
        }, { showAnswerKey: row.result_published_at != null }),
        registered_count: n,
        my_registration:  myRegistration,
      },
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/mock-tests/:id/register ───────────────────────────────────
// Sign the current user up. Enforces:
//   • Test exists, not deleted, not cancelled.
//   • Status is `open_for_registration`.
//   • registration_close_at not yet passed (falls back to scheduled_at).
//   • Capacity not exceeded.
//   • User isn't already registered (re-register on `cancelled` row is allowed).
mockTestsRouter.post("/:id/register", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    if (!id) throw new ApiError(400, "Mock test id is required");

    const result = await db.transaction(async (tx) => {
      const [row] = await tx.select().from(mockTests)
        .where(and(eq(mockTests.id, id), isNull(mockTests.deleted_at))).limit(1);
      if (!row) throw new ApiError(404, "Mock test not found");
      if (row.status !== "open_for_registration") {
        throw new ApiError(400, "Registration is not open for this mock test");
      }
      const closeAt = row.registration_close_at ?? row.scheduled_at;
      if (closeAt && new Date(closeAt).getTime() <= Date.now()) {
        throw new ApiError(400, "Registration window has closed");
      }
      // Student level guard — if the user has a student_profile and the
      // level doesn't match, we still allow it but flag a warning rather
      // than blocking. Most branches want flexibility (a final student
      // sometimes sits an intermediate paper for revision).

      if (row.capacity) {
        const [{ n }] = await tx.select({
            n: sql<number>`count(*) filter (where status <> 'cancelled')::int`.as("n"),
          })
          .from(mockTestRegistrations)
          .where(eq(mockTestRegistrations.mock_test_id, id));
        if (n >= row.capacity) {
          throw new ApiError(400, "This mock test is at full capacity");
        }
      }

      const [existing] = await tx.select()
        .from(mockTestRegistrations)
        .where(and(
          eq(mockTestRegistrations.mock_test_id, id),
          eq(mockTestRegistrations.user_id, req.user!.id),
        )).limit(1);

      if (existing && existing.status !== "cancelled") {
        throw new ApiError(409, "You are already registered for this mock test");
      }

      if (existing) {
        const [reactivated] = await tx.update(mockTestRegistrations)
          .set({ status: "registered", registered_at: new Date() })
          .where(eq(mockTestRegistrations.id, existing.id))
          .returning();
        return reactivated;
      }
      const [inserted] = await tx.insert(mockTestRegistrations).values({
        mock_test_id: id,
        user_id:      req.user!.id,
        status:       "registered",
      }).returning();
      return inserted;
    });

    res.status(201).json({ registration: result });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/mock-tests/:id/register ─────────────────────────────────
// Cancel the caller's registration. Marks the row `cancelled` rather
// than deleting so the audit trail and capacity-history stay intact.
mockTestsRouter.delete("/:id/register", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    if (!id) throw new ApiError(400, "Mock test id is required");
    const [updated] = await db.update(mockTestRegistrations)
      .set({ status: "cancelled" })
      .where(and(
        eq(mockTestRegistrations.mock_test_id, id),
        eq(mockTestRegistrations.user_id, req.user!.id),
      ))
      .returning();
    if (!updated) throw new ApiError(404, "You are not registered for this mock test");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
