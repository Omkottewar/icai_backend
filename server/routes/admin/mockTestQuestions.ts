// Admin-side CRUD for the mock-test question bank.
//
//   GET    /api/admin/mock-tests/:id/questions       — list (with options + answer keys)
//   POST   /api/admin/mock-tests/:id/questions       — create (body carries options)
//   PATCH  /api/admin/mock-tests/:id/questions/:qid  — update (replaces options)
//   DELETE /api/admin/mock-tests/:id/questions/:qid  — soft delete
//   GET    /api/admin/mock-tests/:id/attempts        — list attempts + scores
//   PATCH  /api/admin/attempts/:aid/answer/:qid      — manual mark for subjective
//
// Mount under requireAdmin in the app router.

import { Router } from "express";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import {
  mockTests,
  mockTestQuestions,
  mockTestOptions,
  mockTestAttempts,
  mockTestAnswers,
  users,
} from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { parseQuestionsDocx } from "../../lib/mockTestDocxParser.js";

export const mockTestQuestionsAdminRouter = Router();

const QUESTION_TYPES = ["mcq", "numerical", "short", "long"] as const;
type QType = typeof QUESTION_TYPES[number];

function pickQType(v: unknown): QType {
  if (QUESTION_TYPES.includes(v as any)) return v as QType;
  throw new ApiError(400, "question_type must be one of mcq | numerical | short | long");
}

function parseOptions(raw: unknown, qType: QType): Array<{
  option_label: string; body: string; is_correct: boolean; sort_order: number;
}> {
  if (qType !== "mcq") return [];
  if (!Array.isArray(raw)) throw new ApiError(400, "Options array required for MCQ");
  if (raw.length < 2) throw new ApiError(400, "MCQ needs at least 2 options");
  if (raw.length > 8) throw new ApiError(400, "Max 8 options per question");
  const opts = raw.map((o: any, i: number) => ({
    option_label: trim(o?.option_label) || String.fromCharCode(65 + i), // A, B, C, …
    body:         trim(o?.body),
    is_correct:   !!o?.is_correct,
    sort_order:   Number.isFinite(o?.sort_order) ? Number(o.sort_order) : i,
  }));
  if (opts.some((o) => !o.body)) throw new ApiError(400, "Every option needs body text");
  if (!opts.some((o) => o.is_correct)) throw new ApiError(400, "Mark at least one option correct");
  return opts;
}

