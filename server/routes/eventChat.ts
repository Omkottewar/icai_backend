// Event chat router — Discord-style channels per event.
//
// Layered model:
//   • `event_chat_channels` — one row per channel ("general", "Q&A", …)
//   • `forum_posts` (channel_id) — the messages themselves; reuses the
//     existing post table so we get soft-delete, mention_user_ids,
//     attachments, parent_post_id (replies), edited_at, pinned_at for free.
//   • `forum_post_reactions` — emoji reactions (toggle insert/delete)
//   • `event_chat_channel_reads` — per-user last_read_at for unread badges
//
// Access: every endpoint requires the caller to be a registered attendee.
// A few moderation actions (channel create/delete/edit, pin) need the
// branch chairman, admin, or the chairing committee — see `assertCanModerate`.
//
// The legacy v1 endpoints (`GET /chat`, `POST /chat`, `GET /chat/older`)
// are preserved as thin shims that route to the auto-provisioned
// "general" channel for the event — old clients keep working unchanged.

import { Router } from "express";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { db } from "../../db/client.js";
import {
  events, eventRegistrations, users,
  forumPosts, forumPostReactions,
  eventChatChannels, eventChatChannelReads,
  eventChatMutes, eventChatMessageReports, eventChatAudit,
  files, eventSpeakers,
} from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { broadcast, roomSize } from "../lib/eventChatRooms.js";
import { storage } from "../lib/storage.js";
import { loadUserPermissions } from "../auth/permissions.js";
import {
  RATE_LIMITS, checkRate,
  findActiveMute,
  expandMentions, dispatchMentionNotifications,
  logAudit,
  assertQuotaAvailable, incrementQuotaUsage,
  resolveRoleBadgesFor,
} from "../lib/eventChatHelpers.js";

export const eventChatRouter = Router();

const MAX_MESSAGE = 4000;
// First-page default trimmed from 50 → 25 (A4). The hook follows up
// with a viewport-fill backfill if the chat is empty enough to need it.
const DEFAULT_PAGE_SIZE = 25;
const BOOTSTRAP_PAGE_SIZE = 30;
const ATTACHMENT_MIME_ALLOW = new Set([
  "application/pdf",
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "text/plain",
]);
const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024; // 8 MB

// ─── Auth helpers ───────────────────────────────────────────────────────

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
  if (!reg) throw new ApiError(403, "Only registered attendees can use this chat");
}

// Moderator = branch chairman / admin / chairman of the event's committee.
// Used for channel CRUD, pin/unpin, and deleting other people's messages.
async function assertCanModerate(userId: string, eventId: string): Promise<void> {
  const perms = await loadUserPermissions(userId);
  if (perms.isAdmin || perms.isBranchChairman) return;
  if (perms.committeeChairmanOf.length === 0) {
    throw new ApiError(403, "Only the chairman / admin / committee chair can do that");
  }
  // Check the event's committee is one this user chairs.
  const [event] = await db
    .select({ committee_id: events.committee_id })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);
  if (!event?.committee_id || !perms.committeeChairmanOf.includes(event.committee_id)) {
    throw new ApiError(403, "Only the chairing committee can do that");
  }
}

// ─── Channel helpers ────────────────────────────────────────────────────

const DEFAULT_CHANNELS = [
  { name: "general",       kind: "general",       sort_order: 0, description: "Open chat for everyone registered" },
  { name: "q-and-a",       kind: "qa",            sort_order: 1, description: "Ask questions for the speaker" },
  { name: "announcements", kind: "announcements", sort_order: 2, description: "Pinned updates from organisers" },
];

// Ensure the event has at least the default channels. Idempotent — safe to
// call on every chat open. Returns the full channel list (active).
async function ensureChannelsForEvent(eventId: string) {
  const existing = await db
    .select({ id: eventChatChannels.id, kind: eventChatChannels.kind })
    .from(eventChatChannels)
    .where(and(
      eq(eventChatChannels.event_id, eventId),
      isNull(eventChatChannels.deleted_at),
    ));
  const haveKinds = new Set(existing.map((c) => c.kind));
  const toCreate = DEFAULT_CHANNELS.filter((d) => !haveKinds.has(d.kind));
  if (toCreate.length > 0) {
    await db.insert(eventChatChannels).values(
      toCreate.map((d) => ({ ...d, event_id: eventId })),
    );
  }
  return db
    .select()
    .from(eventChatChannels)
    .where(and(
      eq(eventChatChannels.event_id, eventId),
      isNull(eventChatChannels.deleted_at),
    ))
    .orderBy(asc(eventChatChannels.sort_order));
}

// Fetch a channel by id and verify it belongs to the given event.
async function getChannel(eventId: string, channelId: string) {
  const [row] = await db
    .select()
    .from(eventChatChannels)
    .where(and(
      eq(eventChatChannels.id, channelId),
      eq(eventChatChannels.event_id, eventId),
      isNull(eventChatChannels.deleted_at),
    ))
    .limit(1);
  if (!row) throw new ApiError(404, "Channel not found");
  return row;
}

// ─── Message-shape helpers ───────────────────────────────────────────────

// Single-shot message page query — A2.
//
// The previous version fanned out three secondary queries (reactions,
// reply counts, role badges). We collapse the first two into the main
// SELECT via correlated subqueries that aggregate per row:
//   • reactions_json: jsonb array of { emoji, user_ids[], count }
//   • reply_count   : int
// Role badges stay as a separate batched lookup (`resolveRoleBadgesFor`)
// because they come from an in-memory permissions cache, not a DB
// table — adding them to the SELECT would force a JOIN to roles even
// when the cache could've answered in microseconds.
//
// `messageColumns()` callsites pass an explicit ORDER BY so we just
// hydrate whatever rows the caller hands us, keeping this helper
// composable for both the paginated list and the catchup path.
async function hydrateMessages(rows: Array<{ id: string; created_by?: string; parent_post_id?: string | null }>) {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  // One query — aggregates per post in subselects. Postgres plans both
  // subselects against the (post_id) / (parent_post_id) indexes.
  // ids list expanded via sql.join (see comment on channelInList above
  // for why we can't `ANY(${arr}::uuid[])` directly with drizzle).
  const idInList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const enriched = await db.execute(sql`
    SELECT
      p.id,
      COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'emoji',    r.emoji,
          'user_ids', r.user_ids,
          'count',    r.count
        ))
        FROM (
          SELECT emoji,
                 array_agg(user_id) AS user_ids,
                 count(*)::int     AS count
          FROM forum_post_reactions
          WHERE post_id = p.id
          GROUP BY emoji
        ) r
      ), '[]'::jsonb) AS reactions,
      (
        SELECT count(*)::int
        FROM forum_posts c
        WHERE c.parent_post_id = p.id AND c.deleted_at IS NULL
      ) AS reply_count
    FROM forum_posts p
    WHERE p.id IN (${idInList})
  `);

  // drizzle's `execute` returns { rows: ... } for raw queries
  const augmentBy = new Map<string, { reactions: any[]; reply_count: number }>();
  for (const r of (enriched as any).rows ?? (enriched as any)) {
    augmentBy.set(r.id, { reactions: r.reactions ?? [], reply_count: r.reply_count ?? 0 });
  }

  // Role badges: same in-memory cached lookup as before, batched over
  // distinct authors. O(unique_authors) cache hits, no DB on warm.
  const authorIds = Array.from(new Set(rows.map((r) => r.created_by).filter((x): x is string => !!x)));
  const badges = await resolveRoleBadgesFor(authorIds);

  return rows.map((row: any) => {
    const x = augmentBy.get(row.id) ?? { reactions: [], reply_count: 0 };
    return {
      ...row,
      reactions:    x.reactions,
      reply_count:  x.reply_count,
      author_badge: badges.get(row.created_by) ?? null,
    };
  });
}

