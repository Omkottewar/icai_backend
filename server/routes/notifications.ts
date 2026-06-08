import { Router } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { notifications } from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";

export const notificationsRouter = Router();

// All endpoints require an authenticated user.
notificationsRouter.use(requireUser);

// ─── GET /api/notifications ───────────────────────────────────────────────
// Inbox listing for the bell dropdown / dashboard. Newest first, capped at
// the 50 most recent rows. Cursor pagination can be added later if needed.
notificationsRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50), 1), 100);
    const rows = await db
      .select({
        id:           notifications.id,
        template_key: notifications.template_key,
        title:        notifications.title,
        body:         notifications.body,
        link_url:     notifications.link_url,
        read_at:      notifications.read_at,
        created_at:   notifications.created_at,
      })
      .from(notifications)
      .where(eq(notifications.user_id, req.user!.id))
      .orderBy(desc(notifications.created_at))
      .limit(limit);
    res.json({ items: rows });
  } catch (err) { next(err); }
});

// ─── GET /api/notifications/unread-count ──────────────────────────────────
// Drives the bell badge. Backed by the partial index on (user_id) WHERE
// read_at IS NULL, so this is effectively a constant-time lookup.
notificationsRouter.get("/unread-count", async (req: AuthedRequest, res, next) => {
  try {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(notifications)
      .where(and(
        eq(notifications.user_id, req.user!.id),
        isNull(notifications.read_at),
      ));
    res.json({ count });
  } catch (err) { next(err); }
});

// ─── POST /api/notifications/:id/read ─────────────────────────────────────
// Mark a single notification read. Idempotent — re-reading a read row
// returns the existing read_at without overwriting it.
notificationsRouter.post("/:id/read", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Notification ID");
    const [row] = await db
      .update(notifications)
      .set({ read_at: new Date() })
      .where(and(
        eq(notifications.id, id),
        eq(notifications.user_id, req.user!.id),
        isNull(notifications.read_at),
      ))
      .returning();
    if (!row) {
      // Could be already-read OR not-owned. Return ok either way — the bell
      // UI just wants to know "this is no longer unread".
      return res.json({ ok: true, already_read: true });
    }
    res.json({ ok: true, item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/notifications/read-all ─────────────────────────────────────
// Mark every unread notification for the current user read in a single
// UPDATE. Returns the count affected so the badge can be optimistically
// cleared.
notificationsRouter.post("/read-all", async (req: AuthedRequest, res, next) => {
  try {
    const now = new Date();
    const rows = await db
      .update(notifications)
      .set({ read_at: now })
      .where(and(
        eq(notifications.user_id, req.user!.id),
        isNull(notifications.read_at),
      ))
      .returning({ id: notifications.id });
    res.json({ ok: true, count: rows.length });
  } catch (err) { handleApiError(err, res, next); }
});
