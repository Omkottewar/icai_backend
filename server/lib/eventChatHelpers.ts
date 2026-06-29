// Helpers used by the event-chat router. Pulled into a separate file
// so eventChat.ts doesn't balloon past readable.
//
// Owns:
//   • Rate limiter (in-process, per-user)
//   • Mute lookup
//   • @everyone / @here expansion + mention notification dispatch
//   • Audit log write
//   • Storage quota helpers
//   • Role-badge resolution for an author payload

import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  users, eventRegistrations,
  eventChatMutes, eventChatAudit, forumPosts,
} from "../../schema/index.js";
import { loadUserPermissions } from "../auth/permissions.js";
import { notifyAsync } from "./notify.js";
import { getOnlineUserIds } from "./eventChatRooms.js";

// ─── Rate limiter ────────────────────────────────────────────────────────
//
// Sliding-window counter, in-process Map<key, timestamps[]>. Each call
// records a tick + returns whether the action exceeded its limit. Tiny
// + dependency-free; for multi-process we'd swap this for a Redis token
// bucket later. The buckets are pruned lazily as they're queried so the
// memory footprint is bounded by active-user count, not total messages.

const BUCKETS = new Map<string, number[]>();
// Hard ceiling on distinct rate-limit keys held in memory. Each key is
// (action:userId:eventId) — for a busy event with ~500 attendees and 4
// actions that's ~2k keys, so the cap mostly catches abuse vectors that
// craft unique keys. When we cross the cap we sweep buckets whose
// newest tick is older than the longest window (60s) — i.e. inactive —
// in insertion order until we're back under. Inserting an existing
// active user just bumps their tick, so legitimate traffic survives.
const BUCKETS_MAX = 10_000;
const MAX_WINDOW_MS = 60_000;
let lastSweepAt = 0;

function sweepBucketsIfNeeded(now: number) {
  if (BUCKETS.size < BUCKETS_MAX) return;
  // Don't sweep more than once per second under sustained pressure —
  // each sweep is O(n) over the map.
  if (now - lastSweepAt < 1000) return;
  lastSweepAt = now;
  const inactiveCutoff = now - MAX_WINDOW_MS;
  for (const [k, arr] of BUCKETS) {
    if (arr.length === 0 || arr[arr.length - 1]! < inactiveCutoff) {
      BUCKETS.delete(k);
      if (BUCKETS.size < BUCKETS_MAX) break;
    }
  }
}

export interface RateLimit { max: number; windowMs: number; }

export function checkRate(key: string, limit: RateLimit): { allowed: boolean; retryAfterMs: number } {
  const now = Date.now();
  const cutoff = now - limit.windowMs;
  sweepBucketsIfNeeded(now);
  let arr = BUCKETS.get(key);
  if (!arr) { arr = []; BUCKETS.set(key, arr); }
  // Prune anything older than the window.
  while (arr.length > 0 && arr[0]! < cutoff) arr.shift();
  if (arr.length >= limit.max) {
    return { allowed: false, retryAfterMs: arr[0]! + limit.windowMs - now };
  }
  arr.push(now);
  return { allowed: true, retryAfterMs: 0 };
}

// Pre-set rate limits for chat actions. Tuned for the ICAI use case
// (event with a few hundred attendees, no bots).
export const RATE_LIMITS = {
  sendMessage:    { max: 30, windowMs: 60_000 } as RateLimit, // 30 msg / minute
  edit:           { max: 20, windowMs: 60_000 } as RateLimit,
  toggleReaction: { max: 60, windowMs: 60_000 } as RateLimit,
  upload:         { max: 10, windowMs: 60_000 } as RateLimit,
  report:         { max: 10, windowMs: 60_000 } as RateLimit,
};

// ─── Mute lookup ─────────────────────────────────────────────────────────
//
// Returns the active mute row that applies to this (user, event[, channel])
// tuple, or null. Active = muted_until IS NULL or in the future.
export async function findActiveMute(eventId: string, userId: string, channelId?: string | null) {
  const now = new Date();
  const conds = [
    eq(eventChatMutes.event_id, eventId),
    eq(eventChatMutes.user_id, userId),
    or(isNull(eventChatMutes.muted_until), gt(eventChatMutes.muted_until, now)),
  ];
  if (channelId) {
    // Channel-scoped mutes count; so do event-wide ones (channel_id NULL).
    conds.push(or(eq(eventChatMutes.channel_id, channelId), isNull(eventChatMutes.channel_id))!);
  } else {
    conds.push(isNull(eventChatMutes.channel_id));
  }
  const [row] = await db
    .select({
      id: eventChatMutes.id,
      muted_until: eventChatMutes.muted_until,
      reason: eventChatMutes.reason,
    })
    .from(eventChatMutes)
    .where(and(...conds))
    .limit(1);
  return row ?? null;
}

// ─── @everyone / @here expansion ─────────────────────────────────────────
//
// Returns the set of user-ids the message should fan out to, given the
// body and the explicit `mention_user_ids` the client extracted. We
// also detect:
//   • @everyone — all registered attendees for the event
//   • @here     — only users currently connected to the WS room
//
// To keep things safe under busy events we cap fan-out at MAX_MENTIONS
// recipients (config below). If a message tries to ping more than that,
// the extras are silently dropped — the message still posts. (We log a
// warning so the chairman can audit if needed.)
const MAX_MENTIONS = 100;

