import { Router } from "express";
import { and, asc, desc, eq, gte, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  paperPresentations, paperTopics, ejournalIssues, ejournalTopics,
  resourceTopics, icaiLinkCards,
  resourceBookmarks, resourceTopicSubscriptions, resourceComments,
  resourceQuizzes, resourceQuizQuestions, resourceQuizOptions, resourceQuizAttempts,
  files, events, committees, users,
} from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { storage } from "../lib/storage.js";
import { notifyAsync } from "../lib/notify.js";
import { randomUUID } from "node:crypto";

export const resourcesRouter = Router();

const fileUrl = (path: string | null) => (path ? storage().url(path) : null);
const RESOURCE_TYPES = ["paper", "ejournal"] as const;
type ResourceType = (typeof RESOURCE_TYPES)[number];
function pickResourceType(v: unknown): ResourceType {
  return RESOURCE_TYPES.includes(v as any) ? (v as ResourceType) : "paper";
}

// ─── Topics ──────────────────────────────────────────────────────────────
// Public catalogue. Shown as filter chips on the Resources page and as
// the topic dropdown in the member-submission form. Includes a per-topic
// paper count so the chip can show "GST · 14".
resourcesRouter.get("/topics", async (_req, res, next) => {
  try {
    const counts = await db
      .select({
        topic_id: paperTopics.topic_id,
        paper_count: sql<number>`count(*)::int`.as("paper_count"),
      })
      .from(paperTopics)
      .innerJoin(paperPresentations, eq(paperPresentations.id, paperTopics.paper_id))
      .where(and(
        eq(paperPresentations.status, "published"),
        eq(paperPresentations.hidden, false),
      ))
      .groupBy(paperTopics.topic_id);
    const countMap = new Map(counts.map((c) => [c.topic_id, c.paper_count]));

    const rows = await db
      .select()
      .from(resourceTopics)
      .where(eq(resourceTopics.active, true))
      .orderBy(asc(resourceTopics.sort_order));

    res.json({
      items: rows.map((r) => ({
        id: r.id, code: r.code, name: r.name, description: r.description,
        paper_count: countMap.get(r.id) ?? 0,
      })),
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Smart link-out cards (icai.org curated) ─────────────────────────────
resourcesRouter.get("/link-cards", async (_req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(icaiLinkCards)
      .where(eq(icaiLinkCards.active, true))
      .orderBy(asc(icaiLinkCards.category), asc(icaiLinkCards.sort_order));
    // Group by category so the frontend can render Circulars / Standards /
    // Knowledge Repo as separate sections without a second pass.
    const grouped: Record<string, typeof rows> = {};
    for (const r of rows) {
      (grouped[r.category] ??= []).push(r);
    }
    res.json({ groups: grouped, total: rows.length });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Papers — public list ─────────────────────────────────────────────────
// Filters:
//   ?q=             — fuzzy title/abstract/speaker search
//   ?topic=gst      — by topic code (or comma-separated for OR semantics)
//   ?year=2026      — by year of presentation
//   ?committee_id=  — by organising committee
//   ?sort=recent|popular   — default: recent
//   ?page=1&pageSize=24
//
// Only returns rows in status='published' AND hidden=false. Drafts and
// pending submissions are hidden from the public list (admin sees them
// in the moderation queue).
resourcesRouter.get("/papers", async (req, res, next) => {
  try {
    const q          = trim(req.query.q);
    const topicCodes = trim(req.query.topic).split(",").map((s) => s.trim()).filter(Boolean);
    const year       = Number(req.query.year);
    const committee  = trim(req.query.committee_id);
    const sort       = trim(req.query.sort) === "popular" ? "popular" : "recent";
    const page       = Math.max(1, Number(req.query.page) || 1);
    const pageSize   = Math.min(60, Math.max(6, Number(req.query.pageSize) || 24));
    const offset     = (page - 1) * pageSize;

    const conds: any[] = [
      eq(paperPresentations.status, "published"),
      eq(paperPresentations.hidden, false),
    ];
    if (q) {
      conds.push(or(
        ilike(paperPresentations.title, `%${q}%`),
        ilike(paperPresentations.abstract, `%${q}%`),
        ilike(paperPresentations.speaker_name, `%${q}%`),
      )!);
    }
    if (Number.isFinite(year) && year > 1900) {
      conds.push(sql`EXTRACT(YEAR FROM ${paperPresentations.presented_on}) = ${year}`);
    }
    if (committee) conds.push(eq(paperPresentations.committee_id, committee));
    // Topic filter is the trickiest — we need to limit papers whose id
    // appears in paper_topics with any of the requested topic codes.
    // Resolve codes → ids first so the IN clause is bounded.
    if (topicCodes.length > 0) {
      const topicRows = await db
        .select({ id: resourceTopics.id })
        .from(resourceTopics)
        .where(inArray(resourceTopics.code, topicCodes));
      const topicIds = topicRows.map((r) => r.id);
      if (topicIds.length === 0) {
        return res.json({ items: [], total: 0, page, pageSize });
      }
      // Drizzle's `sql` tag expands a JS array into a comma-separated
      // parameter list (`($1, $2, ...)`), NOT a single array-typed bind
      // — so `ANY(${arr})` becomes `ANY(($1, $2))` which Postgres
      // rejects: 42809 "op ANY/ALL requires array on right side" for
      // two+ items and 22P02 "malformed array literal" for one. The
      // safe fix is an explicit IN-list built with sql.join.
      const topicIdList = sql.join(topicIds.map((id) => sql`${id}::uuid`), sql`, `);
      conds.push(sql`EXISTS (
        SELECT 1 FROM ${paperTopics}
        WHERE ${paperTopics.paper_id} = ${paperPresentations.id}
          AND ${paperTopics.topic_id} IN (${topicIdList})
      )`);
    }

    const orderBy = sort === "popular"
      ? [desc(paperPresentations.view_count), desc(paperPresentations.published_at)]
      : [desc(paperPresentations.published_at), desc(paperPresentations.presented_on)];

    const rows = await db
      .select({
        id:            paperPresentations.id,
        slug:          paperPresentations.slug,
        title:         paperPresentations.title,
        abstract:      paperPresentations.abstract,
        speaker_name:  paperPresentations.speaker_name,
        author_designation: paperPresentations.author_designation,
        author_user_id: paperPresentations.author_user_id,
        author_name:   users.name,
        committee_tag: paperPresentations.committee_tag,
        committee_id:  paperPresentations.committee_id,
        committee_name: committees.name,
        event_id:      paperPresentations.event_id,
        event_title:   events.title,
        presented_on:  paperPresentations.presented_on,
        published_at:  paperPresentations.published_at,
        view_count:    paperPresentations.view_count,
        cover_path:    files.storage_path,
      })
      .from(paperPresentations)
      .leftJoin(users,      eq(users.id,      paperPresentations.author_user_id))
      .leftJoin(committees, eq(committees.id, paperPresentations.committee_id))
      .leftJoin(events,     eq(events.id,     paperPresentations.event_id))
      .leftJoin(files,      eq(files.id,      paperPresentations.cover_file_id))
      .where(and(...conds))
      .orderBy(...orderBy)
      .limit(pageSize)
      .offset(offset);

    // Attach topics per row. One round-trip via IN-list.
    const ids = rows.map((r) => r.id);
    const topicMap = new Map<string, Array<{ code: string; name: string }>>();
    if (ids.length > 0) {
      const tags = await db
        .select({
          paper_id: paperTopics.paper_id,
          code:     resourceTopics.code,
          name:     resourceTopics.name,
        })
        .from(paperTopics)
        .innerJoin(resourceTopics, eq(resourceTopics.id, paperTopics.topic_id))
        .where(inArray(paperTopics.paper_id, ids));
      for (const t of tags) {
        const list = topicMap.get(t.paper_id) ?? [];
        list.push({ code: t.code, name: t.name });
        topicMap.set(t.paper_id, list);
      }
    }

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(paperPresentations)
      .where(and(...conds));

    res.json({
      items: rows.map((r) => ({
        id: r.id, slug: r.slug, title: r.title, abstract: r.abstract,
        speaker_name: r.speaker_name,
        author_designation: r.author_designation,
        author: r.author_user_id ? { id: r.author_user_id, name: r.author_name } : null,
        committee_tag: r.committee_tag,
        committee: r.committee_id ? { id: r.committee_id, name: r.committee_name } : null,
        event:     r.event_id     ? { id: r.event_id,     title: r.event_title  } : null,
        presented_on: r.presented_on,
        published_at: r.published_at,
        view_count:   r.view_count,
        cover_url:    fileUrl(r.cover_path),
        topics:       topicMap.get(r.id) ?? [],
      })),
      total, page, pageSize,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Papers — list my submissions ────────────────────────────────────────
// MUST be registered before /papers/:slug below, otherwise Express
// matches the slug route first with slug="mine" and the handler 404s.
// So a member can see "approved / pending / rejected" status on each of
// their submissions and resubmit after a rejection.
resourcesRouter.get("/papers/mine", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db
      .select({
        id: paperPresentations.id,
        slug: paperPresentations.slug,
        title: paperPresentations.title,
        status: paperPresentations.status,
        review_note: paperPresentations.review_note,
        submitted_at: paperPresentations.created_at,
        reviewed_at: paperPresentations.reviewed_at,
        view_count: paperPresentations.view_count,
      })
      .from(paperPresentations)
      .where(eq(paperPresentations.submitted_by, req.user!.id))
      .orderBy(desc(paperPresentations.created_at));
    res.json({ items: rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Papers — public detail by slug ──────────────────────────────────────
// Increments view_count on each successful read (best-effort — the side
// effect is fire-and-forget so a slow update doesn't delay the response).
resourcesRouter.get("/papers/:slug", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);

    const [row] = await db
      .select({
        id:            paperPresentations.id,
        slug:          paperPresentations.slug,
        title:         paperPresentations.title,
        abstract:      paperPresentations.abstract,
        description:   paperPresentations.description,
        speaker_name:  paperPresentations.speaker_name,
        author_designation: paperPresentations.author_designation,
        author_user_id: paperPresentations.author_user_id,
        author_name:   users.name,
        author_email:  users.email,
        committee_tag: paperPresentations.committee_tag,
        committee_id:  paperPresentations.committee_id,
        committee_name: committees.name,
        event_id:      paperPresentations.event_id,
        event_title:   events.title,
        event_slug:    events.slug,
        presented_on:  paperPresentations.presented_on,
        published_at:  paperPresentations.published_at,
        view_count:    paperPresentations.view_count,
        disclaimer_text: paperPresentations.disclaimer_text,
        pdf_path:      files.storage_path,
        pdf_name:      files.name,
        cover_path:    sql<string | null>`(SELECT storage_path FROM ${files} WHERE id = ${paperPresentations.cover_file_id})`,
      })
      .from(paperPresentations)
      .leftJoin(users,      eq(users.id,      paperPresentations.author_user_id))
      .leftJoin(committees, eq(committees.id, paperPresentations.committee_id))
      .leftJoin(events,     eq(events.id,     paperPresentations.event_id))
      .leftJoin(files,      eq(files.id,      paperPresentations.pdf_file_id))
      .where(and(
        eq(paperPresentations.slug, slug),
        eq(paperPresentations.status, "published"),
        eq(paperPresentations.hidden, false),
      ))
      .limit(1);

    if (!row) throw new ApiError(404, "Paper not found");

    // Topics for this paper.
    const topics = await db
      .select({ code: resourceTopics.code, name: resourceTopics.name })
      .from(paperTopics)
      .innerJoin(resourceTopics, eq(resourceTopics.id, paperTopics.topic_id))
      .where(eq(paperTopics.paper_id, row.id));

    // Fire-and-forget view counter — don't block the response.
    void db.update(paperPresentations)
      .set({ view_count: sql`${paperPresentations.view_count} + 1` })
      .where(eq(paperPresentations.id, row.id))
      .catch(() => { /* counter drift is fine */ });

    res.json({
      paper: {
        id: row.id, slug: row.slug, title: row.title,
        abstract: row.abstract, description: row.description,
        speaker_name: row.speaker_name,
        author_designation: row.author_designation,
        author: row.author_user_id
          ? { id: row.author_user_id, name: row.author_name, email: row.author_email }
          : null,
        committee_tag: row.committee_tag,
        committee: row.committee_id ? { id: row.committee_id, name: row.committee_name } : null,
        event:     row.event_id     ? { id: row.event_id, title: row.event_title, slug: row.event_slug } : null,
        presented_on: row.presented_on,
        published_at: row.published_at,
        view_count:   row.view_count + 1,  // optimistic — reflect the increment we just queued
        disclaimer_text: row.disclaimer_text,
        pdf_url:      fileUrl(row.pdf_path),
        pdf_name:     row.pdf_name,
        cover_url:    fileUrl(row.cover_path),
        topics,
      },
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Papers — PDF upload for member submissions ──────────────────────────
// Member-facing file upload, narrowly scoped: PDF only, 15 MB cap, written
// to the dedicated `paper-submissions` bucket so admin file ops don't see
// uploads waiting for moderation. Returns just { id, name, size_bytes } —
// the URL is intentionally not echoed back; the client only needs the id
// to attach to the paper submission payload.
//
// The admin-side /api/admin/files endpoint stays admin-only; this endpoint
// is the member equivalent with much stricter validation.
const PDF_MAX_BYTES = 15 * 1024 * 1024;

resourcesRouter.post("/upload-pdf", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    // Role gate — paper upload is the file-staging half of the member-only
    // paper-submission flow below. Gating the upload too prevents wrong-role
    // users from filling the paper-submissions bucket with orphan PDFs.
    const role = req.user!.primary_role;
    if (role !== "member" && role !== "admin") {
      throw new ApiError(403, "Paper submission is open to ICAI members only");
    }

    const name     = need(trim(req.body.name), "Filename");
    const mimeType = trim(req.body.mime_type);
    if (mimeType !== "application/pdf") {
      throw new ApiError(400, "Only PDF files are accepted");
    }
    const dataB64: string = typeof req.body.data_base64 === "string" ? req.body.data_base64 : "";
    if (!dataB64) throw new ApiError(400, "File data is required");

    const stripped = dataB64.replace(/^data:[^;]+;base64,/, "");
    const buf = Buffer.from(stripped, "base64");
    if (buf.length === 0) throw new ApiError(400, "File data is empty or invalid base64");
    if (buf.length > PDF_MAX_BYTES) {
      throw new ApiError(400, `PDF exceeds ${Math.round(PDF_MAX_BYTES / (1024 * 1024))} MB limit`);
    }

    // Tiny PDF magic-byte check so a renamed .jpg can't sneak through.
    // PDF files always start with %PDF- (0x25 0x50 0x44 0x46 0x2D).
    if (buf.length < 5
      || buf[0] !== 0x25 || buf[1] !== 0x50 || buf[2] !== 0x44 || buf[3] !== 0x46 || buf[4] !== 0x2D) {
      throw new ApiError(400, "File doesn't look like a PDF (bad header)");
    }

    const bucket = "paper-submissions";
    const ext = (name.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? ".pdf").toLowerCase();
    const filename = `${randomUUID()}${ext}`;
    const storage_path = await storage().put(bucket, filename, buf, mimeType);

    const [row] = await db.insert(files).values({
      name,
      mime_type:    mimeType,
      size_bytes:   buf.length,
      storage_path,
      bucket,
      uploaded_by:  req.user!.id,
    }).returning();

    res.status(201).json({
      id:         row.id,
      name:       row.name,
      size_bytes: row.size_bytes,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Papers — member submission ──────────────────────────────────────────
// Members upload their own papers. Goes straight to status='pending_review';
// admin reviews via the moderation queue. The submitter becomes the author.
//
// Body: { title, abstract, description?, pdf_file_id, cover_file_id?,
//         event_id?, presented_on?, committee_id?, author_designation?,
//         topic_ids: [...] }
resourcesRouter.post("/papers/submit", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    // Role gate — paper authorship is a member-only feature (catalogue
    // §1.2 "newsletter contribution"). Students / employers / other roles
    // can read papers but cannot submit them. Admin allowed for seeding /
    // backfill of historical papers.
    const role = req.user!.primary_role;
    if (role !== "member" && role !== "admin") {
      throw new ApiError(403, "Paper submission is open to ICAI members only");
    }

    const userId = req.user!.id;
    const title = need(trim(req.body.title), "Title");
    if (title.length > 300) throw new ApiError(400, "Title is too long (max 300 chars)");
    const abstract = need(trim(req.body.abstract), "Abstract");
    if (abstract.length > 1500) throw new ApiError(400, "Abstract is too long (max 1500 chars)");
    const pdf_file_id = need(trim(req.body.pdf_file_id), "PDF file");

    const description       = trim(req.body.description) || null;
    const cover_file_id     = trim(req.body.cover_file_id) || null;
    const event_id          = trim(req.body.event_id) || null;
    const committee_id      = trim(req.body.committee_id) || null;
    const author_designation = trim(req.body.author_designation) || null;
    const presented_on_raw  = trim(req.body.presented_on);
    const presented_on = presented_on_raw ? presented_on_raw.slice(0, 10) : null;

    const topic_ids: string[] = Array.isArray(req.body.topic_ids)
      ? req.body.topic_ids.map((s: any) => trim(s)).filter(Boolean)
      : [];
    if (topic_ids.length === 0) throw new ApiError(400, "Pick at least one topic");
    if (topic_ids.length > 4)   throw new ApiError(400, "Pick at most 4 topics");

    // Resolve speaker_name from the submitter's user record. Stored as a
    // denormalised string so deletion of the user doesn't blank the byline.
    const slug = await uniqueSlug(slugify(title));

    const created = await db.transaction(async (tx) => {
      const [paper] = await tx.insert(paperPresentations).values({
        slug, title, abstract, description,
        speaker_name: req.user!.name,
        author_user_id: userId,
        author_designation,
        committee_id, event_id,
        presented_on, pdf_file_id, cover_file_id,
        status: "pending_review",
        submitted_by: userId,
      }).returning();

      // Validate all topic ids exist before insert (FK would catch but we
      // want a clean error message instead of a Postgres constraint dump).
      const found = await tx
        .select({ id: resourceTopics.id })
        .from(resourceTopics)
        .where(inArray(resourceTopics.id, topic_ids));
      if (found.length !== topic_ids.length) {
        throw new ApiError(400, "One or more topic_ids are invalid");
      }
      await tx.insert(paperTopics).values(
        topic_ids.map((tid) => ({ paper_id: paper.id, topic_id: tid })),
      );

      return paper;
    });

    res.status(201).json({ ok: true, paper: { id: created.id, slug: created.slug, status: created.status } });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── E-journal issues ────────────────────────────────────────────────────
resourcesRouter.get("/ejournal-issues", async (req, res, next) => {
  try {
    const page     = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(40, Math.max(6, Number(req.query.pageSize) || 12));
    const offset   = (page - 1) * pageSize;

    const rows = await db
      .select({
        id: ejournalIssues.id,
        slug: ejournalIssues.slug,
        title: ejournalIssues.title,
        issue_label: ejournalIssues.issue_label,
        issue_year: ejournalIssues.issue_year,
        issue_quarter: ejournalIssues.issue_quarter,
        editorial_summary: ejournalIssues.editorial_summary,
        published_at: ejournalIssues.published_at,
        view_count: ejournalIssues.view_count,
        cover_path: files.storage_path,
      })
      .from(ejournalIssues)
      .leftJoin(files, eq(files.id, ejournalIssues.cover_file_id))
      .where(and(
        eq(ejournalIssues.status, "published"),
        eq(ejournalIssues.hidden, false),
      ))
      .orderBy(desc(ejournalIssues.issue_year), desc(ejournalIssues.issue_quarter))
      .limit(pageSize).offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(ejournalIssues)
      .where(and(eq(ejournalIssues.status, "published"), eq(ejournalIssues.hidden, false)));

    res.json({
      items: rows.map((r) => ({ ...r, cover_url: fileUrl(r.cover_path) })),
      total, page, pageSize,
    });
  } catch (err) { handleApiError(err, res, next); }
});

resourcesRouter.get("/ejournal-issues/:slug", async (req, res, next) => {
  try {
    const slug = String(req.params.slug);
    const coverFiles = sql`f_cover.storage_path`;
    const [row] = await db
      .select({
        id: ejournalIssues.id,
        slug: ejournalIssues.slug,
        title: ejournalIssues.title,
        issue_label: ejournalIssues.issue_label,
        issue_year: ejournalIssues.issue_year,
        issue_quarter: ejournalIssues.issue_quarter,
        editorial_summary: ejournalIssues.editorial_summary,
        published_at: ejournalIssues.published_at,
        view_count: ejournalIssues.view_count,
        pdf_path: files.storage_path,
        pdf_name: files.name,
        cover_path: sql<string | null>`(SELECT storage_path FROM ${files} WHERE id = ${ejournalIssues.cover_file_id})`,
      })
      .from(ejournalIssues)
      .leftJoin(files, eq(files.id, ejournalIssues.pdf_file_id))
      .where(and(
        eq(ejournalIssues.slug, slug),
        eq(ejournalIssues.status, "published"),
        eq(ejournalIssues.hidden, false),
      ))
      .limit(1);

    if (!row) throw new ApiError(404, "Issue not found");

    void db.update(ejournalIssues)
      .set({ view_count: sql`${ejournalIssues.view_count} + 1` })
      .where(eq(ejournalIssues.id, row.id))
      .catch(() => {});

    res.json({
      issue: {
        ...row,
        view_count: row.view_count + 1,
        pdf_url:   fileUrl(row.pdf_path),
        cover_url: fileUrl(row.cover_path),
      },
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ═════════════════════════════════════════════════════════════════════════
// Phase 2 — Bookmarks + Topic subscriptions + Speaker profiles
// ═════════════════════════════════════════════════════════════════════════

// ─── Bookmarks — toggle ──────────────────────────────────────────────────
// One endpoint that toggles. Idempotent semantics on both directions —
// posting twice doesn't 409.
resourcesRouter.post("/bookmarks", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const resource_type = pickResourceType(req.body.resource_type);
    const resource_id = need(trim(req.body.resource_id), "resource_id");

    const existing = await db
      .select({ id: resourceBookmarks.id })
      .from(resourceBookmarks)
      .where(and(
        eq(resourceBookmarks.user_id, req.user!.id),
        eq(resourceBookmarks.resource_type, resource_type),
        eq(resourceBookmarks.resource_id, resource_id),
      ))
      .limit(1);

    if (existing[0]) {
      await db.delete(resourceBookmarks).where(eq(resourceBookmarks.id, existing[0].id));
      res.json({ ok: true, bookmarked: false });
    } else {
      await db.insert(resourceBookmarks).values({
        user_id: req.user!.id,
        resource_type,
        resource_id,
      });
      res.json({ ok: true, bookmarked: true });
    }
  } catch (err) { handleApiError(err, res, next); }
});

// My Library — paginated list of bookmarked resources with denormalised
// title/cover so the UI can render without a per-row lookup. We do two
// SELECTs (one per type) and merge — pagination is over the merged set.
resourcesRouter.get("/bookmarks/my", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const bookmarks = await db
      .select()
      .from(resourceBookmarks)
      .where(eq(resourceBookmarks.user_id, userId))
      .orderBy(desc(resourceBookmarks.created_at));

    const paperIds   = bookmarks.filter((b) => b.resource_type === "paper").map((b) => b.resource_id);
    const journalIds = bookmarks.filter((b) => b.resource_type === "ejournal").map((b) => b.resource_id);

    const paperRows = paperIds.length === 0 ? [] : await db
      .select({
        id: paperPresentations.id, slug: paperPresentations.slug,
        title: paperPresentations.title, abstract: paperPresentations.abstract,
        speaker_name: paperPresentations.speaker_name,
        presented_on: paperPresentations.presented_on,
        cover_path: files.storage_path,
      })
      .from(paperPresentations)
      .leftJoin(files, eq(files.id, paperPresentations.cover_file_id))
      .where(inArray(paperPresentations.id, paperIds));
    const paperMap = new Map(paperRows.map((p) => [p.id, p]));

    const journalRows = journalIds.length === 0 ? [] : await db
      .select({
        id: ejournalIssues.id, slug: ejournalIssues.slug,
        title: ejournalIssues.title, issue_label: ejournalIssues.issue_label,
        cover_path: files.storage_path,
      })
      .from(ejournalIssues)
      .leftJoin(files, eq(files.id, ejournalIssues.cover_file_id))
      .where(inArray(ejournalIssues.id, journalIds));
    const journalMap = new Map(journalRows.map((j) => [j.id, j]));

    res.json({
      items: bookmarks
        .map((b) => {
          if (b.resource_type === "paper") {
            const p = paperMap.get(b.resource_id);
            if (!p) return null;
            return {
              bookmark_id: b.id, created_at: b.created_at,
              resource_type: "paper",
              slug: p.slug, title: p.title, subtitle: p.speaker_name,
              meta: p.presented_on,
              cover_url: fileUrl(p.cover_path),
            };
          } else {
            const j = journalMap.get(b.resource_id);
            if (!j) return null;
            return {
              bookmark_id: b.id, created_at: b.created_at,
              resource_type: "ejournal",
              slug: j.slug, title: j.title, subtitle: j.issue_label,
              meta: null,
              cover_url: fileUrl(j.cover_path),
            };
          }
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Topic subscriptions — toggle + list ─────────────────────────────────
resourcesRouter.post("/topic-subscriptions", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const topic_id = need(trim(req.body.topic_id), "topic_id");

    const existing = await db
      .select({ id: resourceTopicSubscriptions.id })
      .from(resourceTopicSubscriptions)
      .where(and(
        eq(resourceTopicSubscriptions.user_id, req.user!.id),
        eq(resourceTopicSubscriptions.topic_id, topic_id),
      ))
      .limit(1);

    if (existing[0]) {
      await db.delete(resourceTopicSubscriptions).where(eq(resourceTopicSubscriptions.id, existing[0].id));
      res.json({ ok: true, following: false });
    } else {
      await db.insert(resourceTopicSubscriptions).values({
        user_id: req.user!.id, topic_id,
      });
      res.json({ ok: true, following: true });
    }
  } catch (err) { handleApiError(err, res, next); }
});

resourcesRouter.get("/topic-subscriptions/my", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db
      .select({
        topic_id: resourceTopicSubscriptions.topic_id,
        topic_code: resourceTopics.code,
        topic_name: resourceTopics.name,
        followed_at: resourceTopicSubscriptions.created_at,
      })
      .from(resourceTopicSubscriptions)
      .innerJoin(resourceTopics, eq(resourceTopics.id, resourceTopicSubscriptions.topic_id))
      .where(eq(resourceTopicSubscriptions.user_id, req.user!.id))
      .orderBy(asc(resourceTopics.sort_order));
    res.json({ items: rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Speaker profile — every paper by one author ─────────────────────────
// Public. Authors are identified either by user_id (member-submitted) or
// by speaker_name (admin-uploaded external). For external speakers the
// page is read-only — no bio/avatar lookup possible.
resourcesRouter.get("/speakers/:idOrSlug", async (req, res, next) => {
  try {
    const idOrSlug = String(req.params.idOrSlug);
    // First try as a user id, then fall back to speaker_name match.
    const isUuid = /^[0-9a-f-]{36}$/i.test(idOrSlug);

    if (isUuid) {
      const [user] = await db
        .select({ id: users.id, name: users.name, email: users.email })
        .from(users)
        .where(eq(users.id, idOrSlug))
        .limit(1);
      if (!user) throw new ApiError(404, "Speaker not found");

      const papers = await db
        .select({
          id: paperPresentations.id, slug: paperPresentations.slug,
          title: paperPresentations.title, abstract: paperPresentations.abstract,
          presented_on: paperPresentations.presented_on,
          published_at: paperPresentations.published_at,
          view_count: paperPresentations.view_count,
          cover_path: files.storage_path,
        })
        .from(paperPresentations)
        .leftJoin(files, eq(files.id, paperPresentations.cover_file_id))
        .where(and(
          eq(paperPresentations.author_user_id, user.id),
          eq(paperPresentations.status, "published"),
          eq(paperPresentations.hidden, false),
        ))
        .orderBy(desc(paperPresentations.published_at));

      return res.json({
        speaker: { kind: "member", id: user.id, name: user.name },
        papers: papers.map((p) => ({ ...p, cover_url: fileUrl(p.cover_path) })),
      });
    }

    // External speaker — match by exact speaker_name (case-insensitive).
    // No user_id available; UI shows a stripped-down profile.
    const name = idOrSlug.replace(/-/g, " ");
    const papers = await db
      .select({
        id: paperPresentations.id, slug: paperPresentations.slug,
        title: paperPresentations.title, abstract: paperPresentations.abstract,
        speaker_name: paperPresentations.speaker_name,
        presented_on: paperPresentations.presented_on,
        published_at: paperPresentations.published_at,
        view_count: paperPresentations.view_count,
        cover_path: files.storage_path,
      })
      .from(paperPresentations)
      .leftJoin(files, eq(files.id, paperPresentations.cover_file_id))
      .where(and(
        ilike(paperPresentations.speaker_name, name),
        isNull(paperPresentations.author_user_id),
        eq(paperPresentations.status, "published"),
        eq(paperPresentations.hidden, false),
      ))
      .orderBy(desc(paperPresentations.published_at));

    if (papers.length === 0) throw new ApiError(404, "Speaker not found");

    res.json({
      speaker: { kind: "external", name: papers[0].speaker_name },
      papers: papers.map((p) => ({ ...p, cover_url: fileUrl(p.cover_path) })),
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ═════════════════════════════════════════════════════════════════════════
// Phase 3 — Comments + Quizzes
// ═════════════════════════════════════════════════════════════════════════

// ─── Comments — list ─────────────────────────────────────────────────────
// Public read; only visible comments returned. Includes commenter name +
// hidden-state hint for admins (so they see the trail without leaking the
// content to others).
resourcesRouter.get("/comments", async (req, res, next) => {
  try {
    const resource_type = pickResourceType(req.query.resource_type);
    const resource_id = need(trim(req.query.resource_id), "resource_id");

    const rows = await db
      .select({
        id: resourceComments.id,
        body: resourceComments.body,
        parent_comment_id: resourceComments.parent_comment_id,
        status: resourceComments.status,
        created_at: resourceComments.created_at,
        user_id: resourceComments.user_id,
        user_name: users.name,
      })
      .from(resourceComments)
      .innerJoin(users, eq(users.id, resourceComments.user_id))
      .where(and(
        eq(resourceComments.resource_type, resource_type),
        eq(resourceComments.resource_id, resource_id),
      ))
      .orderBy(asc(resourceComments.created_at));

    // Only return visible rows to non-admin readers. Hidden rows simply
    // don't appear; deletion is a separate concept (row is gone).
    res.json({
      items: rows
        .filter((r) => r.status === "visible")
        .map((r) => ({
          id: r.id, body: r.body, parent_comment_id: r.parent_comment_id,
          created_at: r.created_at,
          user: { id: r.user_id, name: r.user_name },
        })),
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Comments — create ───────────────────────────────────────────────────
// Post-moderation: comment appears live, admin can hide/delete later.
// Author of the paper gets notified.
resourcesRouter.post("/comments", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const resource_type = pickResourceType(req.body.resource_type);
    const resource_id = need(trim(req.body.resource_id), "resource_id");
    const body = need(trim(req.body.body), "Comment");
    if (body.length > 5000) throw new ApiError(400, "Comment is too long (max 5000 chars)");
    const parent_comment_id = trim(req.body.parent_comment_id) || null;

    // Confirm the resource actually exists + is published before we let
    // anyone comment on a draft / private slug.
    let resourceTitle = "";
    let authorUserId: string | null = null;
    if (resource_type === "paper") {
      const [p] = await db
        .select({
          id: paperPresentations.id,
          title: paperPresentations.title,
          author_user_id: paperPresentations.author_user_id,
        })
        .from(paperPresentations)
        .where(and(
          eq(paperPresentations.id, resource_id),
          eq(paperPresentations.status, "published"),
          eq(paperPresentations.hidden, false),
        ))
        .limit(1);
      if (!p) throw new ApiError(404, "Paper not found");
      resourceTitle = p.title; authorUserId = p.author_user_id;
    } else {
      const [j] = await db
        .select({ id: ejournalIssues.id, title: ejournalIssues.title })
        .from(ejournalIssues)
        .where(and(
          eq(ejournalIssues.id, resource_id),
          eq(ejournalIssues.status, "published"),
          eq(ejournalIssues.hidden, false),
        ))
        .limit(1);
      if (!j) throw new ApiError(404, "Issue not found");
      resourceTitle = j.title;
    }

    const [row] = await db.insert(resourceComments).values({
      resource_type, resource_id,
      user_id: req.user!.id,
      body, parent_comment_id,
    }).returning();

    // Notify the author if they're a member AND not commenting on their
    // own paper. Fire-and-forget through the existing notify pipeline.
    if (resource_type === "paper" && authorUserId && authorUserId !== req.user!.id) {
      const [paperSlugRow] = await db
        .select({ slug: paperPresentations.slug })
        .from(paperPresentations)
        .where(eq(paperPresentations.id, resource_id)).limit(1);
      notifyAsync({
        user_id: authorUserId,
        template_key: "paper_new_comment",
        vars: {
          commenter_name: req.user!.name,
          paper_title:    resourceTitle,
          comment_preview: body.slice(0, 140) + (body.length > 140 ? "…" : ""),
          paper_link:      `${process.env.APP_URL ?? ""}/resources/papers/${paperSlugRow?.slug ?? ""}`,
        },
        link_url: `/resources/papers/${paperSlugRow?.slug ?? ""}`,
      });
    }

    res.status(201).json({
      ok: true,
      comment: {
        id: row.id, body: row.body, parent_comment_id: row.parent_comment_id,
        created_at: row.created_at,
        user: { id: req.user!.id, name: req.user!.name },
      },
    });
  } catch (err) { handleApiError(err, res, next); }
});

// User deletes their own comment. Hard-delete the row (with its replies
// via the cascade). Admin moderation has its own admin endpoint.
resourcesRouter.delete("/comments/:id", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const [existing] = await db.select().from(resourceComments).where(eq(resourceComments.id, id)).limit(1);
    if (!existing) throw new ApiError(404, "Comment not found");
    if (existing.user_id !== req.user!.id) throw new ApiError(403, "You can only delete your own comments");
    await db.delete(resourceComments).where(eq(resourceComments.id, id));
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Quizzes — take ──────────────────────────────────────────────────────
// Get the published quiz for a paper. Correct-answer flag is NOT returned
// here — that would let the client cheat. Submission scores server-side.
resourcesRouter.get("/papers/:slug/quiz", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const slug = String(req.params.slug);
    const [paper] = await db
      .select({ id: paperPresentations.id })
      .from(paperPresentations)
      .where(eq(paperPresentations.slug, slug))
      .limit(1);
    if (!paper) throw new ApiError(404, "Paper not found");

    const [quiz] = await db
      .select()
      .from(resourceQuizzes)
      .where(and(eq(resourceQuizzes.paper_id, paper.id), eq(resourceQuizzes.is_published, true)))
      .limit(1);
    if (!quiz) throw new ApiError(404, "No quiz for this paper");

    // Cooldown check — most-recent attempt must be older than cooldown_hours.
    const [latest] = await db
      .select({ completed_at: resourceQuizAttempts.completed_at, passed: resourceQuizAttempts.passed })
      .from(resourceQuizAttempts)
      .where(and(eq(resourceQuizAttempts.quiz_id, quiz.id), eq(resourceQuizAttempts.user_id, req.user!.id)))
      .orderBy(desc(resourceQuizAttempts.completed_at))
      .limit(1);

    let cooldown_until: Date | null = null;
    if (latest && !latest.passed) {
      cooldown_until = new Date(latest.completed_at.getTime() + quiz.cooldown_hours * 3600 * 1000);
      if (cooldown_until <= new Date()) cooldown_until = null;
    }
    const already_passed = !!(latest && latest.passed);

    const questions = await db
      .select({
        id: resourceQuizQuestions.id,
        sort_order: resourceQuizQuestions.sort_order,
        text: resourceQuizQuestions.text,
      })
      .from(resourceQuizQuestions)
      .where(eq(resourceQuizQuestions.quiz_id, quiz.id))
      .orderBy(asc(resourceQuizQuestions.sort_order));

    const qIds = questions.map((q) => q.id);
    const opts = qIds.length === 0 ? [] : await db
      .select({
        id: resourceQuizOptions.id,
        question_id: resourceQuizOptions.question_id,
        sort_order: resourceQuizOptions.sort_order,
        text: resourceQuizOptions.text,
        // is_correct intentionally NOT selected — server-side only.
      })
      .from(resourceQuizOptions)
      .where(inArray(resourceQuizOptions.question_id, qIds))
      .orderBy(asc(resourceQuizOptions.sort_order));

    const optsByQ = new Map<string, typeof opts>();
    for (const o of opts) {
      const list = optsByQ.get(o.question_id) ?? [];
      list.push(o);
      optsByQ.set(o.question_id, list);
    }

    res.json({
      quiz: {
        id: quiz.id,
        pass_threshold: quiz.pass_threshold,
        question_count: quiz.question_count,
        cooldown_hours: quiz.cooldown_hours,
      },
      questions: questions.map((q) => ({
        id: q.id, text: q.text,
        options: (optsByQ.get(q.id) ?? []).map((o) => ({ id: o.id, text: o.text })),
      })),
      already_passed,
      cooldown_until,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// Submit an attempt. Score server-side, enforce cooldown, log to attempts
// table.
resourcesRouter.post("/papers/:slug/quiz-attempt", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const slug = String(req.params.slug);
    const answers = (req.body && typeof req.body.answers === "object" && req.body.answers) || {};

    const [paper] = await db
      .select({ id: paperPresentations.id })
      .from(paperPresentations)
      .where(eq(paperPresentations.slug, slug))
      .limit(1);
    if (!paper) throw new ApiError(404, "Paper not found");

    const [quiz] = await db
      .select()
      .from(resourceQuizzes)
      .where(and(eq(resourceQuizzes.paper_id, paper.id), eq(resourceQuizzes.is_published, true)))
      .limit(1);
    if (!quiz) throw new ApiError(404, "No quiz for this paper");

    // Already-passed → block re-attempts (one pass per user per paper).
    const [latest] = await db
      .select({ passed: resourceQuizAttempts.passed, completed_at: resourceQuizAttempts.completed_at })
      .from(resourceQuizAttempts)
      .where(and(eq(resourceQuizAttempts.quiz_id, quiz.id), eq(resourceQuizAttempts.user_id, req.user!.id)))
      .orderBy(desc(resourceQuizAttempts.completed_at))
      .limit(1);
    if (latest?.passed) throw new ApiError(400, "You've already passed this quiz");

    // Cooldown check on failed attempt.
    if (latest && !latest.passed) {
      const until = new Date(latest.completed_at.getTime() + quiz.cooldown_hours * 3600 * 1000);
      if (until > new Date()) {
        throw new ApiError(429, `You can retake this quiz after ${until.toISOString()}`);
      }
    }

    // Load questions + correct options to grade.
    const questions = await db
      .select({ id: resourceQuizQuestions.id })
      .from(resourceQuizQuestions)
      .where(eq(resourceQuizQuestions.quiz_id, quiz.id));
    const qIds = questions.map((q) => q.id);
    const correct = qIds.length === 0 ? [] : await db
      .select({ question_id: resourceQuizOptions.question_id, id: resourceQuizOptions.id })
      .from(resourceQuizOptions)
      .where(and(inArray(resourceQuizOptions.question_id, qIds), eq(resourceQuizOptions.is_correct, true)));
    const correctByQ = new Map(correct.map((c) => [c.question_id, c.id]));

    let score = 0;
    for (const q of questions) {
      const picked = trim(answers[q.id]);
      if (picked && picked === correctByQ.get(q.id)) score++;
    }
    const passed = score >= quiz.pass_threshold;

    const [row] = await db.insert(resourceQuizAttempts).values({
      quiz_id: quiz.id, user_id: req.user!.id,
      score, passed,
      answers,
    }).returning();

    res.json({
      ok: true,
      attempt: { id: row.id, score, passed, total: questions.length },
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── helpers ─────────────────────────────────────────────────────────────

function slugify(s: string): string {
  return s.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "paper";
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  let i = 1;
  while (i <= 60) {
    const candidate = i === 1 ? slug : `${slug}-${i}`;
    const [exists] = await db
      .select({ id: paperPresentations.id })
      .from(paperPresentations)
      .where(eq(paperPresentations.slug, candidate))
      .limit(1);
    if (!exists) return candidate;
    i++;
  }
  throw new ApiError(500, "Could not generate a unique slug");
}
