// Student-facing mock-test attempt lifecycle.
//
//   POST   /api/mock-tests/:id/attempt        — start or resume
//   GET    /api/attempts/:attemptId           — full attempt state + questions (no correct flags)
//   PATCH  /api/attempts/:attemptId/answer    — upsert a single answer (Save & Next)
//   POST   /api/attempts/:attemptId/blur      — incrementing tab-blur counter (anti-cheat signal)
//   POST   /api/attempts/:attemptId/submit    — finalize + auto-grade
//   GET    /api/attempts/:attemptId/review    — review mode (correct answers + explanations)
//                                               only available when results published
//
// Ownership: every endpoint checks that the attempt belongs to req.user.
// Server-enforced timer: expires_at is set on start; submit / saves
// past expires_at coerce to auto-submit. Never trust client timer.

import { Router } from "express";
import { randomUUID, randomBytes } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  mockTests,
  mockTestRegistrations,
  mockTestQuestions,
  mockTestOptions,
  mockTestAttempts,
  mockTestAnswers,
} from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { grade } from "../lib/mockTestGrader.js";

export const mockTestAttemptsRouter = Router();

// ─── Helper: load attempt and assert ownership ─────────────────────────────
async function loadOwnedAttempt(attemptId: string, userId: string) {
  const [row] = await db
    .select()
    .from(mockTestAttempts)
    .where(eq(mockTestAttempts.id, attemptId))
    .limit(1);
  if (!row) throw new ApiError(404, "Attempt not found");
  if (row.user_id !== userId) throw new ApiError(403, "This attempt belongs to another user");
  return row;
}

// Stale "in_progress" attempts past their expires_at are silently flipped
// to 'auto_submitted' before any further work. Saves a round-trip and
// guarantees the auto-submit path runs for late savers.
async function coerceExpired(attempt: typeof mockTestAttempts.$inferSelect) {
  if (attempt.status === "in_progress" && new Date(attempt.expires_at).getTime() <= Date.now()) {
    return autoSubmitAttempt(attempt.id);
  }
  return attempt;
}

