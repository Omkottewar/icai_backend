import { Router } from "express";
import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  forumThreads, forumPosts, users, events, committees,
} from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { isAdmin } from "../auth/permissions.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";

export const forumRouter = Router();
forumRouter.use(requireUser);

const TAGS = ["doubt", "suggestion", "announcement", "discussion", "resource_request"] as const;
function pickTag(v: unknown) {
  return TAGS.includes(v as any) ? (v as typeof TAGS[number]) : "discussion";
}

const MAX_TITLE = 200;
const MAX_BODY  = 10_000;
function clampText(v: unknown, max: number) {
  const s = trim(v);
  if (s.length > max) throw new ApiError(400, `Text exceeds ${max} characters`);
  return s;
}

// â”€â”€â”€ GET /api/forum/threads â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Filters: event_id, committee_id, tag, q (title/body search), mine (=1)
// Sort: recent (default), unanswered (no replies yet)
forumRouter.get("/threads", async (req: AuthedRequest, res, next) => {
  try {
    const eventId     = trim(req.query.event_id);
    const committeeId = trim(req.query.committee_id);
    const tag         = trim(req.query.tag);
    const q           = trim(req.query.q);
    const mine        = trim(req.query.mine) === "1";
    const sort        = trim(req.query.sort) || "recent";
    const page        = Math.max(1, Number(req.query.page) || 1);
    const pageSize    = Math.min(50, Math.max(5, Number(req.query.pageSize) || 20));
    const offset      = (page - 1) * pageSize;

    const conds = [isNull(forumThreads.deleted_at)];
    if (eventId)     conds.push(eq(forumThreads.event_id, eventId));
    if (committeeId) conds.push(eq(forumThreads.committee_id, committeeId));
    if (tag && TAGS.includes(tag as any)) conds.push(eq(forumThreads.tag, tag as any));
    if (mine) conds.push(eq(forumThreads.created_by, req.user!.id));
    if (q) conds.push(or(ilike(forumThreads.title, `%${q}%`), ilike(forumThreads.body, `%${q}%`))!);

    const orderBy = sort === "unanswered"
      ? asc(forumThreads.updated_at)  // approximation; UI also filters by reply_count=0
      : desc(forumThreads.updated_at);

    const rows = await db
      .select({
        id: forumThreads.id,
        title: forumThreads.title,
        body: forumThreads.body,
        tag: forumThreads.tag,
        event_id: forumThreads.event_id,
        event_title: events.title,
        committee_id: forumThreads.committee_id,
        committee_code: committees.code,
        committee_name: committees.name,
        created_by: forumThreads.created_by,
        author_name: users.name,
        created_at: forumThreads.created_at,
        updated_at: forumThreads.updated_at,
        reply_count: sql<number>`(
          SELECT COUNT(*)::int FROM ${forumPosts}
          WHERE ${forumPosts}.thread_id = ${forumThreads}.id
            AND ${forumPosts}.deleted_at IS NULL
        )`.as("reply_count"),
      })
      .from(forumThreads)
      .innerJoin(users, eq(users.id, forumThreads.created_by))
      .leftJoin(events, eq(events.id, forumThreads.event_id))
      .leftJoin(committees, eq(committees.id, forumThreads.committee_id))
      .where(and(...conds))
      .orderBy(orderBy)
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(forumThreads)
      .where(and(...conds));

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ GET /api/forum/threads/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
forumRouter.get("/threads/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const [thread] = await db
      .select({
        thread: forumThreads,
        author_name: users.name,
        author_email: users.email,
        event_title: events.title,
        event_slug: events.slug,
        committee_code: committees.code,
        committee_name: committees.name,
      })
      .from(forumThreads)
      .innerJoin(users, eq(users.id, forumThreads.created_by))
      .leftJoin(events, eq(events.id, forumThreads.event_id))
      .leftJoin(committees, eq(committees.id, forumThreads.committee_id))
      .where(and(eq(forumThreads.id, id), isNull(forumThreads.deleted_at)))
      .limit(1);
    if (!thread) throw new ApiError(404, "Thread not found");

    const posts = await db
      .select({
        id: forumPosts.id,
        thread_id: forumPosts.thread_id,
        parent_post_id: forumPosts.parent_post_id,
        body: forumPosts.body,
        created_by: forumPosts.created_by,
        author_name: users.name,
        created_at: forumPosts.created_at,
        updated_at: forumPosts.updated_at,
      })
      .from(forumPosts)
      .innerJoin(users, eq(users.id, forumPosts.created_by))
      .where(and(eq(forumPosts.thread_id, id), isNull(forumPosts.deleted_at)))
      .orderBy(asc(forumPosts.created_at));

    res.json({
      thread: { ...thread.thread, author_name: thread.author_name, event_title: thread.event_title, event_slug: thread.event_slug, committee_code: thread.committee_code, committee_name: thread.committee_name },
      posts,
      perms: {
        canEditThread: thread.thread.created_by === req.user!.id,
        canDeleteThread: thread.thread.created_by === req.user!.id || (await isAdmin(req.user!.id)),
      },
    });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ POST /api/forum/threads â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Body: { title, body, tag?, event_id?, committee_id? }  â€” at least one scope
forumRouter.post("/threads", async (req: AuthedRequest, res, next) => {
  try {
    const title = clampText(need(trim(req.body.title), "Title"), MAX_TITLE);
    const body  = clampText(need(trim(req.body.body),  "Body"),  MAX_BODY);
    const tag   = pickTag(req.body.tag);
    const eventId     = trim(req.body.event_id) || null;
    const committeeId = trim(req.body.committee_id) || null;

    if (!eventId && !committeeId) {
      throw new ApiError(400, "Thread must be attached to an event or a committee");
    }

    // Verify the referenced scope exists (so we return a 400 instead of a 23503)
    if (eventId) {
      const [ev] = await db.select({ id: events.id }).from(events).where(eq(events.id, eventId)).limit(1);
      if (!ev) throw new ApiError(404, "Event not found");
    }
    if (committeeId) {
      const [c] = await db.select({ id: committees.id }).from(committees).where(eq(committees.id, committeeId)).limit(1);
      if (!c) throw new ApiError(404, "Committee not found");
    }

    const [created] = await db
      .insert(forumThreads)
      .values({
        title, body, tag,
        event_id: eventId,
        committee_id: committeeId,
        created_by: req.user!.id,
      })
      .returning();

    res.status(201).json(created);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ PATCH /api/forum/threads/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Creator-only edit. Tag can also be changed.
forumRouter.patch("/threads/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const [existing] = await db.select().from(forumThreads).where(and(eq(forumThreads.id, id), isNull(forumThreads.deleted_at))).limit(1);
    if (!existing) throw new ApiError(404, "Thread not found");
    if (existing.created_by !== req.user!.id && !(await isAdmin(req.user!.id))) {
      throw new ApiError(403, "Only the author or an admin can edit this thread");
    }

    const patch: Record<string, any> = { updated_at: new Date() };
    if (req.body.title !== undefined) patch.title = clampText(need(trim(req.body.title), "Title"), MAX_TITLE);
    if (req.body.body  !== undefined) patch.body  = clampText(need(trim(req.body.body),  "Body"),  MAX_BODY);
    if (req.body.tag   !== undefined) patch.tag   = pickTag(req.body.tag);

    const [row] = await db.update(forumThreads).set(patch).where(eq(forumThreads.id, id)).returning();
    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ DELETE /api/forum/threads/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
forumRouter.delete("/threads/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const [existing] = await db.select().from(forumThreads).where(and(eq(forumThreads.id, id), isNull(forumThreads.deleted_at))).limit(1);
    if (!existing) throw new ApiError(404, "Thread not found");
    if (existing.created_by !== req.user!.id && !(await isAdmin(req.user!.id))) {
      throw new ApiError(403, "Only the author or an admin can delete this thread");
    }
    await db.update(forumThreads).set({ deleted_at: new Date() }).where(eq(forumThreads.id, id));
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ POST /api/forum/threads/:id/posts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
forumRouter.post("/threads/:id/posts", async (req: AuthedRequest, res, next) => {
  try {
    const threadId = String(req.params.id);
    const [thread] = await db.select({ id: forumThreads.id }).from(forumThreads).where(and(eq(forumThreads.id, threadId), isNull(forumThreads.deleted_at))).limit(1);
    if (!thread) throw new ApiError(404, "Thread not found");

    const body = clampText(need(trim(req.body.body), "Body"), MAX_BODY);
    const parentPostId = trim(req.body.parent_post_id) || null;

    const [post] = await db.insert(forumPosts).values({
      thread_id: threadId,
      parent_post_id: parentPostId,
      body,
      created_by: req.user!.id,
    }).returning();

    res.status(201).json(post);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ PATCH /api/forum/posts/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
forumRouter.patch("/posts/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const [existing] = await db.select().from(forumPosts).where(and(eq(forumPosts.id, id), isNull(forumPosts.deleted_at))).limit(1);
    if (!existing) throw new ApiError(404, "Post not found");
    if (existing.created_by !== req.user!.id && !(await isAdmin(req.user!.id))) {
      throw new ApiError(403, "Only the author or an admin can edit this post");
    }

    const body = clampText(need(trim(req.body.body), "Body"), MAX_BODY);
    const [row] = await db.update(forumPosts)
      .set({ body, updated_at: new Date() })
      .where(eq(forumPosts.id, id))
      .returning();
    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ DELETE /api/forum/posts/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
forumRouter.delete("/posts/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const [existing] = await db.select().from(forumPosts).where(and(eq(forumPosts.id, id), isNull(forumPosts.deleted_at))).limit(1);
    if (!existing) throw new ApiError(404, "Post not found");
    if (existing.created_by !== req.user!.id && !(await isAdmin(req.user!.id))) {
      throw new ApiError(403, "Only the author or an admin can delete this post");
    }
    await db.update(forumPosts).set({ deleted_at: new Date() }).where(eq(forumPosts.id, id));
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ GET /api/forum/lookups â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Composer needs the list of events + committees the user can attach to.
// Public events + active committees suffice for v1.
forumRouter.get("/lookups", async (_req, res, next) => {
  try {
    const cs = await db
      .select({ id: committees.id, code: committees.code, name: committees.name })
      .from(committees)
      .where(eq(committees.active, true))
      .orderBy(asc(committees.name));
    const es = await db
      .select({ id: events.id, slug: events.slug, title: events.title })
      .from(events)
      .where(and(isNull(events.deleted_at), eq(events.status, "published")))
      .orderBy(desc(events.starts_at))
      .limit(100);
    res.json({ committees: cs, events: es });
  } catch (err) { handleApiError(err, res, next); }
});
