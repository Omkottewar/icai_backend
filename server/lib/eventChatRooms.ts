// In-memory room manager for the event chat WebSocket fan-out.
//
// Tracks every live WebSocket grouped by event_id PLUS the userId behind
// each socket. REST and WS both push messages through `broadcast(eventId,
// payload)` — REST writes hit the DB first, then call this so other
// clients see the new row without polling.
//
// Memory only — surviving a restart is not required: clients reconnect
// and re-fetch the last N messages over REST on reload.
//
// Caveat: this is a single-process room manager. Scaling to multiple
// node instances (PM2 cluster, multiple regions) needs Redis pub/sub
// in front of this — see PENDING_ITEMS.md "Tier 2 chat hardening" for
// the deferred follow-up.

import type { WebSocket } from "ws";

type EventId = string;
interface Member { ws: WebSocket; userId: string; }

const ROOMS = new Map<EventId, Set<Member>>();

export function joinRoom(eventId: EventId, ws: WebSocket, userId: string): void {
  let room = ROOMS.get(eventId);
  if (!room) {
    room = new Set();
    ROOMS.set(eventId, room);
  }
  room.add({ ws, userId });
}

export function leaveRoom(eventId: EventId, ws: WebSocket): void {
  const room = ROOMS.get(eventId);
  if (!room) return;
  for (const m of room) {
    if (m.ws === ws) { room.delete(m); break; }
  }
  if (room.size === 0) ROOMS.delete(eventId);
}

export function broadcast(eventId: EventId, payload: unknown): void {
  const room = ROOMS.get(eventId);
  if (!room) return;
  const text = JSON.stringify(payload);
  for (const m of room) {
    // OPEN === 1. Skip CONNECTING / CLOSING / CLOSED to avoid throws.
    if (m.ws.readyState === 1) {
      try { m.ws.send(text); } catch { /* drop on the floor — the close handler will sweep it */ }
    }
  }
}

export function roomSize(eventId: EventId): number {
  return ROOMS.get(eventId)?.size ?? 0;
}

// Distinct userIds currently connected to the room. Used by @here to
// scope a fan-out mention to "everyone with the tab open right now"
// instead of every registered attendee.
export function getOnlineUserIds(eventId: EventId): string[] {
  const room = ROOMS.get(eventId);
  if (!room) return [];
  const set = new Set<string>();
  for (const m of room) set.add(m.userId);
  return Array.from(set);
}