// Strip questions to a student-safe shape (no is_correct on options, no
// numerical_answer, no explanation). Used by the live-attempt endpoint.
function shapeStudentQuestion(
  q: typeof mockTestQuestions.$inferSelect,
  opts: Array<typeof mockTestOptions.$inferSelect>,
) {
  const base = {
    id: q.id,
    question_no: q.question_no,
    question_type: q.question_type,
    body: q.body,
    marks: q.marks,
    negative_marks: q.negative_marks,
    topic_tag: q.topic_tag,
    difficulty: q.difficulty,
  };
  if (q.question_type === "mcq") {
    return {
      ...base,
      options: opts
        .filter((o) => o.question_id === q.id)
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((o) => ({ id: o.id, label: o.option_label, body: o.body })),
    };
  }
  return base;
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/mock-tests/:id/attempt — start or resume
// ════════════════════════════════════════════════════════════════════════════
mockTestAttemptsRouter.post("/mock-tests/:id/attempt", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Mock test id");
    const userId = req.user!.id;

    const [test] = await db.select().from(mockTests).where(and(eq(mockTests.id, id), isNull(mockTests.deleted_at))).limit(1);
    if (!test) throw new ApiError(404, "Mock test not found");
    if (!test.supports_online) {
      throw new ApiError(400, "This mock test isn't configured for online attempts");
    }
    if (test.status === "cancelled") throw new ApiError(400, "This test was cancelled");

    // Caller must be registered for the test before starting an attempt.
    const [reg] = await db
      .select()
      .from(mockTestRegistrations)
      .where(and(
        eq(mockTestRegistrations.mock_test_id, id),
        eq(mockTestRegistrations.user_id, userId),
      ))
      .limit(1);
    if (!reg || reg.status === "cancelled") {
      throw new ApiError(403, "Please register for this mock test before starting an attempt");
    }

    // Resume an existing in-progress attempt if there is one.
    const [existing] = await db
      .select()
      .from(mockTestAttempts)
      .where(and(
        eq(mockTestAttempts.mock_test_id, id),
        eq(mockTestAttempts.user_id, userId),
        eq(mockTestAttempts.status, "in_progress"),
      ))
      .limit(1);

    if (existing) {
      const coerced = await coerceExpired(existing);
      // Resume: hand back the same attempt + its token. The student's
      // existing answers come back via GET /attempts/:id below.
      return res.json({ attempt: coerced });
    }

    // Otherwise: open a fresh attempt. expires_at = now + duration_mins.
    // (Server-trusted timer — client display is decorative.)
    const expiresAt = new Date(Date.now() + (test.duration_mins ?? 180) * 60_000);
    const token = randomBytes(24).toString("base64url");
    const [created] = await db
      .insert(mockTestAttempts)
      .values({
        mock_test_id:    id,
        user_id:         userId,
        registration_id: reg.id,
        attempt_token:   token,
        expires_at:      expiresAt,
        status:          "in_progress",
      })
      .returning();
    res.status(201).json({ attempt: created });
  } catch (err) { handleApiError(err, res, next); }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/attempts/:attemptId — full attempt state for the live UI
// Returns: attempt + questions (sanitised) + the student's saved answers
// ════════════════════════════════════════════════════════════════════════════
mockTestAttemptsRouter.get("/attempts/:attemptId", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const aid = need(trim(req.params.attemptId), "Attempt id");
    const attempt = await coerceExpired(await loadOwnedAttempt(aid, req.user!.id));

    const [test] = await db.select().from(mockTests).where(eq(mockTests.id, attempt.mock_test_id)).limit(1);
    if (!test) throw new ApiError(404, "Parent test missing");

    const questions = await db
      .select()
      .from(mockTestQuestions)
      .where(and(eq(mockTestQuestions.mock_test_id, attempt.mock_test_id), isNull(mockTestQuestions.deleted_at)))
      .orderBy(asc(mockTestQuestions.question_no));

    const qIds = questions.map((q) => q.id);
    const options = qIds.length === 0 ? [] : await db
      .select()
      .from(mockTestOptions)
      .where(inArray(mockTestOptions.question_id, qIds));

    const answers = await db
      .select()
      .from(mockTestAnswers)
      .where(eq(mockTestAnswers.attempt_id, attempt.id));

    res.json({
      attempt,
      test: {
        id: test.id,
        title: test.title,
        duration_mins: test.duration_mins,
        max_score: test.max_score,
      },
      questions: questions.map((q) => shapeStudentQuestion(q, options)),
      answers: answers.map((a) => ({
        question_id: a.question_id,
        selected_option_ids: a.selected_option_ids,
        numerical_value: a.numerical_value,
        text_answer: a.text_answer,
        marked_for_review: a.marked_for_review,
        time_spent_ms: a.time_spent_ms,
      })),
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ════════════════════════════════════════════════════════════════════════════
// PATCH /api/attempts/:attemptId/answer — save/update one answer
// Body: { question_id, selected_option_ids?, numerical_value?, text_answer?,
//         marked_for_review?, time_spent_ms? }
// ════════════════════════════════════════════════════════════════════════════
mockTestAttemptsRouter.patch("/attempts/:attemptId/answer", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const aid = need(trim(req.params.attemptId), "Attempt id");
    const attempt = await coerceExpired(await loadOwnedAttempt(aid, req.user!.id));
    if (attempt.status !== "in_progress") {
      throw new ApiError(400, "This attempt has been submitted; answers can no longer be changed");
    }

    const qid = need(trim(req.body?.question_id), "question_id");
    // Sanity: question must belong to the attempt's test.
    const [q] = await db
      .select({ id: mockTestQuestions.id, question_type: mockTestQuestions.question_type, mock_test_id: mockTestQuestions.mock_test_id })
      .from(mockTestQuestions)
      .where(and(eq(mockTestQuestions.id, qid), isNull(mockTestQuestions.deleted_at)))
      .limit(1);
    if (!q || q.mock_test_id !== attempt.mock_test_id) {
      throw new ApiError(400, "Question doesn't belong to this attempt");
    }

    const selectedRaw = req.body?.selected_option_ids;
    const selected = Array.isArray(selectedRaw)
      ? selectedRaw.filter((x: unknown) => typeof x === "string")
      : null;
    const numericalRaw = req.body?.numerical_value;
    const numericalValue =
      numericalRaw == null || numericalRaw === "" ? null : Number.isFinite(Number(numericalRaw)) ? String(numericalRaw) : null;
    const textAnswer = typeof req.body?.text_answer === "string" ? req.body.text_answer : null;
    const markedForReview = !!req.body?.marked_for_review;
    const timeSpentMs = Math.max(0, Math.min(60 * 60_000, Number(req.body?.time_spent_ms ?? 0)));

    // Upsert: one row per (attempt, question). We rely on the partial
    // UNIQUE constraint added in migration 0047.
    await db
      .insert(mockTestAnswers)
      .values({
        attempt_id: attempt.id,
        question_id: qid,
        selected_option_ids: selected,
        numerical_value: numericalValue,
        text_answer: textAnswer,
        marked_for_review: markedForReview,
        time_spent_ms: timeSpentMs,
      })
      .onConflictDoUpdate({
        target: [mockTestAnswers.attempt_id, mockTestAnswers.question_id],
        set: {
          selected_option_ids: selected,
          numerical_value: numericalValue,
          text_answer: textAnswer,
          marked_for_review: markedForReview,
          time_spent_ms: sql`${mockTestAnswers.time_spent_ms} + ${timeSpentMs}`,
          updated_at: new Date(),
        },
      });

    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ════════════════════════════════════════════════════════════════════════════
// POST /api/attempts/:attemptId/blur — anti-cheat blur counter
// ════════════════════════════════════════════════════════════════════════════
mockTestAttemptsRouter.post("/attempts/:attemptId/blur", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const aid = need(trim(req.params.attemptId), "Attempt id");
    await loadOwnedAttempt(aid, req.user!.id); // ownership check
    await db.update(mockTestAttempts)
      .set({ tab_blur_count: sql`${mockTestAttempts.tab_blur_count} + 1` })
      .where(eq(mockTestAttempts.id, aid));
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ════════════════════════════════════════════════════════════════════════════
// Internal: auto-submit + grade one attempt. Used by submit endpoint and
// by coerceExpired() above.
// ════════════════════════════════════════════════════════════════════════════
async function autoSubmitAttempt(attemptId: string) {
  return db.transaction(async (tx) => {
    const [attempt] = await tx.select().from(mockTestAttempts).where(eq(mockTestAttempts.id, attemptId)).limit(1);
    if (!attempt) throw new ApiError(404, "Attempt not found");
    if (attempt.status !== "in_progress") return attempt; // already done

    // Load questions + correct options + the student's answers.
    const questions = await tx
      .select()
      .from(mockTestQuestions)
      .where(and(eq(mockTestQuestions.mock_test_id, attempt.mock_test_id), isNull(mockTestQuestions.deleted_at)));
    const qIds = questions.map((q) => q.id);
    const options = qIds.length === 0 ? [] : await tx
      .select()
      .from(mockTestOptions)
      .where(inArray(mockTestOptions.question_id, qIds));
    const answers = await tx
      .select()
      .from(mockTestAnswers)
      .where(eq(mockTestAnswers.attempt_id, attempt.id));

    // Build correct-option-id map per question.
    const correctByQ = new Map<string, string[]>();
    for (const o of options) {
      if (!o.is_correct) continue;
      const arr = correctByQ.get(o.question_id) ?? [];
      arr.push(o.id);
      correctByQ.set(o.question_id, arr);
    }

    const result = grade(
      questions.map((q) => ({
        id: q.id,
        question_type: q.question_type as any,
        marks: q.marks,
        negative_marks: Number(q.negative_marks ?? 0),
        correct_option_ids: correctByQ.get(q.id) ?? [],
        numerical_answer: q.numerical_answer == null ? null : Number(q.numerical_answer),
        numerical_tolerance: Number(q.numerical_tolerance ?? 0),
      })),
      answers.map((a) => ({
        question_id: a.question_id,
        selected_option_ids: a.selected_option_ids,
        numerical_value: a.numerical_value == null ? null : Number(a.numerical_value),
        text_answer: a.text_answer,
      })),
    );

    // Persist per-answer marks for objective questions.
    for (const r of result.answers) {
      if (r.marks_awarded === null) continue;
      await tx
        .insert(mockTestAnswers)
        .values({
          attempt_id: attempt.id,
          question_id: r.question_id,
          marks_awarded: String(r.marks_awarded),
        })
        .onConflictDoUpdate({
          target: [mockTestAnswers.attempt_id, mockTestAnswers.question_id],
          set: { marks_awarded: String(r.marks_awarded), updated_at: new Date() },
        });
    }

    const wasExpired = new Date(attempt.expires_at).getTime() <= Date.now();
    const [updated] = await tx
      .update(mockTestAttempts)
      .set({
        status:       wasExpired ? "auto_submitted" : "submitted",
        submitted_at: new Date(),
        score_auto:   String(result.score_auto),
        score_total:  String(result.score_auto), // initial; manual marks add later
        graded_at:    new Date(),
      })
      .where(eq(mockTestAttempts.id, attempt.id))
      .returning();
    return updated!;
  });
}

// ════════════════════════════════════════════════════════════════════════════
// POST /api/attempts/:attemptId/submit
// ════════════════════════════════════════════════════════════════════════════
mockTestAttemptsRouter.post("/attempts/:attemptId/submit", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const aid = need(trim(req.params.attemptId), "Attempt id");
    await loadOwnedAttempt(aid, req.user!.id); // ownership check
    const updated = await autoSubmitAttempt(aid);
    res.json({ attempt: updated });
  } catch (err) { handleApiError(err, res, next); }
});

// ════════════════════════════════════════════════════════════════════════════
// GET /api/attempts/:attemptId/review — show correct answers + explanations
// Only available once the parent test's result_published_at is set.
// ════════════════════════════════════════════════════════════════════════════
mockTestAttemptsRouter.get("/attempts/:attemptId/review", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const aid = need(trim(req.params.attemptId), "Attempt id");
    const attempt = await loadOwnedAttempt(aid, req.user!.id);
    if (attempt.status === "in_progress") {
      throw new ApiError(400, "Submit your attempt before requesting the review");
    }

    const [test] = await db.select().from(mockTests).where(eq(mockTests.id, attempt.mock_test_id)).limit(1);
    if (!test) throw new ApiError(404, "Parent test missing");
    if (!test.result_published_at) {
      throw new ApiError(403, "The review opens after results are published");
    }

    const questions = await db
      .select()
      .from(mockTestQuestions)
      .where(and(eq(mockTestQuestions.mock_test_id, attempt.mock_test_id), isNull(mockTestQuestions.deleted_at)))
      .orderBy(asc(mockTestQuestions.question_no));
    const qIds = questions.map((q) => q.id);
    const options = qIds.length === 0 ? [] : await db
      .select()
      .from(mockTestOptions)
      .where(inArray(mockTestOptions.question_id, qIds));
    const answers = await db
      .select()
      .from(mockTestAnswers)
      .where(eq(mockTestAnswers.attempt_id, attempt.id));

    res.json({
      attempt,
      test: {
        id: test.id,
        title: test.title,
        max_score: test.max_score,
      },
      questions: questions.map((q) => ({
        ...q,
        options: options
          .filter((o) => o.question_id === q.id)
          .sort((a, b) => a.sort_order - b.sort_order),
      })),
      answers,
    });
  } catch (err) { handleApiError(err, res, next); }
});