export async function expandMentions(opts: {
  eventId: string;
  body: string;
  explicitUserIds: string[];
  authorUserId: string;
}): Promise<string[]> {
  const wantsEveryone = /(^|\s)@everyone(\s|$)/.test(opts.body);
  const wantsHere     = /(^|\s)@here(\s|$)/.test(opts.body);

  const set = new Set<string>(opts.explicitUserIds);

  if (wantsEveryone) {
    const rows = await db
      .select({ user_id: eventRegistrations.user_id })
      .from(eventRegistrations)
      .where(and(
        eq(eventRegistrations.event_id, opts.eventId),
        isNull(eventRegistrations.deleted_at),
      ));
    for (const r of rows) set.add(r.user_id);
  } else if (wantsHere) {
    for (const uid of getOnlineUserIds(opts.eventId)) set.add(uid);
  }

  // Strip the actor — you shouldn't notify yourself.
  set.delete(opts.authorUserId);

  const ids = Array.from(set);
  if (ids.length > MAX_MENTIONS) {
    // eslint-disable-next-line no-console
    console.warn(`[eventChat] mention fan-out capped at ${MAX_MENTIONS} for event ${opts.eventId} — message had ${ids.length} recipients`);
    return ids.slice(0, MAX_MENTIONS);
  }
  return ids;
}

// Dispatch the chat_mention push to each recipient. Fire-and-forget — we
// don't block the POST response on push delivery.
export function dispatchMentionNotifications(opts: {
  recipientIds: string[];
  actorName: string;
  channelName: string;
  channelId: string;
  eventId: string;
  eventTitle: string;
  messageSnippet: string;
  messageId: string;
}): void {
  for (const uid of opts.recipientIds) {
    notifyAsync({
      user_id: uid,
      template_key: "chat_mention",
      vars: {
        actor_name:   opts.actorName,
        channel_name: opts.channelName,
        event_title:  opts.eventTitle,
        snippet:      opts.messageSnippet,
        recipient_name: "", // template handles missing var gracefully
      },
      link_url: `/events?chat=${opts.eventId}&channel=${opts.channelId}&msg=${opts.messageId}`,
    });
  }
}

// ─── Audit log ───────────────────────────────────────────────────────────
//
// One row per moderator action / message mutation. Fire-and-forget — we
// don't fail the request if the audit insert is rejected; logging
// failure to console is more useful than 500-ing on the user.
export type AuditAction =
  | "message_edited"
  | "message_deleted"
  | "message_pinned"
  | "message_unpinned"
  | "message_answered"
  | "message_unanswered"
  | "user_muted"
  | "user_unmuted"
  | "channel_frozen"
  | "channel_unfrozen"
  | "channel_archived"
  | "report_created"
  | "report_resolved";

export function logAudit(input: {
  eventId: string;
  actorId: string | null;
  action: AuditAction;
  targetMessageId?: string | null;
  targetUserId?: string | null;
  targetChannelId?: string | null;
  details?: Record<string, unknown>;
}): void {
  db.insert(eventChatAudit).values({
    event_id: input.eventId,
    actor_id: input.actorId,
    action: input.action,
    target_message_id: input.targetMessageId ?? null,
    target_user_id: input.targetUserId ?? null,
    target_channel_id: input.targetChannelId ?? null,
    details: (input.details ?? {}) as any,
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[eventChat audit] write failed", { action: input.action, err: err?.message });
  });
}

// ─── Storage quota ───────────────────────────────────────────────────────
//
// 200 MB lifetime quota per user — generous for human chatters, snug
// enough to stop the obvious abuse vector of uploading 8 MB images in a
// loop. We track the running total on `users.chat_bytes_used` so the
// check stays O(1).
const CHAT_QUOTA_BYTES = 200 * 1024 * 1024;

export async function assertQuotaAvailable(userId: string, addBytes: number): Promise<void> {
  const [u] = await db
    .select({ used: users.chat_bytes_used })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const used = u?.used ?? 0;
  if (used + addBytes > CHAT_QUOTA_BYTES) {
    const err: any = new Error("Chat upload quota exceeded — delete old attachments to free space");
    err.status = 413;
    throw err;
  }
}

export async function incrementQuotaUsage(userId: string, bytes: number): Promise<void> {
  await db
    .update(users)
    .set({ chat_bytes_used: sql`${users.chat_bytes_used} + ${bytes}` })
    .where(eq(users.id, userId));
}

// ─── Role badges ─────────────────────────────────────────────────────────
//
// Looks up the caller's most-specific role for chat-attribution. The
// returned string is rendered as a tiny pill next to their name (e.g.
// "Chairman", "Treasurer", "Committee chair", "Speaker"). The lookup is
// cached by `loadUserPermissions`, so calling this per message is cheap.
//
// "Speaker" is special-cased — currently we don't have a speakers table
// linked to chat, so we return null for that case until that wiring lands.
export async function resolveRoleBadge(userId: string): Promise<string | null> {
  const perms = await loadUserPermissions(userId);
  const codes = perms.codes;
  if (codes.has("admin"))                return "Admin";
  if (codes.has("branch_chairman"))      return "Chairman";
  if (codes.has("branch_vice_chairman")) return "Vice-Chairman";
  if (codes.has("branch_secretary"))     return "Secretary";
  if (codes.has("branch_treasurer"))     return "Treasurer";
  if (codes.has("committee_chairman"))   return "Committee chair";
  return null;
}

// Bulk variant for hydrating a page of messages.
export async function resolveRoleBadgesFor(userIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  await Promise.all(userIds.map(async (uid) => {
    out.set(uid, await resolveRoleBadge(uid));
  }));
  return out;
}

void forumPosts; // imported for cross-ref; not used directly in this file
void inArray;
