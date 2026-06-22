// WebSocket upgrade handler for the event chat.
//
//   ws://host/ws/events/:eventId/chat
//
// Auth: the existing JWT cookie is forwarded with the upgrade request — we
// parse it on `upgrade` and resolve the user against the DB before letting
// the socket complete. Unauthenticated upgrades get 401; unregistered users
// get 403.
//
// The socket itself is intentionally minimal: clients don't post messages
// over WS (they POST to the REST endpoint, which then broadcasts). We do
// accept `ping` frames from the client (every ~25s) so intermediaries don't
// idle the connection out.

import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import cookie from "cookie-parser"; // for the SESSION_COOKIE constant
import { SESSION_COOKIE, getUserBySessionToken } from "../auth/jwt.js";
import { db } from "../../db/client.js";
import { events, eventRegistrations } from "../../schema/index.js";
import { and, eq, isNull } from "drizzle-orm";
import { joinRoom, leaveRoom, roomSize, broadcast } from "./eventChatRooms.js";

void cookie; // silence the unused warning — kept for future signed-cookie support

const WS_PATH_REGEX = /^\/ws\/events\/([0-9a-f-]{36})\/chat$/i;

// Quick cookie parser — the ws upgrade gives us a raw header string. The
// `cookie` package isn't strictly needed for a single named cookie.
function parseSessionCookie(rawHeader: string | undefined): string | null {
  if (!rawHeader) return null;
  for (const piece of rawHeader.split(";")) {
    const [name, ...rest] = piece.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export function attachEventChatSocket(server: HttpServer): void {
  // noServer: true means *we* own the upgrade handshake — needed so we can
  // run auth + reject before completing it.
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req, socket, head) => {
    const url = req.url || "";
    const match = WS_PATH_REGEX.exec(url);
    if (!match) return; // not for us — let other upgrade listeners (or none) handle it
    const eventId = match[1];

    try {
      // ── Auth ──────────────────────────────────────────────────────────
      const token = parseSessionCookie(req.headers.cookie);
      if (!token) return rejectUpgrade(socket, 401, "unauthenticated");

      const user = await getUserBySessionToken(token);
      if (!user) return rejectUpgrade(socket, 401, "unauthenticated");

      // ── Event exists ──────────────────────────────────────────────────
      const [event] = await db
        .select({ id: events.id })
        .from(events)
        .where(and(eq(events.id, eventId), isNull(events.deleted_at)))
        .limit(1);
      if (!event) return rejectUpgrade(socket, 404, "event_not_found");

      // ── Registration gate ─────────────────────────────────────────────
      const [reg] = await db
        .select({ id: eventRegistrations.id })
        .from(eventRegistrations)
        .where(and(
          eq(eventRegistrations.event_id, eventId),
          eq(eventRegistrations.user_id, user.id),
          isNull(eventRegistrations.deleted_at),
        ))
        .limit(1);
      if (!reg) return rejectUpgrade(socket, 403, "not_registered");

      // ── Complete the WS handshake ─────────────────────────────────────
      wss.handleUpgrade(req as IncomingMessage, socket as Duplex, head, (ws) => {
        onSocketOpen(ws as WebSocket, eventId, user.id);
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[ws upgrade error]", err);
      rejectUpgrade(socket, 500, "internal_error");
    }
  });
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  // Send a complete, well-formed HTTP rejection so the proxy in the middle
  // (vite dev server) sees a normal end-of-response instead of an abrupt
  // socket teardown — that was logging `write ECONNABORTED` on every reject.
  // `Connection: close` tells the client (and any proxy) we're done. We let
  // the kernel flush via `end()` rather than `destroy()` for the same reason.
  const body = `${status} ${reason}`;
  const head =
    `HTTP/1.1 ${status} ${reason}\r\n` +
    `Connection: close\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n` +
    `\r\n`;
  try {
    socket.end(head + body);
  } catch {
    // If even end() throws (socket already closed by peer), fall back to destroy.
    try { socket.destroy(); } catch { /* ignore */ }
  }
}

function onSocketOpen(ws: WebSocket, eventId: string, userId: string): void {
  joinRoom(eventId, ws, userId);

  // Welcome frame so the client UI can show presence without an extra REST call.
  try {
    ws.send(JSON.stringify({
      type: "hello",
      event_id: eventId,
      online_count: roomSize(eventId),
    }));
  } catch { /* ignore */ }

  // Tell the room someone new arrived — useful for the "X online" pill.
  broadcast(eventId, {
    type: "presence",
    event_id: eventId,
    online_count: roomSize(eventId),
  });

  // Heartbeat: a 25s ping from the server pongs the connection alive across
  // proxies that idle long-lived sockets. ws auto-handles pong frames.
  const heartbeat = setInterval(() => {
    if (ws.readyState === 1) {
      try { ws.ping(); } catch { /* swallow — close handler will sweep */ }
    } else {
      clearInterval(heartbeat);
    }
  }, 25_000);

  ws.on("message", (raw) => {
    // Clients send three things over WS:
    //   1. {type:"ping"} — keepalive blips; we acknowledge implicitly
    //      by not closing the socket.
    //   2. {type:"typing", channel_id} — typing indicator. Relay to the
    //      room so others can render a "X is typing…" hint. We DON'T
    //      validate channel membership for typing — the registration
    //      gate already covers it and typing is harmless if mistargeted.
    //   3. Anything else — silently dropped so a misbehaving client
    //      can't crash the server.
    try {
      const text = typeof raw === "string" ? raw : raw.toString("utf8");
      if (text.length > 512) return;          // typing payloads are tiny
      const frame = JSON.parse(text);
      if (frame?.type === "typing" && typeof frame.channel_id === "string") {
        broadcast(eventId, {
          type: "typing",
          channel_id: frame.channel_id,
          user_id: userId,
          at: Date.now(),
        });
      }
    } catch {
      /* unparseable — ignore */
    }
  });

  ws.on("close", () => {
    clearInterval(heartbeat);
    leaveRoom(eventId, ws);
    broadcast(eventId, {
      type: "presence",
      event_id: eventId,
      online_count: roomSize(eventId),
    });
  });

  ws.on("error", () => {
    clearInterval(heartbeat);
    leaveRoom(eventId, ws);
  });
}
