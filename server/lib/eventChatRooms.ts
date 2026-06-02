// In-memory room manager for the event chat WebSocket fan-out.
//
// Tracks every live WebSocket grouped by event_id. REST and WS both push
// messages through `broadcast(eventId, payload)` — REST writes hit the DB
// first, then call this so other clients see the new row without polling.
//
// Memory only — surviving a restart is not required: clients reconnect and
// re-fetch the last N messages over REST on reload.

import type { WebSocket } from "ws";

type EventId = string;
type Room = Set<WebSocket>;

const ROOMS = new Map<EventId, Room>();

export function joinRoom(eventId: EventId, ws: WebSocket): void {
  let room = ROOMS.get(eventId);
  if (!room) {
    room = new Set();
    ROOMS.set(eventId, room);
  }
  room.add(ws);
}

export function leaveRoom(eventId: EventId, ws: WebSocket): void {
  const room = ROOMS.get(eventId);
  if (!room) return;
  room.delete(ws);
  if (room.size === 0) ROOMS.delete(eventId);
}

export function broadcast(eventId: EventId, payload: unknown): void {
  const room = ROOMS.get(eventId);
  if (!room) return;
  const text = JSON.stringify(payload);
  for (const ws of room) {
    // OPEN === 1. Skip CONNECTING / CLOSING / CLOSED to avoid throws.
    if (ws.readyState === 1) {
      try { ws.send(text); } catch { /* drop on the floor — the close handler will sweep it */ }
    }
  }
}

export function roomSize(eventId: EventId): number {
  return ROOMS.get(eventId)?.size ?? 0;
}