// Strips body/attachments/reactions from a tombstone row before it leaves
// the server. The row still needs `deleted_at` set so the client can
// render the "this message was deleted" placeholder.
function stripIfDeleted<T extends { deleted_at?: Date | string | null }>(row: T): T {
  if (!row.deleted_at) return row;
  return {
    ...row,
    body:         "",
    attachments:  [],
    reactions:    [],
    reply_count:  0,
    pinned_at:    null,
    mention_user_ids: [],
  } as T;
}

// Standard message select projection — used everywhere we need messages.
function messageColumns() {
  return {
    id:               forumPosts.id,
    channel_id:       forumPosts.channel_id,
    parent_post_id:   forumPosts.parent_post_id,
    body:             forumPosts.body,
    attachments:      forumPosts.attachments,
    mention_user_ids: forumPosts.mention_user_ids,
    pinned_at:        forumPosts.pinned_at,
    edited_at:        forumPosts.edited_at,
    answered_at:      forumPosts.answered_at,
    answered_by:      forumPosts.answered_by,
    deleted_at:       forumPosts.deleted_at,
    created_by:       forumPosts.created_by,
    author_name:      users.name,
    created_at:       forumPosts.created_at,
    client_id:        forumPosts.client_id,
  };
}

// Returns the post if the caller is allowed to mutate it (own message OR
// can-moderate). Throws otherwise. Used by edit + delete + pin.
async function loadMessageForMutation(eventId: string, messageId: string, userId: string, requireModerator: boolean) {
  const [row] = await db
    .select({
      id:             forumPosts.id,
      channel_id:     forumPosts.channel_id,
      parent_post_id: forumPosts.parent_post_id,
      created_by:     forumPosts.created_by,
      body:           forumPosts.body,
    })
    .from(forumPosts)
    .where(and(
      eq(forumPosts.id, messageId),
      isNull(forumPosts.deleted_at),
    ))
    .limit(1);
  if (!row || !row.channel_id) throw new ApiError(404, "Message not found");
  // Confirm the message lives in this event's chat
  await getChannel(eventId, row.channel_id);
  if (requireModerator) {
    await assertCanModerate(userId, eventId);
  } else if (row.created_by !== userId) {
    // Allow moderators to edit/delete others' messages too.
    try { await assertCanModerate(userId, eventId); }
    catch { throw new ApiError(403, "You can only modify your own messages"); }
  }
  return row;
}

// ─── Event meta helper (header card) ────────────────────────────────────
async function loadEventMeta(eventId: string) {
  const [row] = await db
    .select({
      id:               events.id,
      title:            events.title,
      starts_at:        events.starts_at,
      registered_count: events.registered_count,
    })
    .from(events)
    .where(and(eq(events.id, eventId), isNull(events.deleted_at)))
    .limit(1);
  if (!row) throw new ApiError(404, "Event not found");
  return row;
}

// Pre-event visibility rule: the #general free-chat channel is hidden from
// non-moderator attendees until the event starts. Q&A and announcements
// stay visible, so the only pre-event surface members see is the moderated
// Q&A — which matches the catalogue §1.2 promise ("submit questions to the
// speaker before the event begins") and prevents two near-identical chat
// surfaces from competing for activity. After event start, both #general
// and #qa are open. Moderators (admin / branch chairman / chairing
// committee chairman / magic-link speaker) see #general at all times so
// they can set context, pin announcements, etc.
function filterChannelsForViewer<T extends { kind: string }>(
  channels: T[],
  event: { starts_at: Date },
  canModerate: boolean,
): T[] {
  if (canModerate) return channels;
  if (event.starts_at <= new Date()) return channels;
  return channels.filter((c) => c.kind !== "general");
}

// Quick predicate — true if the caller is a moderator. Doesn't throw, so
// safe to use as a branch condition without try/catch.
async function isModerator(userId: string, eventId: string): Promise<boolean> {
  try { await assertCanModerate(userId, eventId); return true; }
  catch { return false; }
}

// ════════════════════════════════════════════════════════════════════════
// ENDPOINTS
// ════════════════════════════════════════════════════════════════════════

