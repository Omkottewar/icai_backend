import { Router } from "express";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import {
  paperPresentations, paperTopics, ejournalIssues, ejournalTopics,
  resourceTopics, icaiLinkCards,
  resourceComments, resourceQuizzes, resourceQuizQuestions, resourceQuizOptions,
  resourceTopicSubscriptions,
  users, committees, files,
} from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { notifyAsync } from "../../lib/notify.js";

export const resourcesAdminRouter = Router();

// ─── Topics CRUD ─────────────────────────────────────────────────────────
resourcesAdminRouter.get("/topics", async (_req, res, next) => {
  try {
    const rows = await db.select().from(resourceTopics).orderBy(asc(resourceTopics.sort_order));
    res.json({ items: rows });
  } catch (err) { handleApiError(err, res, next); }
});

resourcesAdminRouter.post("/topics", async (req, res, next) => {
  try {
    const code = need(trim(req.body.code), "Code").toLowerCase().replace(/[^a-z0-9_]/g, "_");
    const name = need(trim(req.body.name), "Name");
    const description = trim(req.body.description) || null;
    const sort_order = Number.isFinite(Number(req.body.sort_order)) ? Math.trunc(Number(req.body.sort_order)) : 999;
    const [row] = await db.insert(resourceTopics).values({ code, name, description, sort_order }).returning();
    res.status(201).json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

resourcesAdminRouter.patch("/topics/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const patch: Record<string, any> = {};
    if (req.body.name !== undefined)        patch.name = need(trim(req.body.name), "Name");
    if (req.body.description !== undefined) patch.description = trim(req.body.description) || null;
    if (req.body.active !== undefined)      patch.active = !!req.body.active;
    if (req.body.sort_order !== undefined)  patch.sort_order = Math.trunc(Number(req.body.sort_order)) || 0;
    if (Object.keys(patch).length === 0) throw new ApiError(400, "Nothing to update");
    const [row] = await db.update(resourceTopics).set(patch).where(eq(resourceTopics.id, id)).returning();
    if (!row) throw new ApiError(404, "Topic not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// Deletion would cascade through paper_topics — usually too destructive.
// Soft-delete via active=false is the right move; the DELETE endpoint
// errors out if there are any associations, so admin sees the intent.
resourcesAdminRouter.delete("/topics/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [{ used }] = await db
      .select({ used: sql<number>`count(*)::int`.as("used") })
      .from(paperTopics).where(eq(paperTopics.topic_id, id));
    if ((used ?? 0) > 0) {
      throw new ApiError(400, `Cannot delete — ${used} paper(s) tagged with this topic. Set active=false instead.`);
    }
    const [row] = await db.delete(resourceTopics).where(eq(resourceTopics.id, id)).returning();
    if (!row) throw new ApiError(404, "Topic not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Link cards CRUD (curated icai.org pointers) ─────────────────────────
const LINK_CATEGORIES = ["circulars", "standards", "knowledge_repo", "other"];
resourcesAdminRouter.get("/link-cards", async (_req, res, next) => {
  try {
    const rows = await db.select().from(icaiLinkCards).orderBy(asc(icaiLinkCards.category), asc(icaiLinkCards.sort_order));
    res.json({ items: rows });
  } catch (err) { handleApiError(err, res, next); }
});

function parseLinkCardBody(input: any) {
  const category = trim(input.category);
  if (!LINK_CATEGORIES.includes(category)) throw new ApiError(400, `category must be one of: ${LINK_CATEGORIES.join(", ")}`);
  return {
    category,
    title:       need(trim(input.title), "Title"),
    description: trim(input.description) || null,
    url:         need(trim(input.url), "URL"),
    icon_emoji:  trim(input.icon_emoji) || null,
    sort_order:  Number.isFinite(Number(input.sort_order)) ? Math.trunc(Number(input.sort_order)) : 0,
    active:      input.active === undefined ? true : !!input.active,
  };
}

resourcesAdminRouter.post("/link-cards", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = parseLinkCardBody(req.body);
    const [row] = await db.insert(icaiLinkCards).values({ ...parsed, created_by: req.user!.id }).returning();
    res.status(201).json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

resourcesAdminRouter.patch("/link-cards/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const parsed = parseLinkCardBody(req.body);
    const [row] = await db.update(icaiLinkCards).set({ ...parsed, updated_at: new Date() }).where(eq(icaiLinkCards.id, id)).returning();
    if (!row) throw new ApiError(404, "Link card not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

resourcesAdminRouter.delete("/link-cards/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.delete(icaiLinkCards).where(eq(icaiLinkCards.id, id)).returning();
    if (!row) throw new ApiError(404, "Link card not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Papers — admin list (includes drafts + pending + rejected) ──────────
resourcesAdminRouter.get("/papers", async (req, res, next) => {
  try {
    const status = trim(req.query.status);
    const conds: any[] = [];
    if (status) conds.push(eq(paperPresentations.status, status as any));

    const rows = await db
      .select({
        id: paperPresentations.id,
        slug: paperPresentations.slug,
        title: paperPresentations.title,
        speaker_name: paperPresentations.speaker_name,
        status: paperPresentations.status,
        committee_id: paperPresentations.committee_id,
        committee_name: committees.name,
        submitted_by: paperPresentations.submitted_by,
        submitted_by_name: users.name,
        created_at: paperPresentations.created_at,
        published_at: paperPresentations.published_at,
        view_count: paperPresentations.view_count,
      })
      .from(paperPresentations)
      .leftJoin(committees, eq(committees.id, paperPresentations.committee_id))
      .leftJoin(users,      eq(users.id,      paperPresentations.submitted_by))
      .where(conds.length > 0 ? and(...conds) : undefined as any)
      .orderBy(desc(paperPresentations.created_at));
    res.json({ items: rows });
  } catch (err) { handleApiError(err, res, next); }
});

// Pending moderation queue — convenience filter.
resourcesAdminRouter.get("/papers/pending", async (_req, res, next) => {
  try {
    const rows = await db
      .select({
        id: paperPresentations.id,
        slug: paperPresentations.slug,
        title: paperPresentations.title,
        abstract: paperPresentations.abstract,
        speaker_name: paperPresentations.speaker_name,
        submitted_by_name: users.name,
        submitted_by_email: users.email,
        submitted_at: paperPresentations.created_at,
        pdf_file_id: paperPresentations.pdf_file_id,
      })
      .from(paperPresentations)
      .leftJoin(users, eq(users.id, paperPresentations.submitted_by))
      .where(eq(paperPresentations.status, "pending_review"))
      .orderBy(asc(paperPresentations.created_at));
    res.json({ items: rows });
  } catch (err) { handleApiError(err, res, next); }
});

// Approve a pending submission. Flip status → published, set timestamps,
// optionally publish a quiz at the same time (out of scope here — quiz
// authoring is a separate endpoint).
resourcesAdminRouter.post("/papers/:id/approve", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const [existing] = await db.select().from(paperPresentations).where(eq(paperPresentations.id, id)).limit(1);
    if (!existing) throw new ApiError(404, "Paper not found");
    if (existing.status === "published") return res.json({ ok: true, paper: existing });

    const [row] = await db.update(paperPresentations).set({
      status: "published",
      reviewed_by: req.user!.id,
      reviewed_at: new Date(),
      published_at: new Date(),
      updated_at: new Date(),
    }).where(eq(paperPresentations.id, id)).returning();

    // Notify the submitter that their paper is live.
    if (row.submitted_by && row.submitted_by !== req.user!.id) {
      notifyAsync({
        user_id: row.submitted_by,
        template_key: "paper_submission_approved",
        vars: {
          paper_title: row.title,
          paper_link:  `${process.env.APP_URL ?? ""}/resources/papers/${row.slug}`,
        },
        link_url: `/resources/papers/${row.slug}`,
      });
    }

    // Notify everyone subscribed to ANY topic this paper is tagged with.
    // Dedupe so a member who follows two relevant topics gets one email.
    const topicIds = (await db
      .select({ id: paperTopics.topic_id })
      .from(paperTopics)
      .where(eq(paperTopics.paper_id, id))
    ).map((r) => r.id);
    if (topicIds.length > 0) {
      const subs = await db
        .select({
          user_id: resourceTopicSubscriptions.user_id,
          topic_id: resourceTopicSubscriptions.topic_id,
          topic_name: resourceTopics.name,
        })
        .from(resourceTopicSubscriptions)
        .innerJoin(resourceTopics, eq(resourceTopics.id, resourceTopicSubscriptions.topic_id))
        .where(inArray(resourceTopicSubscriptions.topic_id, topicIds));
      const seen = new Set<string>();
      for (const s of subs) {
        if (seen.has(s.user_id)) continue;
        if (s.user_id === row.submitted_by) continue;            // already notified by approval mail
        seen.add(s.user_id);
        notifyAsync({
          user_id: s.user_id,
          template_key: "resource_new_in_topic",
          vars: {
            topic_name: s.topic_name,
            resource_type_label: "paper",
            resource_title: row.title,
            author_name:    row.speaker_name,
            resource_link:  `${process.env.APP_URL ?? ""}/resources/papers/${row.slug}`,
          },
          link_url: `/resources/papers/${row.slug}`,
        });
      }
    }

    res.json({ ok: true, paper: row });
  } catch (err) { handleApiError(err, res, next); }
});

// Reject — flip status, record reviewer + note, notify submitter.
resourcesAdminRouter.post("/papers/:id/reject", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const note = need(trim(req.body.review_note), "Review note (tell the submitter what to fix)");

    const [row] = await db.update(paperPresentations).set({
      status: "rejected",
      reviewed_by: req.user!.id,
      reviewed_at: new Date(),
      review_note: note,
      updated_at: new Date(),
    }).where(eq(paperPresentations.id, id)).returning();
    if (!row) throw new ApiError(404, "Paper not found");

    if (row.submitted_by) {
      notifyAsync({
        user_id: row.submitted_by,
        template_key: "paper_submission_rejected",
        vars: { paper_title: row.title, review_note: note },
      });
    }
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// Admin direct upload (skips moderation — admin's own content).
resourcesAdminRouter.post("/papers", async (req: AuthedRequest, res, next) => {
  try {
    const title = need(trim(req.body.title), "Title");
    const speaker_name = need(trim(req.body.speaker_name), "Speaker name");
    const abstract = trim(req.body.abstract) || null;
    const description = trim(req.body.description) || null;
    const pdf_file_id = trim(req.body.pdf_file_id) || null;
    const cover_file_id = trim(req.body.cover_file_id) || null;
    const committee_id = trim(req.body.committee_id) || null;
    const event_id = trim(req.body.event_id) || null;
    const committee_tag = trim(req.body.committee_tag) || null;
    const presented_on = trim(req.body.presented_on) || null;
    const author_designation = trim(req.body.author_designation) || null;
    const topic_ids: string[] = Array.isArray(req.body.topic_ids)
      ? req.body.topic_ids.map((s: any) => trim(s)).filter(Boolean) : [];

    const slug = await uniqueSlug(slugify(title));

    const created = await db.transaction(async (tx) => {
      const [paper] = await tx.insert(paperPresentations).values({
        slug, title, abstract, description,
        speaker_name, author_designation,
        committee_id, event_id, committee_tag,
        presented_on, pdf_file_id, cover_file_id,
        status: "published",
        published_at: new Date(),
        submitted_by: req.user!.id,
        reviewed_by: req.user!.id,
        reviewed_at: new Date(),
      }).returning();

      if (topic_ids.length > 0) {
        await tx.insert(paperTopics).values(
          topic_ids.map((tid) => ({ paper_id: paper.id, topic_id: tid })),
        );
      }
      return paper;
    });

    res.status(201).json({ item: created });
  } catch (err) { handleApiError(err, res, next); }
});

resourcesAdminRouter.patch("/papers/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const patch: Record<string, any> = { updated_at: new Date() };
    if (req.body.title !== undefined)        patch.title = need(trim(req.body.title), "Title");
    if (req.body.abstract !== undefined)     patch.abstract = trim(req.body.abstract) || null;
    if (req.body.description !== undefined)  patch.description = trim(req.body.description) || null;
    if (req.body.speaker_name !== undefined) patch.speaker_name = need(trim(req.body.speaker_name), "Speaker name");
    if (req.body.author_designation !== undefined) patch.author_designation = trim(req.body.author_designation) || null;
    if (req.body.pdf_file_id !== undefined)  patch.pdf_file_id = trim(req.body.pdf_file_id) || null;
    if (req.body.cover_file_id !== undefined) patch.cover_file_id = trim(req.body.cover_file_id) || null;
    if (req.body.committee_id !== undefined) patch.committee_id = trim(req.body.committee_id) || null;
    if (req.body.event_id !== undefined)     patch.event_id = trim(req.body.event_id) || null;
    if (req.body.committee_tag !== undefined) patch.committee_tag = trim(req.body.committee_tag) || null;
    if (req.body.presented_on !== undefined) patch.presented_on = trim(req.body.presented_on) || null;
    if (req.body.disclaimer_text !== undefined) patch.disclaimer_text = trim(req.body.disclaimer_text) || "Views expressed are personal";
    if (req.body.hidden !== undefined)       patch.hidden = !!req.body.hidden;

    const [row] = await db.update(paperPresentations).set(patch).where(eq(paperPresentations.id, id)).returning();
    if (!row) throw new ApiError(404, "Paper not found");

    // Update topics if provided. Wipe + recreate is fine — tiny row count.
    if (Array.isArray(req.body.topic_ids)) {
      const topic_ids: string[] = req.body.topic_ids.map((s: any) => trim(s)).filter(Boolean);
      await db.transaction(async (tx) => {
        await tx.delete(paperTopics).where(eq(paperTopics.paper_id, id));
        if (topic_ids.length > 0) {
          await tx.insert(paperTopics).values(topic_ids.map((tid) => ({ paper_id: id, topic_id: tid })));
        }
      });
    }

    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

resourcesAdminRouter.delete("/papers/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.delete(paperPresentations).where(eq(paperPresentations.id, id)).returning();
    if (!row) throw new ApiError(404, "Paper not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── E-journal admin ─────────────────────────────────────────────────────
resourcesAdminRouter.get("/ejournal-issues", async (_req, res, next) => {
  try {
    const rows = await db
      .select().from(ejournalIssues)
      .orderBy(desc(ejournalIssues.issue_year), desc(ejournalIssues.issue_quarter));
    res.json({ items: rows });
  } catch (err) { handleApiError(err, res, next); }
});

function parseEjournalBody(input: any) {
  const title = need(trim(input.title), "Title");
  const issue_label = need(trim(input.issue_label), "Issue label (e.g. 'Vol III, Issue 2 — Apr-Jun 2026')");
  const issue_year = Number(input.issue_year);
  if (!Number.isFinite(issue_year) || issue_year < 1990 || issue_year > 2100) throw new ApiError(400, "issue_year out of range");
  const issue_quarter = input.issue_quarter === undefined || input.issue_quarter === null || input.issue_quarter === ""
    ? null
    : (Number(input.issue_quarter) >= 1 && Number(input.issue_quarter) <= 4
        ? Math.trunc(Number(input.issue_quarter))
        : null);
  return {
    title, issue_label, issue_year, issue_quarter,
    cover_file_id: trim(input.cover_file_id) || null,
    pdf_file_id:   trim(input.pdf_file_id)   || null,
    editorial_summary: trim(input.editorial_summary) || null,
  };
}

resourcesAdminRouter.post("/ejournal-issues", async (req: AuthedRequest, res, next) => {
  try {
    const parsed = parseEjournalBody(req.body);
    const slug = await uniqueEjournalSlug(slugify(`${parsed.issue_label}-${parsed.title}`));
    const topic_ids: string[] = Array.isArray(req.body.topic_ids) ? req.body.topic_ids.map((s: any) => trim(s)).filter(Boolean) : [];

    const created = await db.transaction(async (tx) => {
      const [row] = await tx.insert(ejournalIssues).values({
        ...parsed, slug,
        status: "published",
        published_at: new Date(),
        created_by: req.user!.id,
      }).returning();
      if (topic_ids.length > 0) {
        await tx.insert(ejournalTopics).values(topic_ids.map((tid) => ({ issue_id: row.id, topic_id: tid })));
      }
      return row;
    });
    res.status(201).json({ item: created });
  } catch (err) { handleApiError(err, res, next); }
});

resourcesAdminRouter.patch("/ejournal-issues/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const parsed = parseEjournalBody(req.body);
    const topic_ids = Array.isArray(req.body.topic_ids) ? req.body.topic_ids.map((s: any) => trim(s)).filter(Boolean) : null;

    const updated = await db.transaction(async (tx) => {
      const [row] = await tx.update(ejournalIssues).set({ ...parsed, updated_at: new Date() }).where(eq(ejournalIssues.id, id)).returning();
      if (!row) throw new ApiError(404, "Issue not found");
      if (topic_ids) {
        await tx.delete(ejournalTopics).where(eq(ejournalTopics.issue_id, id));
        if (topic_ids.length > 0) {
          await tx.insert(ejournalTopics).values(topic_ids.map((tid: string) => ({ issue_id: id, topic_id: tid })));
        }
      }
      return row;
    });
    res.json({ item: updated });
  } catch (err) { handleApiError(err, res, next); }
});

resourcesAdminRouter.delete("/ejournal-issues/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.delete(ejournalIssues).where(eq(ejournalIssues.id, id)).returning();
    if (!row) throw new ApiError(404, "Issue not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Comments moderation (post-mod hide/delete) ──────────────────────────
resourcesAdminRouter.post("/comments/:id/hide", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.update(resourceComments).set({
      status: "hidden",
      hidden_by: req.user!.id,
      hidden_at: new Date(),
    }).where(eq(resourceComments.id, id)).returning();
    if (!row) throw new ApiError(404, "Comment not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

resourcesAdminRouter.post("/comments/:id/unhide", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.update(resourceComments).set({
      status: "visible", hidden_by: null, hidden_at: null,
    }).where(eq(resourceComments.id, id)).returning();
    if (!row) throw new ApiError(404, "Comment not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

resourcesAdminRouter.delete("/comments/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.delete(resourceComments).where(eq(resourceComments.id, id)).returning();
    if (!row) throw new ApiError(404, "Comment not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Quiz authoring ──────────────────────────────────────────────────────
// Quizzes are created per paper. Admin uploads questions + options; one
// option per question must be marked correct. Admin publishes when ready.
//
// Endpoint shapes (kept simple — bulk replace-all):
//   GET    /papers/:paperId/quiz              — fetch the quiz (incl. is_correct for admin)
//   PUT    /papers/:paperId/quiz              — create or replace the quiz + questions + options
//   POST   /papers/:paperId/quiz/publish      — flip is_published=true
//   POST   /papers/:paperId/quiz/unpublish    — flip is_published=false

resourcesAdminRouter.get("/papers/:paperId/quiz", async (req, res, next) => {
  try {
    const paperId = String(req.params.paperId);
    const [quiz] = await db.select().from(resourceQuizzes).where(eq(resourceQuizzes.paper_id, paperId)).limit(1);
    if (!quiz) return res.json({ quiz: null, questions: [] });

    const questions = await db.select().from(resourceQuizQuestions)
      .where(eq(resourceQuizQuestions.quiz_id, quiz.id))
      .orderBy(asc(resourceQuizQuestions.sort_order));
    const qIds = questions.map((q) => q.id);
    const opts = qIds.length === 0 ? [] : await db.select().from(resourceQuizOptions)
      .where(inArray(resourceQuizOptions.question_id, qIds))
      .orderBy(asc(resourceQuizOptions.sort_order));
    const optsByQ = new Map<string, typeof opts>();
    for (const o of opts) {
      const list = optsByQ.get(o.question_id) ?? [];
      list.push(o);
      optsByQ.set(o.question_id, list);
    }

    res.json({
      quiz,
      questions: questions.map((q) => ({
        ...q, options: optsByQ.get(q.id) ?? [],
      })),
    });
  } catch (err) { handleApiError(err, res, next); }
});

resourcesAdminRouter.put("/papers/:paperId/quiz", async (req: AuthedRequest, res, next) => {
  try {
    const paperId = String(req.params.paperId);
    const [paper] = await db.select({ id: paperPresentations.id })
      .from(paperPresentations).where(eq(paperPresentations.id, paperId)).limit(1);
    if (!paper) throw new ApiError(404, "Paper not found");

    const pass_threshold = Number.isFinite(Number(req.body.pass_threshold)) ? Math.trunc(Number(req.body.pass_threshold)) : 4;
    const cpe_credit_minutes = Number.isFinite(Number(req.body.cpe_credit_minutes)) ? Math.trunc(Number(req.body.cpe_credit_minutes)) : 30;
    const cooldown_hours = Number.isFinite(Number(req.body.cooldown_hours)) ? Math.trunc(Number(req.body.cooldown_hours)) : 24;

    const questions: Array<{ text: string; explanation?: string; options: Array<{ text: string; is_correct: boolean }> }> =
      Array.isArray(req.body.questions) ? req.body.questions : [];

    if (questions.length < 3) throw new ApiError(400, "A quiz needs at least 3 questions");
    if (questions.length > 12) throw new ApiError(400, "A quiz can have at most 12 questions");
    for (const q of questions) {
      if (!q.text || trim(q.text).length < 5) throw new ApiError(400, "Every question needs a text body (5+ chars)");
      if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 6) {
        throw new ApiError(400, `Question "${q.text.slice(0, 30)}…" must have 2-6 options`);
      }
      const correctCount = q.options.filter((o) => !!o.is_correct).length;
      if (correctCount !== 1) {
        throw new ApiError(400, `Question "${q.text.slice(0, 30)}…" must have exactly one correct option`);
      }
    }

    const saved = await db.transaction(async (tx) => {
      // Wipe-and-recreate. Question + option rows are tiny per quiz, so a
      // diff isn't worth the complexity.
      const [existing] = await tx.select().from(resourceQuizzes).where(eq(resourceQuizzes.paper_id, paperId)).limit(1);
      let quiz;
      if (existing) {
        const [updated] = await tx.update(resourceQuizzes).set({
          pass_threshold,
          question_count: questions.length,
          cpe_credit_minutes,
          cooldown_hours,
          updated_at: new Date(),
        }).where(eq(resourceQuizzes.id, existing.id)).returning();
        quiz = updated;
        await tx.delete(resourceQuizQuestions).where(eq(resourceQuizQuestions.quiz_id, quiz.id));
      } else {
        const [created] = await tx.insert(resourceQuizzes).values({
          paper_id: paperId,
          pass_threshold,
          question_count: questions.length,
          cpe_credit_minutes,
          cooldown_hours,
          created_by: req.user!.id,
        }).returning();
        quiz = created;
      }

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const [qRow] = await tx.insert(resourceQuizQuestions).values({
          quiz_id: quiz.id, sort_order: i,
          text: trim(q.text),
          explanation: trim(q.explanation) || null,
        }).returning();
        await tx.insert(resourceQuizOptions).values(
          q.options.map((o, j) => ({
            question_id: qRow.id, sort_order: j,
            text: trim(o.text),
            is_correct: !!o.is_correct,
          })),
        );
      }

      return quiz;
    });

    res.json({ ok: true, quiz: saved });
  } catch (err) { handleApiError(err, res, next); }
});

resourcesAdminRouter.post("/papers/:paperId/quiz/publish", async (req, res, next) => {
  try {
    const paperId = String(req.params.paperId);
    const [row] = await db.update(resourceQuizzes)
      .set({ is_published: true, updated_at: new Date() })
      .where(eq(resourceQuizzes.paper_id, paperId)).returning();
    if (!row) throw new ApiError(404, "No quiz on this paper yet");
    res.json({ ok: true, quiz: row });
  } catch (err) { handleApiError(err, res, next); }
});

resourcesAdminRouter.post("/papers/:paperId/quiz/unpublish", async (req, res, next) => {
  try {
    const paperId = String(req.params.paperId);
    const [row] = await db.update(resourceQuizzes)
      .set({ is_published: false, updated_at: new Date() })
      .where(eq(resourceQuizzes.paper_id, paperId)).returning();
    if (!row) throw new ApiError(404, "No quiz on this paper yet");
    res.json({ ok: true, quiz: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── helpers ─────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "item";
}

async function uniqueSlug(base: string): Promise<string> {
  let i = 1;
  while (i <= 60) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const [exists] = await db.select({ id: paperPresentations.id })
      .from(paperPresentations).where(eq(paperPresentations.slug, candidate)).limit(1);
    if (!exists) return candidate;
    i++;
  }
  throw new ApiError(500, "Could not generate a unique slug");
}

async function uniqueEjournalSlug(base: string): Promise<string> {
  let i = 1;
  while (i <= 60) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const [exists] = await db.select({ id: ejournalIssues.id })
      .from(ejournalIssues).where(eq(ejournalIssues.slug, candidate)).limit(1);
    if (!exists) return candidate;
    i++;
  }
  throw new ApiError(500, "Could not generate a unique slug");
}