// ─── GET /api/admin/mock-tests/:id/questions ─────────────────────────────────
mockTestQuestionsAdminRouter.get("/mock-tests/:id/questions", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mock test id");
    const questions = await db
      .select()
      .from(mockTestQuestions)
      .where(and(eq(mockTestQuestions.mock_test_id, id), isNull(mockTestQuestions.deleted_at)))
      .orderBy(asc(mockTestQuestions.question_no));
    const qIds = questions.map((q) => q.id);
    const options = qIds.length === 0 ? [] : await db
      .select().from(mockTestOptions)
      .where(inArray(mockTestOptions.question_id, qIds));
    res.json({
      questions: questions.map((q) => ({
        ...q,
        options: options
          .filter((o) => o.question_id === q.id)
          .sort((a, b) => a.sort_order - b.sort_order),
      })),
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/mock-tests/:id/questions ────────────────────────────────
mockTestQuestionsAdminRouter.post("/mock-tests/:id/questions", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mock test id");
    const [test] = await db.select({ id: mockTests.id }).from(mockTests).where(eq(mockTests.id, id)).limit(1);
    if (!test) throw new ApiError(404, "Mock test not found");

    const qType = pickQType(req.body?.question_type);
    const body = need(trim(req.body?.body), "body");
    const marks = Math.max(1, Math.min(50, Number(req.body?.marks ?? 1)));
    const negMarks = Math.max(0, Math.min(marks, Number(req.body?.negative_marks ?? 0)));
    const topic = trim(req.body?.topic_tag) || null;
    const difficulty = trim(req.body?.difficulty) || null;
    const explanation = trim(req.body?.explanation) || null;
    const options = parseOptions(req.body?.options, qType);

    // Numerical answer is required for that question type.
    const numericalAnswerRaw = req.body?.numerical_answer;
    const numericalTolRaw = req.body?.numerical_tolerance;
    let numericalAnswer: string | null = null;
    let numericalTolerance = "0";
    if (qType === "numerical") {
      if (numericalAnswerRaw == null || numericalAnswerRaw === "" || !Number.isFinite(Number(numericalAnswerRaw))) {
        throw new ApiError(400, "numerical_answer is required for numerical questions");
      }
      numericalAnswer = String(Number(numericalAnswerRaw));
      if (numericalTolRaw != null && numericalTolRaw !== "") {
        const tol = Number(numericalTolRaw);
        if (!Number.isFinite(tol) || tol < 0) throw new ApiError(400, "numerical_tolerance must be a non-negative number");
        numericalTolerance = String(tol);
      }
    }

    const created = await db.transaction(async (tx) => {
      // Auto-assign question_no = max+1 unless caller specified one.
      const [{ next_no }] = await tx.execute(sql`
        SELECT COALESCE(MAX(question_no), 0) + 1 AS next_no
        FROM mock_test_questions
        WHERE mock_test_id = ${id} AND deleted_at IS NULL
      `) as unknown as Array<{ next_no: number }>;

      const questionNo = Number.isFinite(req.body?.question_no)
        ? Math.max(1, Number(req.body.question_no))
        : Number(next_no);

      const [q] = await tx.insert(mockTestQuestions).values({
        mock_test_id:   id,
        question_no:    questionNo,
        question_type:  qType,
        body,
        marks,
        negative_marks: String(negMarks),
        topic_tag:      topic,
        difficulty,
        numerical_answer: numericalAnswer,
        numerical_tolerance: numericalTolerance,
        explanation,
      }).returning();

      if (options.length > 0) {
        await tx.insert(mockTestOptions).values(options.map((o) => ({ ...o, question_id: q!.id })));
      }
      return q!;
    });

    res.status(201).json({ question: created });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/admin/mock-tests/:id/questions/:qid ──────────────────────────
mockTestQuestionsAdminRouter.patch("/mock-tests/:id/questions/:qid", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mock test id");
    const qid = need(trim(req.params.qid), "Question id");

    const [existing] = await db.select().from(mockTestQuestions).where(eq(mockTestQuestions.id, qid)).limit(1);
    if (!existing || existing.mock_test_id !== id) throw new ApiError(404, "Question not found in this test");

    const patch: Record<string, unknown> = {};
    if ("body" in req.body) patch.body = trim(req.body.body) || existing.body;
    if ("marks" in req.body) patch.marks = Math.max(1, Math.min(50, Number(req.body.marks)));
    if ("negative_marks" in req.body) patch.negative_marks = String(Math.max(0, Number(req.body.negative_marks)));
    if ("topic_tag" in req.body) patch.topic_tag = trim(req.body.topic_tag) || null;
    if ("difficulty" in req.body) patch.difficulty = trim(req.body.difficulty) || null;
    if ("explanation" in req.body) patch.explanation = trim(req.body.explanation) || null;
    if ("question_no" in req.body) patch.question_no = Math.max(1, Number(req.body.question_no) || existing.question_no);
    if ("numerical_answer" in req.body) {
      const v = req.body.numerical_answer;
      patch.numerical_answer = v == null || v === "" ? null : String(Number(v));
    }
    if ("numerical_tolerance" in req.body) {
      const v = Number(req.body.numerical_tolerance ?? 0);
      patch.numerical_tolerance = String(Number.isFinite(v) && v >= 0 ? v : 0);
    }
    patch.updated_at = new Date();

    await db.transaction(async (tx) => {
      await tx.update(mockTestQuestions).set(patch).where(eq(mockTestQuestions.id, qid));

      // If caller sent `options`, replace the option set wholesale —
      // simpler than diff-and-merge, and admins almost always tweak
      // the whole answer set together.
      if (Array.isArray(req.body?.options)) {
        const opts = parseOptions(req.body.options, existing.question_type as QType);
        await tx.delete(mockTestOptions).where(eq(mockTestOptions.question_id, qid));
        if (opts.length > 0) {
          await tx.insert(mockTestOptions).values(opts.map((o) => ({ ...o, question_id: qid })));
        }
      }
    });

    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/admin/mock-tests/:id/questions/:qid (soft) ──────────────────
mockTestQuestionsAdminRouter.delete("/mock-tests/:id/questions/:qid", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mock test id");
    const qid = need(trim(req.params.qid), "Question id");
    const [updated] = await db.update(mockTestQuestions)
      .set({ deleted_at: new Date() })
      .where(and(eq(mockTestQuestions.id, qid), eq(mockTestQuestions.mock_test_id, id)))
      .returning();
    if (!updated) throw new ApiError(404, "Question not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/mock-tests/:id/attempts ──────────────────────────────────
// All attempts for a test with scores + status + student. Used by the
// admin's "Attempts" tab to see who took the test and review subjective
// answers.
mockTestQuestionsAdminRouter.get("/mock-tests/:id/attempts", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mock test id");
    const rows = await db
      .select({
        id:             mockTestAttempts.id,
        user_id:        mockTestAttempts.user_id,
        user_name:      users.name,
        user_email:     users.email,
        status:         mockTestAttempts.status,
        started_at:     mockTestAttempts.started_at,
        submitted_at:   mockTestAttempts.submitted_at,
        score_auto:     mockTestAttempts.score_auto,
        score_manual:   mockTestAttempts.score_manual,
        score_total:    mockTestAttempts.score_total,
        tab_blur_count: mockTestAttempts.tab_blur_count,
      })
      .from(mockTestAttempts)
      .leftJoin(users, eq(users.id, mockTestAttempts.user_id))
      .where(eq(mockTestAttempts.mock_test_id, id))
      .orderBy(desc(mockTestAttempts.submitted_at), desc(mockTestAttempts.started_at));
    res.json({ attempts: rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/admin/attempts/:aid/answer/:qid ──────────────────────────────
// Manual marking entry for subjective questions. Recomputes score_manual
// and score_total = score_auto + score_manual.
mockTestQuestionsAdminRouter.patch("/attempts/:aid/answer/:qid", async (req: AuthedRequest, res, next) => {
  try {
    const aid = need(trim(req.params.aid), "Attempt id");
    const qid = need(trim(req.params.qid), "Question id");
    const marksRaw = req.body?.marks_awarded;
    if (marksRaw == null || marksRaw === "") throw new ApiError(400, "marks_awarded is required");
    const marks = Number(marksRaw);
    if (!Number.isFinite(marks)) throw new ApiError(400, "marks_awarded must be a number");

    await db.transaction(async (tx) => {
      // Upsert the per-answer mark.
      await tx.insert(mockTestAnswers).values({
        attempt_id: aid, question_id: qid, marks_awarded: String(marks),
      }).onConflictDoUpdate({
        target: [mockTestAnswers.attempt_id, mockTestAnswers.question_id],
        set: { marks_awarded: String(marks), updated_at: new Date() },
      });

      // Recompute totals from the per-answer marks. Auto vs manual is
      // distinguished by the parent question's type.
      const breakdown = await tx.execute(sql`
        SELECT
          COALESCE(SUM(CASE WHEN q.question_type IN ('mcq','numerical') THEN ans.marks_awarded ELSE 0 END), 0) AS auto_sum,
          COALESCE(SUM(CASE WHEN q.question_type IN ('short','long')   THEN ans.marks_awarded ELSE 0 END), 0) AS manual_sum
        FROM mock_test_answers ans
        JOIN mock_test_questions q ON q.id = ans.question_id
        WHERE ans.attempt_id = ${aid}
          AND ans.marks_awarded IS NOT NULL
      `) as unknown as Array<{ auto_sum: number; manual_sum: number }>;

      const auto = Number(breakdown[0]?.auto_sum ?? 0);
      const manual = Number(breakdown[0]?.manual_sum ?? 0);
      await tx.update(mockTestAttempts).set({
        score_auto: String(auto),
        score_manual: String(manual),
        score_total: String(auto + manual),
        graded_at: new Date(),
        graded_by: req.user!.id,
      }).where(eq(mockTestAttempts.id, aid));
    });

    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/mock-tests/:id/questions/parse-docx ────────────────────
// Body: { data_base64 } — the Word file's bytes, base64 encoded.
// Returns: parsed questions for the admin to review/edit before commit.
// Stateless — nothing is persisted here.
const MAX_DOCX_BYTES = 4 * 1024 * 1024; // 4 MB; way more than any real test paper
mockTestQuestionsAdminRouter.post("/mock-tests/:id/questions/parse-docx", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mock test id");
    const [test] = await db.select({ id: mockTests.id }).from(mockTests).where(eq(mockTests.id, id)).limit(1);
    if (!test) throw new ApiError(404, "Mock test not found");

    const dataB64: string = typeof req.body?.data_base64 === "string" ? req.body.data_base64 : "";
    if (!dataB64) throw new ApiError(400, "data_base64 is required");
    const buf = Buffer.from(dataB64, "base64");
    if (buf.byteLength === 0) throw new ApiError(400, "Empty file");
    if (buf.byteLength > MAX_DOCX_BYTES) throw new ApiError(413, "File is larger than 4 MB");

    // Quick magic-byte sniff: .docx is a ZIP starting with "PK".
    if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
      throw new ApiError(400, "That doesn't look like a .docx file. Save your Word document as .docx (not .doc).");
    }

    const parsed = await parseQuestionsDocx(buf);
    res.json(parsed);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/mock-tests/:id/questions/bulk-import ───────────────────
// Body: { questions: ParsedQuestion[] }
// Commits the (admin-reviewed) parsed questions. Auto-numbers from the
// max existing question_no + 1. Single transaction — all-or-nothing.
mockTestQuestionsAdminRouter.post("/mock-tests/:id/questions/bulk-import", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mock test id");
    const [test] = await db.select({ id: mockTests.id }).from(mockTests).where(eq(mockTests.id, id)).limit(1);
    if (!test) throw new ApiError(404, "Mock test not found");

    const incoming = Array.isArray(req.body?.questions) ? req.body.questions : null;
    if (!incoming || incoming.length === 0) throw new ApiError(400, "questions array required");
    if (incoming.length > 200) throw new ApiError(400, "Max 200 questions per import");

    // Validate everything up-front; bail if any single question is bad
    // so we don't leave a half-imported test.
    const cleaned = incoming.map((q: any, idx: number) => {
      const qType = ["mcq", "numerical", "short", "long"].includes(q?.question_type) ? q.question_type : null;
      if (!qType) throw new ApiError(400, `Question ${idx + 1}: invalid question_type`);
      const body = String(q?.body ?? "").trim();
      if (!body) throw new ApiError(400, `Question ${idx + 1}: body is empty`);
      const marks = Math.max(1, Math.min(50, Math.trunc(Number(q?.marks ?? 1))));
      const negMarks = Math.max(0, Math.min(marks, Number(q?.negative_marks ?? 0)));
      const opts = Array.isArray(q?.options) ? q.options : [];
      if (qType === "mcq") {
        if (opts.length < 2) throw new ApiError(400, `Question ${idx + 1}: MCQ needs at least 2 options`);
        if (!opts.some((o: any) => !!o.is_correct)) {
          throw new ApiError(400, `Question ${idx + 1}: mark at least one option correct`);
        }
      }
      if (qType === "numerical") {
        const ans = Number(q?.numerical_answer);
        if (!Number.isFinite(ans)) throw new ApiError(400, `Question ${idx + 1}: numerical answer missing`);
      }
      return {
        question_type: qType,
        body,
        marks,
        negative_marks: String(negMarks),
        topic_tag: q?.topic_tag ? String(q.topic_tag).trim() || null : null,
        difficulty: q?.difficulty ? String(q.difficulty).trim() || null : null,
        explanation: q?.explanation ? String(q.explanation).trim() || null : null,
        numerical_answer: qType === "numerical" ? String(Number(q.numerical_answer)) : null,
        numerical_tolerance: qType === "numerical" ? String(Math.max(0, Number(q?.numerical_tolerance ?? 0))) : "0",
        options: qType === "mcq"
          ? opts.map((o: any, i: number) => ({
              option_label: String(o?.option_label || String.fromCharCode(65 + i)),
              body: String(o?.body ?? "").trim(),
              is_correct: !!o?.is_correct,
              sort_order: i,
            }))
          : [],
      };
    });

    const inserted = await db.transaction(async (tx) => {
      // Start numbering from max(existing) + 1 so re-import appends.
      const [{ next_no }] = await tx.execute(sql`
        SELECT COALESCE(MAX(question_no), 0) + 1 AS next_no
        FROM mock_test_questions
        WHERE mock_test_id = ${id} AND deleted_at IS NULL
      `) as unknown as Array<{ next_no: number }>;

      const startAt = Number(next_no) || 1;
      const out: Array<typeof mockTestQuestions.$inferSelect> = [];

      for (let i = 0; i < cleaned.length; i++) {
        const c = cleaned[i]!;
        const [q] = await tx.insert(mockTestQuestions).values({
          mock_test_id:        id,
          question_no:         startAt + i,
          question_type:       c.question_type,
          body:                c.body,
          marks:               c.marks,
          negative_marks:      c.negative_marks,
          topic_tag:           c.topic_tag,
          difficulty:          c.difficulty,
          explanation:         c.explanation,
          numerical_answer:    c.numerical_answer,
          numerical_tolerance: c.numerical_tolerance,
        }).returning();
        if (c.options.length > 0) {
          await tx.insert(mockTestOptions).values(c.options.map((o: any) => ({ ...o, question_id: q!.id })));
        }
        out.push(q!);
      }
      return out;
    });

    res.status(201).json({ inserted: inserted.length });
  } catch (err) { handleApiError(err, res, next); }
});
