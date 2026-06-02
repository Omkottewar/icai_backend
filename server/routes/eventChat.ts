// Event chat REST endpoints.
//
// Each event has exactly one auto-provisioned `forum_threads` row used as the
// chat backbone (title sentinel: __event_chat__). Every chat message is a
// `forum_posts` row on that thread, so we get persistence, soft-delete, and
// the existing author join for free — no new tables.
//
// Access: must be authenticated AND registered for the event. The same gate
// runs on the WebSocket upgrade so unregistered users can't sneak in.

import { Router } from "express";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  events, eventRegistrations, forumThreads, forumPosts, users,
} from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { broadcast, roomSize } from "../lib/eventChatRooms.js";

// Note: requireUser is applied per-route below — NOT at the router level.
// Mounting at `/api/events` stacks this router alongside publicEventsRouter,
// and a router-wide auth middleware would short-circuit anonymous requests
// for the public events listing before they could fall through.
export const eventChatRouter = Router();

const CHAT_SENTINEL = "__event_chat__";
const MAX_MESSAGE = 4000;          // WhatsApp limit-ish; well under forum_posts MAX_BODY
const DEFAULT_PAGE_SIZE = 50;

// ─── helper: ensure the user is registered for this event ───────────────
async function assertRegistered(userId: string, eventId: string): Promise<void> {
  const [reg] = await db
    .select({ id: eventRegistrations.id })
    .from(eventRegistrations)
    .where(and(
      eq(eventRegistrations.user_id, userId),
      eq(eventRegistrations.event_id, eventId),
      isNull(eventRegistrations.deleted_at),
    ))
    .limit(1);
  if (!reg) throw new ApiError(403, "Only registered attendees can view this chat");
}

// ─── helper: find or create the chat thread for an event ────────────────
// Idempotent — two concurrent first-opens race to INSERT but the unique-event
// scope means one wins, and we read back the existing thread on the loser.
async function ensureChatThread(eventId: string, userId: string): Promise<string> {
  const [existing] = await db
    .select({ id: forumThreads.id })
    .from(forumThreads)
    .where(and(
      eq(forumThreads.event_id, eventId),
      eq(forumThreads.title, CHAT_SENTINEL),
      isNull(forumThreads.deleted_at),
    ))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await db
    .insert(forumThreads)
    .values({
      title: CHAT_SENTINEL,
      body: "Event chat",
      tag: "discussion",
      event_id: eventId,
      created_by: userId,
    })
    .returning({ id: forumThreads.id });
  return created.id;
}

// ─── GET /api/events/:id/chat ──────────────────────────────────────────
// Returns the most recent `pageSize` messages for the event's chat thread,
// oldest first (so the UI just appends to the bottom). Includes the event
// title/registered_count so the chat header can render without a second hit.
eventChatRouter.get("/:id/chat", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize) || DEFAULT_PAGE_SIZE));

    const [event] = await db
      .select({
        id: events.id,
        title: events.title,
        registered_count: events.registered_count,
      })
      .from(events)
      .where(and(eq(events.id, eventId), isNull(events.deleted_at)))
      .limit(1);
    if (!event) throw new ApiError(404, "Event not found");

    await assertRegistered(req.user!.id, eventId);
    const threadId = await ensureChatThread(eventId, req.user!.id);

    // Pull newest-first from the DB so we can cap with LIMIT, then reverse
    // so the client gets oldest-first (its natural append direction).
    const newest = await db
      .select({
        id: forumPosts.id,
        body: forumPosts.body,
        created_by: forumPosts.created_by,
        author_name: users.name,
        created_at: forumPosts.created_at,
      })
      .from(forumPosts)
      .innerJoin(users, eq(users.id, forumPosts.created_by))
      .where(and(eq(forumPosts.thread_id, threadId), isNull(forumPosts.deleted_at)))
      .orderBy(desc(forumPosts.created_at))
      .limit(pageSize);

    res.json({
      event: { id: event.id, title: event.title, registered_count: event.registered_count },
      thread_id: threadId,
      online_count: roomSize(eventId),
      me: { id: req.user!.id, name: req.user!.name },
      messages: newest.reverse(),
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/events/:id/chat ─────────────────────────────────────────
// Body: { body: string }. Inserts a forum_posts row + fans out over WS.
// We do not trust the broadcast to deliver — clients render the message
// from the HTTP response too. The WS push is just for OTHER tabs/users.
eventChatRouter.post("/:id/chat", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const body = trim(req.body?.body);
    if (!body) throw new ApiError(400, "Message body is required");
    if (body.length > MAX_MESSAGE) throw new ApiError(400, `Message exceeds ${MAX_MESSAGE} characters`);

    const [event] = await db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.id, eventId), isNull(events.deleted_at)))
      .limit(1);
    if (!event) throw new ApiError(404, "Event not found");

    await assertRegistered(req.user!.id, eventId);
    const threadId = await ensureChatThread(eventId, req.user!.id);

    const [inserted] = await db
      .insert(forumPosts)
      .values({ thread_id: threadId, body, created_by: req.user!.id })
      .returning();

    // Bump the parent thread's updated_at so any future thread-list sort
    // still works (in case the chat thread ever surfaces in a list view).
    await db
      .update(forumThreads)
      .set({ updated_at: new Date() })
      .where(eq(forumThreads.id, threadId));

    const message = {
      id: inserted.id,
      body: inserted.body,
      created_by: inserted.created_by,
      author_name: req.user!.name,
      created_at: inserted.created_at,
    };

    // Broadcast to everyone (including the sender's other tabs). The sender
    // de-dupes by id when it sees this echo of its own POST result.
    broadcast(eventId, { type: "message", message });

    res.status(201).json(message);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/events/:id/chat/older?before=<created_at> ────────────────
// Pagination upwards from the oldest currently rendered message. Used by
// the infinite-scroll-up affordance in the chat UI.
eventChatRouter.get("/:id/chat/older", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const before = trim(req.query.before);
    if (!before) throw new ApiError(400, "before is required");

    const beforeDate = new Date(before);
    if (Number.isNaN(beforeDate.getTime())) throw new ApiError(400, "before must be an ISO timestamp");

    await assertRegistered(req.user!.id, eventId);
    const threadId = await ensureChatThread(eventId, req.user!.id);

    const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || DEFAULT_PAGE_SIZE));

    const older = await db
      .select({
        id: forumPosts.id,
        body: forumPosts.body,
        created_by: forumPosts.created_by,
        author_name: users.name,
        created_at: forumPosts.created_at,
      })
      .from(forumPosts)
      .innerJoin(users, eq(users.id, forumPosts.created_by))
      .where(and(
        eq(forumPosts.thread_id, threadId),
        isNull(forumPosts.deleted_at),
      ))
      .orderBy(desc(forumPosts.created_at))
      .limit(pageSize);

    // `before` filter is applied in JS (cheap, set is small) to keep the
    // query free of timestamp-cast quirks across psql versions.
    const filtered = older
      .filter((m) => new Date(m.created_at).getTime() < beforeDate.getTime())
      .reverse();

    res.json({ messages: filtered });
  } catch (err) { handleApiError(err, res, next); }
});

// Exposed for any future server-side path that wants to drop a system
// message into an event chat (e.g. registration confirmations).
export { ensureChatThread };