// ─── GET /api/events/:id/chat ──────────────────────────────────────────
// Bootstrap payload. Returns event meta + me + channels (with unread
// counts) + the most recent N messages for the default ("general")
// channel. The frontend uses this to render the shell + open the default
// tab without follow-up round-trips.
eventChatRouter.get("/:id/chat", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const pageSize = Math.min(200, Math.max(10, Number(req.query.pageSize) || DEFAULT_PAGE_SIZE));

    const event = await loadEventMeta(eventId);
    await assertRegistered(req.user!.id, eventId);

    const allChannels = await ensureChannelsForEvent(eventId);
    const canMod = await isModerator(req.user!.id, eventId);
    const channels = filterChannelsForViewer(allChannels, event, canMod);
    // Default channel = #general if visible (post-event or moderator),
    // otherwise #qa (pre-event member case), otherwise first available.
    const defaultChannel =
      channels.find((c) => c.kind === "general")
      ?? channels.find((c) => c.kind === "qa")
      ?? channels[0];

    // Last-read map + per-channel last-message timestamp + unread count.
    const reads = await db
      .select({ channel_id: eventChatChannelReads.channel_id, last_read_at: eventChatChannelReads.last_read_at })
      .from(eventChatChannelReads)
      .where(eq(eventChatChannelReads.user_id, req.user!.id));
    const readBy = new Map(reads.map((r) => [r.channel_id, r.last_read_at]));

    const channelIds = channels.map((c) => c.id);
    const newestPerChannel = channelIds.length === 0 ? [] : await db
      .select({
        channel_id: forumPosts.channel_id,
        last_at:    sql<Date>`max(${forumPosts.created_at})`.as("last_at"),
        // Drizzle's ${forumPosts.channel_id} interpolation renders as
        // just "channel_id" (column-only, NOT table-qualified). Inside
        // the subquery — which scans event_chat_channel_reads aliased
        // as `r` — that unqualified "channel_id" resolves to r's own
        // column, so the WHERE becomes `r.channel_id = r.channel_id`
        // (true for every row this user has read) → 21000 "more than
        // one row" error. Hardcoding the outer-table qualifier
        // `forum_posts.channel_id` fixes the binding.
        unread:     sql<number>`count(*) filter (where ${forumPosts.created_at} > coalesce(
          (select r.last_read_at from event_chat_channel_reads r
            where r.channel_id = forum_posts.channel_id and r.user_id = ${req.user!.id}),
          '1970-01-01'::timestamptz
        ))::int`.as("unread"),
      })
      .from(forumPosts)
      .where(and(
        inArray(forumPosts.channel_id, channelIds),
        isNull(forumPosts.deleted_at),
      ))
      .groupBy(forumPosts.channel_id);
    const statsBy = new Map(newestPerChannel.map((s) => [s.channel_id, s]));

    const channelPayload = channels.map((c) => ({
      ...c,
      last_message_at: statsBy.get(c.id)?.last_at ?? null,
      last_read_at:    readBy.get(c.id) ?? null,
      unread_count:    statsBy.get(c.id)?.unread ?? 0,
    }));

    // A1 — pre-load the first 30 messages for EVERY channel in a single
    // windowed query. The frontend seeds `messagesByCh` for all of them
    // at bootstrap, so the very first channel switch paints in the same
    // frame as the rest of the chat. We use row_number() over the
    // channel partition rather than N separate per-channel queries.
    const allChannelIds = channels.map((c) => c.id);
    // Drizzle's `sql` tag expands a JS array into a comma-separated list
    // of placeholders — `${arr}` becomes `($1, $2, ...)`, NOT a single
    // array-typed parameter. Casting that comma-list to `uuid[]` is a
    // record-to-array cast which Postgres rejects (42846). We work
    // around by building an explicit `IN (...)` list where each id is
    // its own bound parameter, then casting individually if needed.
    const channelInList = sql.join(
      allChannelIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    // Deleted messages are returned as tombstones (body stripped, deleted_at
    // set) so the "this message was deleted" marker persists across reloads.
    const newestMsgsRaw = allChannelIds.length === 0 ? [] : await db.execute(sql`
      SELECT id, channel_id, parent_post_id, body, attachments, mention_user_ids,
             pinned_at, edited_at, answered_at, answered_by, deleted_at,
             created_by, created_at, client_id, author_name
      FROM (
        SELECT p.id, p.channel_id, p.parent_post_id,
               CASE WHEN p.deleted_at IS NULL THEN p.body ELSE '' END AS body,
               CASE WHEN p.deleted_at IS NULL THEN p.attachments ELSE '[]'::jsonb END AS attachments,
               p.mention_user_ids, p.pinned_at, p.edited_at,
               p.answered_at, p.answered_by,
               p.deleted_at, p.created_by,
               p.created_at, p.client_id,
               u.name AS author_name,
               row_number() OVER (PARTITION BY p.channel_id ORDER BY p.created_at DESC) AS rn
        FROM forum_posts p
        INNER JOIN users u ON u.id = p.created_by
        WHERE p.channel_id IN (${channelInList})
      ) ranked
      WHERE rn <= ${BOOTSTRAP_PAGE_SIZE}
      ORDER BY channel_id, created_at DESC
    `);
    const newestMsgs = ((newestMsgsRaw as any).rows ?? newestMsgsRaw) as Array<any>;
    const hydrated = await hydrateMessages(newestMsgs);

    // Group hydrated rows by channel, in oldest-first order for direct
    // append on the client side.
    const messagesByChannelId: Record<string, any[]> = {};
    for (const c of channels) messagesByChannelId[c.id] = [];
    for (const m of hydrated) messagesByChannelId[m.channel_id]?.push(m);
    for (const cid of Object.keys(messagesByChannelId)) {
      messagesByChannelId[cid] = messagesByChannelId[cid].reverse();
    }

    res.json({
      event:        { id: event.id, title: event.title, registered_count: event.registered_count },
      me:           { id: req.user!.id, name: req.user!.name },
      online_count: roomSize(eventId),
      channels:     channelPayload,
      default_channel_id: defaultChannel?.id ?? null,
      // Legacy `messages` field still returned for the default channel
      // so old clients (pre-A1) keep working. New clients prefer
      // `messages_by_channel_id`.
      messages:     defaultChannel ? messagesByChannelId[defaultChannel.id] ?? [] : [],
      messages_by_channel_id: messagesByChannelId,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/events/:id/chat/channels/:cid/messages ─────────────────
// Paginated newest-first → reversed to oldest-first for the client.
// Query: ?before=<iso>&pageSize=...
eventChatRouter.get("/:id/chat/channels/:cid/messages", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const cid = need(trim(req.params.cid), "Channel ID");
    await assertRegistered(req.user!.id, eventId);
    await getChannel(eventId, cid);

    const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || DEFAULT_PAGE_SIZE));
    const beforeRaw = trim(req.query.before);
    const beforeDate = beforeRaw ? new Date(beforeRaw) : null;
    if (beforeRaw && Number.isNaN(beforeDate!.getTime())) {
      throw new ApiError(400, "before must be an ISO timestamp");
    }

    // Deleted rows are returned as tombstones — the frontend renders them
    // as "this message was deleted" placeholders. We strip body /
    // attachments here so a client can't read soft-deleted content.
    const conds = [eq(forumPosts.channel_id, cid)];
    if (beforeDate) conds.push(lt(forumPosts.created_at, beforeDate));

    const rows = await db
      .select(messageColumns())
      .from(forumPosts)
      .innerJoin(users, eq(users.id, forumPosts.created_by))
      .where(and(...conds))
      .orderBy(desc(forumPosts.created_at))
      .limit(pageSize);
    const hydrated = (await hydrateMessages(rows as any)).map(stripIfDeleted);
    const ordered = hydrated.reverse();

    // No ETag / Cache-Control here. The previous ETag was keyed on
    // (channel_id, row_count, newest_created_at) — none of which change
    // when a reaction is added/removed, a message is edited, or a pin
    // is toggled. That caused the periodic refresh to serve a 304 with
    // stale state on top of the user's optimistic chip → the chip
    // appeared to "snap back." A correct cache key would need to
    // include max(reaction.created_at) + max(updated_at) + max(pinned_at),
    // which is more SQL than the saved bandwidth is worth on a page
    // that returns ~25 messages.
    //
    // Tell intermediaries explicitly not to cache so a misconfigured
    // proxy doesn't reintroduce the same bug.
    res.set("Cache-Control", "no-store");
    res.json({ messages: ordered });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/events/:id/chat/channels/:cid/messages ────────────────
// Body: { body, parent_post_id?, attachments?, mention_user_ids? }
eventChatRouter.post("/:id/chat/channels/:cid/messages", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const cid = need(trim(req.params.cid), "Channel ID");
    const body = trim(req.body?.body);
    const parent_post_id = trim(req.body?.parent_post_id) || null;
    const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
    const mention_user_ids = Array.isArray(req.body?.mention_user_ids)
      ? req.body.mention_user_ids.filter((v: unknown) => typeof v === "string")
      : [];
    const client_id = trim(req.body?.client_id) || null;

    if (!body && attachments.length === 0) {
      throw new ApiError(400, "Either body or at least one attachment is required");
    }
    if (body.length > MAX_MESSAGE) {
      throw new ApiError(400, `Message exceeds ${MAX_MESSAGE} characters`);
    }
    if (attachments.length > 5) {
      throw new ApiError(400, "Up to 5 attachments per message");
    }

    // Speaker fast-path: a user listed in event_speakers for THIS event
    // gets the guest-speaker badge + bypasses registered/mute/role gates
    // (they're the invited authority, not an attendee).
    const [speakerRow] = await db
      .select({ id: eventSpeakers.id })
      .from(eventSpeakers)
      .where(and(
        eq(eventSpeakers.event_id, eventId),
        eq(eventSpeakers.user_id, req.user!.id),
      ))
      .limit(1);
    const isSpeaker = !!speakerRow;

    // Rate limit FIRST — cheapest check, blocks abusers before any DB hit.
    const rate = checkRate(`send:${req.user!.id}:${eventId}`, RATE_LIMITS.sendMessage);
    if (!rate.allowed) {
      throw new ApiError(429, `Slow down — try again in ${Math.ceil(rate.retryAfterMs / 1000)}s`);
    }

    // ── Perf: parallelize the three pre-checks. Speakers skip
    // registered/mute since being on event_speakers IS the authorisation.
    const [, channel, mute, parentRow] = await Promise.all([
      isSpeaker ? Promise.resolve(null) : assertRegistered(req.user!.id, eventId),
      getChannel(eventId, cid),
      isSpeaker ? Promise.resolve(null) : findActiveMute(eventId, req.user!.id, cid),
      parent_post_id
        ? db.select({ id: forumPosts.id, channel_id: forumPosts.channel_id })
            .from(forumPosts)
            .where(and(eq(forumPosts.id, parent_post_id), isNull(forumPosts.deleted_at)))
            .limit(1)
            .then((r) => r[0] ?? null)
        : Promise.resolve(null),
    ]);

    // ── Post-parallel checks (all cheap, no DB) ───────────────────
    if (channel.archived_at) throw new ApiError(403, "This channel is archived and read-only");
    if (channel.frozen && !isSpeaker) {
      // Speakers bypass the frozen gate — the invited authority typically
      // wants to broadcast when general chat is paused. Regular users
      // need moderator rights.
      try { await assertCanModerate(req.user!.id, eventId); }
      catch { throw new ApiError(403, "This channel is currently frozen"); }
    }
    if (mute) {
      const ttl = mute.muted_until ? `until ${new Date(mute.muted_until).toISOString()}` : "indefinitely";
      throw new ApiError(403, `You are muted ${ttl}${mute.reason ? ` (reason: ${mute.reason})` : ""}`);
    }
    if (parent_post_id && (!parentRow || parentRow.channel_id !== cid)) {
      throw new ApiError(400, "Reply target is not in this channel");
    }
    if (channel.post_role_required && !isSpeaker) {
      // Role-restricted channels stay open to speakers on THIS event.
      const perms = await loadUserPermissions(req.user!.id);
      if (!perms.codes.has(channel.post_role_required) && !perms.isAdmin) {
        throw new ApiError(403, `Only ${channel.post_role_required} can post here`);
      }
    }
    // Q&A: replies are moderator-only, but a speaker on this event is
    // exactly the designated answerer.
    if (channel.kind === "qa" && parent_post_id && !isSpeaker) {
      try { await assertCanModerate(req.user!.id, eventId); }
      catch {
        throw new ApiError(403,
          "Only the speaker or branch organisers can answer questions in this channel. " +
          "Members can react to questions to upvote them.");
      }
    }

    // ── Insert with idempotent ON CONFLICT ────────────────────────
    //
    // Previously we did "SELECT by (channel_id, client_id), then INSERT
    // if missing" — two round-trips even on the happy path. We replace
    // with one INSERT that does nothing on conflict + a fallback SELECT
    // only when the conflict path fires. Happy path = 1 round-trip.
    //
    // We only do @everyone/@here expansion AFTER we know the post will
    // actually be inserted (skip when this is a retry on an already-
    // accepted client_id), keeping the hot path lean.
    let inserted: typeof forumPosts.$inferSelect;
    if (client_id) {
      const upsertRows = await db
        .insert(forumPosts)
        .values({
          channel_id: cid,
          parent_post_id,
          body,
          attachments,
          mention_user_ids,
          created_by: req.user!.id,
          client_id,
        })
        .onConflictDoNothing({ target: [forumPosts.channel_id, forumPosts.client_id] })
        .returning();
      if (upsertRows.length === 0) {
        // Already accepted under this client_id — fetch + return the
        // canonical row. Idempotent retry path.
        const [existing] = await db
          .select()
          .from(forumPosts)
          .where(and(
            eq(forumPosts.channel_id, cid),
            eq(forumPosts.client_id, client_id),
            isNull(forumPosts.deleted_at),
          ))
          .limit(1);
        if (!existing) throw new ApiError(500, "Idempotency conflict but no row found");
        const badgeMap = await resolveRoleBadgesFor([existing.created_by]);
        return res.status(200).json({
          id:               existing.id,
          channel_id:       existing.channel_id,
          parent_post_id:   existing.parent_post_id,
          body:             existing.body,
          attachments:      existing.attachments,
          mention_user_ids: existing.mention_user_ids,
          pinned_at:        existing.pinned_at,
          edited_at:        existing.edited_at,
          created_by:       existing.created_by,
          author_name:      req.user!.name,
          author_badge:     isSpeaker ? "Guest speaker" : (badgeMap.get(existing.created_by) ?? null),
          is_speaker:       isSpeaker,
          created_at:       existing.created_at,
          client_id:        existing.client_id,
          reactions:        [],
          reply_count:      0,
        });
      }
      inserted = upsertRows[0];
    } else {
      // No idempotency key — straight INSERT.
      const [row] = await db
        .insert(forumPosts)
        .values({
          channel_id: cid,
          parent_post_id,
          body,
          attachments,
          mention_user_ids,
          created_by: req.user!.id,
          client_id: null,
        })
        .returning();
      inserted = row;
    }

    // ── Build the response shape ───────────────────────────────────
    // Speakers get a fixed "Guest speaker" badge that overrides their
    // role-based badge (if any). Non-speakers get their normal role badge.
    const badgeMap = await resolveRoleBadgesFor([req.user!.id]);
    const message = {
      id:               inserted.id,
      channel_id:       inserted.channel_id,
      parent_post_id:   inserted.parent_post_id,
      body:             inserted.body,
      attachments:      inserted.attachments,
      mention_user_ids: inserted.mention_user_ids,
      pinned_at:        inserted.pinned_at,
      edited_at:        inserted.edited_at,
      created_by:       inserted.created_by,
      author_name:      req.user!.name,
      author_badge:     isSpeaker ? "Guest speaker" : (badgeMap.get(req.user!.id) ?? null),
      is_speaker:       isSpeaker,
      created_at:       inserted.created_at,
      client_id:        inserted.client_id,
      reactions:        [] as Array<{ emoji: string; user_ids: string[]; count: number }>,
      reply_count:      0,
    };

    // Broadcast BEFORE responding — the sender's response and every
    // other client's WS frame go out together. Both paths share the
    // single `message` object so no extra DB work happens here.
    broadcast(eventId, { type: "message", channel_id: cid, message });

    // ── Respond IMMEDIATELY ───────────────────────────────────────
    // Everything below — channel `updated_at` touch, mention push
    // expansion + dispatch — runs after res.json. The client has its
    // canonical row + the WS broadcast has already fanned out; no
    // remaining work is on the response's critical path.
    res.status(201).json(message);

    // Background: touch channel for sidebar sort + dispatch mentions.
    // setImmediate yields to the next event loop tick so res.end's
    // buffer flushes before we start more DB work.
    setImmediate(() => {
      void (async () => {
        try {
          await db.update(eventChatChannels)
            .set({ updated_at: new Date() })
            .where(eq(eventChatChannels.id, cid));
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("[eventChat] channel touch failed:", (e as Error).message);
        }
        try {
          const finalMentionIds = await expandMentions({
            eventId,
            body,
            explicitUserIds: mention_user_ids,
            authorUserId: req.user!.id,
          });
          if (finalMentionIds.length === 0) return;
          const [eventRow] = await db
            .select({ title: events.title })
            .from(events).where(eq(events.id, eventId)).limit(1);
          dispatchMentionNotifications({
            recipientIds:    finalMentionIds,
            actorName:       req.user!.name,
            channelName:     channel.name,
            channelId:       cid,
            eventId,
            eventTitle:      eventRow?.title || "Event chat",
            messageSnippet:  body.slice(0, 140),
            messageId:       inserted.id,
          });
        } catch (e) {
          // eslint-disable-next-line no-console
          console.error("[eventChat] mention dispatch failed:", (e as Error).message);
        }
      })();
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/events/:id/chat/messages/:mid ──────────────────────────
// Edit your own message body. Soft-recorded via `edited_at`.
eventChatRouter.patch("/:id/chat/messages/:mid", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const mid = need(trim(req.params.mid), "Message ID");
    const body = trim(req.body?.body);
    if (!body) throw new ApiError(400, "Body is required");
    if (body.length > MAX_MESSAGE) throw new ApiError(400, `Message exceeds ${MAX_MESSAGE} characters`);

    await assertRegistered(req.user!.id, eventId);
    // Rate limit edit too (otherwise an attacker could spam edit toggling).
    const rate = checkRate(`edit:${req.user!.id}:${eventId}`, RATE_LIMITS.edit);
    if (!rate.allowed) throw new ApiError(429, `Slow down — try again in ${Math.ceil(rate.retryAfterMs / 1000)}s`);

    const msg = await loadMessageForMutation(eventId, mid, req.user!.id, /* requireModerator */ false);

    const editedAt = new Date();
    const [updated] = await db
      .update(forumPosts)
      .set({ body, edited_at: editedAt, updated_at: editedAt })
      .where(eq(forumPosts.id, mid))
      .returning({ id: forumPosts.id, body: forumPosts.body, edited_at: forumPosts.edited_at });

    logAudit({
      eventId, actorId: req.user!.id, action: "message_edited",
      targetMessageId: mid, targetChannelId: msg.channel_id,
      details: { previous_body: msg.body, new_body: body },
    });

    broadcast(eventId, {
      type: "message:edited",
      channel_id: msg.channel_id,
      message_id: mid,
      body:       updated.body,
      edited_at:  updated.edited_at,
    });

    res.json({ ok: true, message: updated });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/events/:id/chat/messages/:mid ─────────────────────────
eventChatRouter.delete("/:id/chat/messages/:mid", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const mid = need(trim(req.params.mid), "Message ID");

    await assertRegistered(req.user!.id, eventId);
    const msg = await loadMessageForMutation(eventId, mid, req.user!.id, /* requireModerator */ false);
    const wasMine = msg.created_by === req.user!.id;

    await db
      .update(forumPosts)
      .set({ deleted_at: new Date() })
      .where(eq(forumPosts.id, mid));

    logAudit({
      eventId, actorId: req.user!.id, action: "message_deleted",
      targetMessageId: mid, targetChannelId: msg.channel_id,
      targetUserId: msg.created_by,
      details: { mode: wasMine ? "self" : "moderator", body_snapshot: msg.body },
    });

    broadcast(eventId, {
      type: "message:deleted",
      channel_id: msg.channel_id,
      message_id: mid,
    });

    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/events/:id/chat/messages/:mid/reactions ─────────────────
// Body: { emoji }. Toggles — if the user already reacted with this emoji,
// the row is removed; otherwise inserted. Idempotent for the caller.
eventChatRouter.post("/:id/chat/messages/:mid/reactions", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const mid = need(trim(req.params.mid), "Message ID");
    const emoji = trim(req.body?.emoji);
    if (!emoji) throw new ApiError(400, "Emoji is required");
    if (emoji.length > 32) throw new ApiError(400, "Emoji too long");

    await assertRegistered(req.user!.id, eventId);
    const rate = checkRate(`react:${req.user!.id}:${eventId}`, RATE_LIMITS.toggleReaction);
    if (!rate.allowed) throw new ApiError(429, `Slow down — try again in ${Math.ceil(rate.retryAfterMs / 1000)}s`);

    // Resolve channel for broadcast scoping.
    const [post] = await db
      .select({ id: forumPosts.id, channel_id: forumPosts.channel_id })
      .from(forumPosts)
      .where(and(eq(forumPosts.id, mid), isNull(forumPosts.deleted_at)))
      .limit(1);
    if (!post?.channel_id) throw new ApiError(404, "Message not found");
    await getChannel(eventId, post.channel_id);

    const [existing] = await db
      .select({ id: forumPostReactions.id })
      .from(forumPostReactions)
      .where(and(
        eq(forumPostReactions.post_id, mid),
        eq(forumPostReactions.user_id, req.user!.id),
        eq(forumPostReactions.emoji, emoji),
      ))
      .limit(1);

    let action: "added" | "removed";
    if (existing) {
      await db.delete(forumPostReactions).where(eq(forumPostReactions.id, existing.id));
      action = "removed";
    } else {
      await db.insert(forumPostReactions).values({
        post_id: mid, user_id: req.user!.id, emoji,
      });
      action = "added";
    }

    broadcast(eventId, {
      type: "reaction",
      action,
      channel_id: post.channel_id,
      message_id: mid,
      emoji,
      user_id: req.user!.id,
    });

    res.json({ ok: true, action });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/events/:id/chat/messages/:mid/pin (and /unpin) ──────────
async function pinHandler(req: AuthedRequest, res: any, next: any, pin: boolean) {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const mid = need(trim(req.params.mid), "Message ID");
    await assertRegistered(req.user!.id, eventId);
    const msg = await loadMessageForMutation(eventId, mid, req.user!.id, /* requireModerator */ true);

    const pinned_at = pin ? new Date() : null;
    await db.update(forumPosts)
      .set({ pinned_at, updated_at: new Date() })
      .where(eq(forumPosts.id, mid));

    logAudit({
      eventId, actorId: req.user!.id, action: pin ? "message_pinned" : "message_unpinned",
      targetMessageId: mid, targetChannelId: msg.channel_id,
    });

    broadcast(eventId, {
      type: pin ? "pin:added" : "pin:removed",
      channel_id: msg.channel_id,
      message_id: mid,
      pinned_at,
    });

    res.json({ ok: true, pinned_at });
  } catch (err) { handleApiError(err, res, next); }
}
eventChatRouter.post("/:id/chat/messages/:mid/pin", requireUser, (req, res, next) => pinHandler(req as AuthedRequest, res, next, true));
eventChatRouter.post("/:id/chat/messages/:mid/unpin", requireUser, (req, res, next) => pinHandler(req as AuthedRequest, res, next, false));

// ─── POST /api/events/:id/chat/messages/:mid/answered (and /unanswered) ─
// Mark a top-level Q&A question as resolved / re-open it. Only meaningful
// for posts in channel.kind = 'qa'. Restricted to moderators (admin /
// branch chairman / chairing-committee chairman) — speakers landing via
// magic-link inherit moderation on their event only.
async function answeredHandler(req: AuthedRequest, res: any, next: any, mark: boolean) {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const mid = need(trim(req.params.mid), "Message ID");
    await assertRegistered(req.user!.id, eventId);
    const msg = await loadMessageForMutation(eventId, mid, req.user!.id, /* requireModerator */ true);

    if (msg.parent_post_id) {
      throw new ApiError(400, "Only top-level questions can be marked answered — replies inherit the question's state");
    }
    const channel = await getChannel(eventId, msg.channel_id!);
    if (channel.kind !== "qa") {
      throw new ApiError(400, "This action is only available in Q&A channels");
    }

    const answered_at = mark ? new Date() : null;
    const answered_by = mark ? req.user!.id : null;
    await db.update(forumPosts)
      .set({ answered_at, answered_by, updated_at: new Date() })
      .where(eq(forumPosts.id, mid));

    logAudit({
      eventId, actorId: req.user!.id,
      action: mark ? "message_answered" : "message_unanswered",
      targetMessageId: mid, targetChannelId: msg.channel_id,
    });

    broadcast(eventId, {
      type: mark ? "answered:added" : "answered:removed",
      channel_id: msg.channel_id,
      message_id: mid,
      answered_at,
      answered_by,
    });

    res.json({ ok: true, answered_at, answered_by });
  } catch (err) { handleApiError(err, res, next); }
}
eventChatRouter.post("/:id/chat/messages/:mid/answered",   requireUser, (req, res, next) => answeredHandler(req as AuthedRequest, res, next, true));
eventChatRouter.post("/:id/chat/messages/:mid/unanswered", requireUser, (req, res, next) => answeredHandler(req as AuthedRequest, res, next, false));

// ─── GET /api/events/:id/chat/channels/:cid/pinned ─────────────────────
eventChatRouter.get("/:id/chat/channels/:cid/pinned", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const cid = need(trim(req.params.cid), "Channel ID");
    await assertRegistered(req.user!.id, eventId);
    await getChannel(eventId, cid);

    const rows = await db
      .select(messageColumns())
      .from(forumPosts)
      .innerJoin(users, eq(users.id, forumPosts.created_by))
      .where(and(
        eq(forumPosts.channel_id, cid),
        isNull(forumPosts.deleted_at),
        sql`${forumPosts.pinned_at} is not null`,
      ))
      .orderBy(desc(forumPosts.pinned_at))
      .limit(50);
    const hydrated = await hydrateMessages(rows as any);
    res.json({ messages: hydrated });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/events/:id/chat/channels/:cid/search?q=... ───────────────
eventChatRouter.get("/:id/chat/channels/:cid/search", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const cid = need(trim(req.params.cid), "Channel ID");
    const q = trim(req.query.q);
    if (!q) return res.json({ messages: [] });
    if (q.length < 2) throw new ApiError(400, "Search needs at least 2 characters");
    await assertRegistered(req.user!.id, eventId);
    await getChannel(eventId, cid);

    const rows = await db
      .select(messageColumns())
      .from(forumPosts)
      .innerJoin(users, eq(users.id, forumPosts.created_by))
      .where(and(
        eq(forumPosts.channel_id, cid),
        isNull(forumPosts.deleted_at),
        ilike(forumPosts.body, `%${q}%`),
      ))
      .orderBy(desc(forumPosts.created_at))
      .limit(40);
    const hydrated = await hydrateMessages(rows as any);
    res.json({ messages: hydrated });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/events/:id/chat/channels/:cid/read ──────────────────────
// Mark the channel as read up to now. Upserts the (channel, user) row.
eventChatRouter.post("/:id/chat/channels/:cid/read", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const cid = need(trim(req.params.cid), "Channel ID");
    await assertRegistered(req.user!.id, eventId);
    await getChannel(eventId, cid);

    await db
      .insert(eventChatChannelReads)
      .values({ channel_id: cid, user_id: req.user!.id, last_read_at: new Date() })
      .onConflictDoUpdate({
        target: [eventChatChannelReads.channel_id, eventChatChannelReads.user_id],
        set: { last_read_at: new Date() },
      });

    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/events/:id/chat/participants?q=... ───────────────────────
// Used by the @mention autocomplete in the composer. Only returns users
// registered for THIS event (so you can't ping people who aren't in the
// room). q can be partial name or email.
eventChatRouter.get("/:id/chat/participants", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const q = trim(req.query.q);
    await assertRegistered(req.user!.id, eventId);

    const conds = [
      eq(eventRegistrations.event_id, eventId),
      isNull(eventRegistrations.deleted_at),
      isNull(users.deleted_at),
    ];
    if (q && q.length >= 1) {
      conds.push(sql`(${users.name} ILIKE ${`%${q}%`} OR ${users.email} ILIKE ${`%${q}%`})`);
    }

    const rows = await db
      .select({
        id:    users.id,
        name:  users.name,
        email: users.email,
      })
      .from(eventRegistrations)
      .innerJoin(users, eq(users.id, eventRegistrations.user_id))
      .where(and(...conds))
      .orderBy(asc(users.name))
      .limit(20);
    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/events/:id/chat/upload ──────────────────────────────────
// File-attachment upload for a chat message. Accepts the same base64
// shape as /api/admin/files. Restricted to PDFs and common image types
// for safety. The response gives back a small attachment descriptor that
// the client tucks into the POST messages body.
eventChatRouter.post("/:id/chat/upload", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    await assertRegistered(req.user!.id, eventId);

    // Rate limit uploads. 10/min/user — enough for a few image shares
    // per conversation, far below "spam the bucket" rates.
    const rate = checkRate(`upload:${req.user!.id}:${eventId}`, RATE_LIMITS.upload);
    if (!rate.allowed) throw new ApiError(429, `Slow down — try again in ${Math.ceil(rate.retryAfterMs / 1000)}s`);

    const name     = need(trim(req.body?.name), "Filename");
    const mimeType = need(trim(req.body?.mime_type), "MIME type");
    const dataB64: string = typeof req.body?.data_base64 === "string" ? req.body.data_base64 : "";

    if (!dataB64) throw new ApiError(400, "File data is required");
    if (!ATTACHMENT_MIME_ALLOW.has(mimeType)) throw new ApiError(400, "Unsupported attachment type");

    const stripped = dataB64.replace(/^data:[^;]+;base64,/, "");
    // Use Buffer<ArrayBufferLike> so it stays assignable both to/from
    // sharp output (which returns Buffer over ArrayBufferLike).
    let buf: Buffer = Buffer.from(stripped, "base64");
    if (buf.length === 0) throw new ApiError(400, "File data is empty");
    if (buf.length > ATTACHMENT_MAX_BYTES) {
      throw new ApiError(400, `Attachment exceeds ${Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024))} MB limit`);
    }

    // Per-user lifetime storage quota — caps abuse without quotas per
    // event (we don't yet know if individual users will dominate one).
    await assertQuotaAvailable(req.user!.id, buf.length);

    // Images go through the sharp pipeline: strip EXIF (privacy),
    // resize to max 1600px width (so a phone-camera 12 MP shot drops
    // from 4 MB to a few hundred KB), and re-encode to WebP. Other
    // attachment types are written as-is.
    let storedMime = mimeType;
    let storedExt  = (name.match(/\.[a-zA-Z0-9]+$/)?.[0] ?? "").toLowerCase();
    if (mimeType.startsWith("image/")) {
      try {
        const processed = await sharp(buf, { failOn: "none" })
          .rotate()  // honour EXIF orientation, then strip
          .resize({ width: 1600, withoutEnlargement: true })
          .webp({ quality: 82 })
          .toBuffer();
        if (processed.length < buf.length) {
          buf = processed;
          storedMime = "image/webp";
          storedExt  = ".webp";
        }
      } catch (e) {
        // If sharp fails (corrupt image / unsupported variant) fall
        // back to the original bytes. Don't error — the user just
        // wants their screenshot.
        // eslint-disable-next-line no-console
        console.warn("[eventChat upload] sharp failed, storing original:", (e as Error).message);
      }
    }

    const safeFilename = `${randomUUID()}${storedExt}`;
    const storage_path = await storage().put("chat", safeFilename, buf, storedMime);

    const [row] = await db.insert(files).values({
      name,
      mime_type:   storedMime,
      size_bytes:  buf.length,
      storage_path,
      bucket:      "chat",
      uploaded_by: req.user!.id,
    }).returning();

    // Update the user's running total. Fire-and-forget so a slow update
    // doesn't delay the response — worst case it drifts by ~1 upload.
    incrementQuotaUsage(req.user!.id, buf.length).catch(() => {});

    res.status(201).json({
      id:          row.id,
      name:        row.name,
      mime_type:   row.mime_type,
      size_bytes:  row.size_bytes,
      url:         storage().url(storage_path),
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Channel CRUD (moderator-only) ─────────────────────────────────────

eventChatRouter.post("/:id/chat/channels", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    await assertRegistered(req.user!.id, eventId);
    await assertCanModerate(req.user!.id, eventId);
    const name = need(trim(req.body?.name), "Channel name").slice(0, 64);
    const description = trim(req.body?.description) || null;
    const kind = trim(req.body?.kind) || "general";
    const post_role_required = trim(req.body?.post_role_required) || null;
    const sort_order = Number.isFinite(Number(req.body?.sort_order))
      ? Math.trunc(Number(req.body.sort_order)) : 10;

    const [row] = await db.insert(eventChatChannels).values({
      event_id: eventId, name, description, kind, sort_order, post_role_required,
    }).returning();
    res.status(201).json({ channel: row });
  } catch (err) { handleApiError(err, res, next); }
});

eventChatRouter.patch("/:id/chat/channels/:cid", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const cid = need(trim(req.params.cid), "Channel ID");
    await assertRegistered(req.user!.id, eventId);
    await assertCanModerate(req.user!.id, eventId);
    await getChannel(eventId, cid);

    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (typeof req.body?.name === "string")        patch.name = trim(req.body.name).slice(0, 64) || undefined;
    if ("description" in req.body)                  patch.description = trim(req.body.description) || null;
    if ("post_role_required" in req.body)           patch.post_role_required = trim(req.body.post_role_required) || null;
    if (Number.isFinite(Number(req.body?.sort_order))) patch.sort_order = Math.trunc(Number(req.body.sort_order));

    const [row] = await db.update(eventChatChannels)
      .set(patch as any)
      .where(eq(eventChatChannels.id, cid))
      .returning();
    res.json({ channel: row });
  } catch (err) { handleApiError(err, res, next); }
});

eventChatRouter.delete("/:id/chat/channels/:cid", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const cid = need(trim(req.params.cid), "Channel ID");
    await assertRegistered(req.user!.id, eventId);
    await assertCanModerate(req.user!.id, eventId);

    await db.update(eventChatChannels)
      .set({ deleted_at: new Date(), updated_at: new Date() })
      .where(and(eq(eventChatChannels.id, cid), eq(eventChatChannels.event_id, eventId)));
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Legacy v1 compat ──────────────────────────────────────────────────
// Older clients (pre-rewamp) hit `GET /chat` and `POST /chat` without a
// channel id. We map those onto the auto-provisioned "general" channel
// so the migration is invisible.
eventChatRouter.get("/:id/chat/older", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const before = trim(req.query.before);
    if (!before) throw new ApiError(400, "before is required");
    await assertRegistered(req.user!.id, eventId);

    const channels = await ensureChannelsForEvent(eventId);
    const general = channels.find((c) => c.kind === "general") ?? channels[0];
    if (!general) return res.json({ messages: [] });

    const beforeDate = new Date(before);
    if (Number.isNaN(beforeDate.getTime())) throw new ApiError(400, "before must be an ISO timestamp");

    const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || DEFAULT_PAGE_SIZE));
    const rows = await db
      .select(messageColumns())
      .from(forumPosts)
      .innerJoin(users, eq(users.id, forumPosts.created_by))
      .where(and(
        eq(forumPosts.channel_id, general.id),
        isNull(forumPosts.deleted_at),
        lt(forumPosts.created_at, beforeDate),
      ))
      .orderBy(desc(forumPosts.created_at))
      .limit(pageSize);
    const hydrated = await hydrateMessages(rows as any);
    res.json({ messages: hydrated.reverse() });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/events/:id/chat/channels/:cid/catchup?since=<iso> ────────
// "I just reconnected — what did I miss?" Returns every message in the
// channel with `created_at > since`, ordered oldest-first so the client
// can append. Used after a WebSocket reconnect so dropped events don't
// leave the message list silently inconsistent.
eventChatRouter.get("/:id/chat/channels/:cid/catchup", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const cid = need(trim(req.params.cid), "Channel ID");
    const since = trim(req.query.since);
    if (!since) throw new ApiError(400, "since is required");
    const sinceDate = new Date(since);
    if (Number.isNaN(sinceDate.getTime())) throw new ApiError(400, "since must be an ISO timestamp");

    await assertRegistered(req.user!.id, eventId);
    await getChannel(eventId, cid);

    const rows = await db
      .select(messageColumns())
      .from(forumPosts)
      .innerJoin(users, eq(users.id, forumPosts.created_by))
      .where(and(
        eq(forumPosts.channel_id, cid),
        gt(forumPosts.created_at, sinceDate),
      ))
      .orderBy(asc(forumPosts.created_at))
      .limit(500); // safety net; in practice this'll be a handful
    const hydrated = (await hydrateMessages(rows as any)).map(stripIfDeleted);
    res.json({ messages: hydrated });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/events/:id/chat/roster ───────────────────────────────────
// Member roster for the sidebar. Returns every registered attendee with
// `is_online` derived from the WS room set. Avatars/colors are computed
// client-side.
eventChatRouter.get("/:id/chat/roster", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    await assertRegistered(req.user!.id, eventId);

    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(eventRegistrations)
      .innerJoin(users, eq(users.id, eventRegistrations.user_id))
      .where(and(
        eq(eventRegistrations.event_id, eventId),
        isNull(eventRegistrations.deleted_at),
        isNull(users.deleted_at),
      ))
      .orderBy(asc(users.name))
      .limit(500);

    const onlineSet = new Set((await import("../lib/eventChatRooms.js")).getOnlineUserIds(eventId));
    const badges = await resolveRoleBadgesFor(rows.map((r) => r.id));

    res.json({
      members: rows.map((r) => ({
        id: r.id, name: r.name, email: r.email,
        is_online: onlineSet.has(r.id),
        badge: badges.get(r.id) ?? null,
      })),
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Moderation: mutes ─────────────────────────────────────────────────
// POST /chat/mutes  { user_id, channel_id?, minutes?, reason? }
// GET  /chat/mutes  — list active mutes for the event
// DELETE /chat/mutes/:muteId
eventChatRouter.post("/:id/chat/mutes", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    await assertRegistered(req.user!.id, eventId);
    await assertCanModerate(req.user!.id, eventId);

    const userId    = need(trim(req.body?.user_id), "user_id");
    const channelId = trim(req.body?.channel_id) || null;
    const minutes   = req.body?.minutes != null ? Math.max(1, Math.trunc(Number(req.body.minutes))) : null;
    const reason    = trim(req.body?.reason) || null;
    const muted_until = minutes ? new Date(Date.now() + minutes * 60_000) : null;

    if (channelId) await getChannel(eventId, channelId);

    const [row] = await db.insert(eventChatMutes).values({
      event_id: eventId, user_id: userId, channel_id: channelId,
      reason, muted_until, muted_by: req.user!.id,
    }).returning();

    logAudit({
      eventId, actorId: req.user!.id, action: "user_muted",
      targetUserId: userId, targetChannelId: channelId,
      details: { minutes, reason, muted_until: muted_until?.toISOString() ?? null },
    });

    res.status(201).json({ mute: row });
  } catch (err) { handleApiError(err, res, next); }
});

eventChatRouter.get("/:id/chat/mutes", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    await assertRegistered(req.user!.id, eventId);
    await assertCanModerate(req.user!.id, eventId);

    const now = new Date();
    const rows = await db.select({
      id:          eventChatMutes.id,
      user_id:     eventChatMutes.user_id,
      channel_id:  eventChatMutes.channel_id,
      muted_until: eventChatMutes.muted_until,
      reason:      eventChatMutes.reason,
      muted_by:    eventChatMutes.muted_by,
      created_at:  eventChatMutes.created_at,
      user_name:   users.name,
    })
      .from(eventChatMutes)
      .leftJoin(users, eq(users.id, eventChatMutes.user_id))
      .where(eq(eventChatMutes.event_id, eventId))
      .orderBy(desc(eventChatMutes.created_at))
      .limit(200);

    // "Active" = no muted_until set, OR muted_until is still in the future.
    // We filter in JS rather than in SQL to keep the query free of the
    // null-or-gt() boolean glue that drizzle sometimes refuses to compose.
    const active = rows.filter((r) => !r.muted_until || new Date(r.muted_until).getTime() > now.getTime());
    res.json({ mutes: active });
  } catch (err) { handleApiError(err, res, next); }
});

eventChatRouter.delete("/:id/chat/mutes/:muteId", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const muteId  = need(trim(req.params.muteId), "Mute ID");
    await assertRegistered(req.user!.id, eventId);
    await assertCanModerate(req.user!.id, eventId);

    const [existing] = await db
      .select({ user_id: eventChatMutes.user_id, channel_id: eventChatMutes.channel_id })
      .from(eventChatMutes)
      .where(and(eq(eventChatMutes.id, muteId), eq(eventChatMutes.event_id, eventId)))
      .limit(1);
    if (!existing) throw new ApiError(404, "Mute not found");

    await db.delete(eventChatMutes).where(eq(eventChatMutes.id, muteId));
    logAudit({
      eventId, actorId: req.user!.id, action: "user_unmuted",
      targetUserId: existing.user_id, targetChannelId: existing.channel_id,
    });
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Moderation: freeze / unfreeze / archive a channel ─────────────────
eventChatRouter.post("/:id/chat/channels/:cid/freeze", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const cid     = need(trim(req.params.cid), "Channel ID");
    await assertRegistered(req.user!.id, eventId);
    await assertCanModerate(req.user!.id, eventId);
    await getChannel(eventId, cid);

    await db.update(eventChatChannels)
      .set({ frozen: true, updated_at: new Date() })
      .where(eq(eventChatChannels.id, cid));
    logAudit({ eventId, actorId: req.user!.id, action: "channel_frozen", targetChannelId: cid });
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

eventChatRouter.post("/:id/chat/channels/:cid/unfreeze", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const cid     = need(trim(req.params.cid), "Channel ID");
    await assertRegistered(req.user!.id, eventId);
    await assertCanModerate(req.user!.id, eventId);
    await getChannel(eventId, cid);

    await db.update(eventChatChannels)
      .set({ frozen: false, updated_at: new Date() })
      .where(eq(eventChatChannels.id, cid));
    logAudit({ eventId, actorId: req.user!.id, action: "channel_unfrozen", targetChannelId: cid });
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

eventChatRouter.post("/:id/chat/channels/:cid/archive", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const cid     = need(trim(req.params.cid), "Channel ID");
    await assertRegistered(req.user!.id, eventId);
    await assertCanModerate(req.user!.id, eventId);
    await getChannel(eventId, cid);

    await db.update(eventChatChannels)
      .set({ archived_at: new Date(), updated_at: new Date() })
      .where(eq(eventChatChannels.id, cid));
    logAudit({ eventId, actorId: req.user!.id, action: "channel_archived", targetChannelId: cid });
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Message reports ───────────────────────────────────────────────────
// POST   /chat/messages/:mid/report  { reason }
// GET    /chat/reports                (moderator only — pending reports)
// PATCH  /chat/reports/:reportId      { resolution_note } — mark resolved
eventChatRouter.post("/:id/chat/messages/:mid/report", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    const mid     = need(trim(req.params.mid), "Message ID");
    const reason  = need(trim(req.body?.reason), "Reason");
    if (reason.length > 500) throw new ApiError(400, "Reason too long (max 500 chars)");

    await assertRegistered(req.user!.id, eventId);
    const rate = checkRate(`report:${req.user!.id}:${eventId}`, RATE_LIMITS.report);
    if (!rate.allowed) throw new ApiError(429, `Slow down — try again in ${Math.ceil(rate.retryAfterMs / 1000)}s`);

    // Confirm the message lives in this event's chat.
    const [post] = await db
      .select({ id: forumPosts.id, channel_id: forumPosts.channel_id })
      .from(forumPosts).where(eq(forumPosts.id, mid)).limit(1);
    if (!post?.channel_id) throw new ApiError(404, "Message not found");
    await getChannel(eventId, post.channel_id);

    try {
      const [row] = await db.insert(eventChatMessageReports).values({
        message_id: mid, reported_by: req.user!.id, reason,
      }).returning();
      logAudit({
        eventId, actorId: req.user!.id, action: "report_created",
        targetMessageId: mid, targetChannelId: post.channel_id,
        details: { reason },
      });
      res.status(201).json({ report: row });
    } catch (e: any) {
      if (e?.code === "23505") throw new ApiError(409, "You've already reported this message");
      throw e;
    }
  } catch (err) { handleApiError(err, res, next); }
});

eventChatRouter.get("/:id/chat/reports", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId = need(trim(req.params.id), "Event ID");
    await assertRegistered(req.user!.id, eventId);
    await assertCanModerate(req.user!.id, eventId);

    const reporterAlias = users;
    const rows = await db
      .select({
        id:                 eventChatMessageReports.id,
        message_id:         eventChatMessageReports.message_id,
        message_body:       forumPosts.body,
        reported_by:        eventChatMessageReports.reported_by,
        reporter_name:      reporterAlias.name,
        reason:             eventChatMessageReports.reason,
        resolved_at:        eventChatMessageReports.resolved_at,
        resolution_note:    eventChatMessageReports.resolution_note,
        created_at:         eventChatMessageReports.created_at,
      })
      .from(eventChatMessageReports)
      .innerJoin(forumPosts, eq(forumPosts.id, eventChatMessageReports.message_id))
      .innerJoin(reporterAlias, eq(reporterAlias.id, eventChatMessageReports.reported_by))
      .innerJoin(eventChatChannels, eq(eventChatChannels.id, forumPosts.channel_id))
      .where(eq(eventChatChannels.event_id, eventId))
      .orderBy(desc(eventChatMessageReports.created_at))
      .limit(100);
    res.json({ reports: rows });
  } catch (err) { handleApiError(err, res, next); }
});

eventChatRouter.patch("/:id/chat/reports/:reportId", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const eventId  = need(trim(req.params.id), "Event ID");
    const reportId = need(trim(req.params.reportId), "Report ID");
    await assertRegistered(req.user!.id, eventId);
    await assertCanModerate(req.user!.id, eventId);

    const resolution_note = trim(req.body?.resolution_note) || null;
    await db.update(eventChatMessageReports)
      .set({ resolved_at: new Date(), resolved_by: req.user!.id, resolution_note })
      .where(eq(eventChatMessageReports.id, reportId));
    logAudit({ eventId, actorId: req.user!.id, action: "report_resolved", details: { report_id: reportId, resolution_note } });
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// Re-export the seed helper for any future server-side path that wants to
// drop a system message into an event chat (e.g. registration confirmations).
export { ensureChannelsForEvent };
