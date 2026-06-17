import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { pushSubscriptions, users } from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { getVapidPublicKey, isWebPushConfigured, sendPush } from "../lib/webpush.js";

export const pushRouter = Router();

// ─── GET /api/push/public-key ────────────────────────────────────────────
// Anonymous — the frontend needs this before it can call PushManager.subscribe.
// The public VAPID key is, by definition, not a secret.
pushRouter.get("/public-key", (_req, res) => {
  const key = getVapidPublicKey();
  if (!key) return res.status(503).json({ error: "push_not_configured" });
  res.json({ key });
});

// Everything below requires an authenticated user.
pushRouter.use(requireUser);

// ─── POST /api/push/subscribe ────────────────────────────────────────────
// Body: { endpoint, keys: { p256dh, auth } }   — the PushSubscription JSON
// the browser handed the frontend. UPSERT on the endpoint URL so re-subscribe
// from the same device refreshes last_seen_at instead of duplicating.
pushRouter.post("/subscribe", async (req: AuthedRequest, res, next) => {
  try {
    if (!isWebPushConfigured()) throw new ApiError(503, "push_not_configured");

    const endpoint = need(trim(req.body?.endpoint), "endpoint");
    const p256dh   = need(trim(req.body?.keys?.p256dh), "keys.p256dh");
    const auth     = need(trim(req.body?.keys?.auth),   "keys.auth");
    const userAgent = typeof req.headers["user-agent"] === "string"
      ? req.headers["user-agent"].slice(0, 500)
      : null;

    const [row] = await db
      .insert(pushSubscriptions)
      .values({
        user_id:    req.user!.id,
        endpoint,
        p256dh,
        auth,
        user_agent: userAgent,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          // If the same endpoint is re-claimed by another user (rare — e.g.
          // shared device), reassign it. last_seen_at moves forward so we
          // can prune long-idle subs later if needed.
          user_id:      req.user!.id,
          p256dh,
          auth,
          user_agent:   userAgent,
          last_seen_at: new Date(),
        },
      })
      .returning({ id: pushSubscriptions.id });

    // Flip the per-user push preference on if they're opting back in.
    // It's the user.notify_push column that gates whether notify.ts even
    // looks up subscriptions, so toggling it here keeps the two in sync.
    await db.update(users)
      .set({ notify_push: true })
      .where(eq(users.id, req.user!.id));

    res.json({ ok: true, id: row.id });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/push/unsubscribe ──────────────────────────────────────────
// Body: { endpoint }
// Deletes just this device's subscription. The user.notify_push flag is
// flipped off only when no subscriptions remain for the user — otherwise
// other devices would stop receiving pushes too.
pushRouter.post("/unsubscribe", async (req: AuthedRequest, res, next) => {
  try {
    const endpoint = need(trim(req.body?.endpoint), "endpoint");

    await db.delete(pushSubscriptions).where(and(
      eq(pushSubscriptions.user_id, req.user!.id),
      eq(pushSubscriptions.endpoint, endpoint),
    ));

    const remaining = await db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.user_id, req.user!.id))
      .limit(1);

    if (remaining.length === 0) {
      await db.update(users)
        .set({ notify_push: false })
        .where(eq(users.id, req.user!.id));
    }

    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/push/test ─────────────────────────────────────────────────
// Send an immediate test push to every device this user has subscribed.
// Bypasses notify.ts and notification_deliveries — this is purely a debug
// ping so the user (or a support admin) can confirm "yes, push reaches my
// phone right now". The payload mirrors what notify() would normally send
// so the SW renders it identically.
//
// Returns per-device { ok, error? } so the diagnostics UI can show which
// device received it (or why each failed).
pushRouter.post("/test", async (req: AuthedRequest, res, next) => {
  try {
    if (!isWebPushConfigured()) throw new ApiError(503, "push_not_configured");

    const subs = await db
      .select({
        id:         pushSubscriptions.id,
        endpoint:   pushSubscriptions.endpoint,
        p256dh:     pushSubscriptions.p256dh,
        auth:       pushSubscriptions.auth,
        user_agent: pushSubscriptions.user_agent,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.user_id, req.user!.id));

    if (subs.length === 0) {
      throw new ApiError(400, "No subscriptions registered for this user. Click 'Enable' on a device first, then try again.");
    }

    // Send to every device in parallel — most users have one, a few have two.
    const results = await Promise.all(subs.map(async (s) => {
      const r = await sendPush(
        { id: s.id, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth },
        {
          title: "Test notification — ICAI Nagpur",
          body:  "If you can read this, push notifications are working on this device. 🎉",
          url:   "/dashboard",
          tag:   "push_test",
          icon:  "/pwa-192.png",
          // Monochrome silhouette for Android's small-icon slot. Without
          // this the OS falls back to the coloured icon and renders it
          // as a black square. SW already defaults this for notify()
          // dispatches; the test push sets it explicitly so the test
          // appearance matches a real production push exactly.
          badge: "/notification-badge.png",
          data:  { test: true },
        },
      );
      // Truncate the user_agent so the response stays small.
      const ua = s.user_agent ? s.user_agent.slice(0, 120) : null;
      return { device: ua, ...r };
    }));

    const anySent = results.some((r) => r.status === "sent");
    res.json({
      ok:      anySent,
      sent_to: results.filter((r) => r.status === "sent").length,
      total:   results.length,
      results,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/push/status ────────────────────────────────────────────────
// One-stop diagnostic for the settings card. Tells the frontend everything
// it needs to render a "🟢 Push working" or "🔴 X is wrong" panel without
// chaining 3 separate calls.
pushRouter.get("/status", async (req: AuthedRequest, res, next) => {
  try {
    const subs = await db
      .select({
        id:           pushSubscriptions.id,
        user_agent:   pushSubscriptions.user_agent,
        created_at:   pushSubscriptions.created_at,
        last_seen_at: pushSubscriptions.last_seen_at,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.user_id, req.user!.id));

    const [userRow] = await db
      .select({ notify_push: users.notify_push })
      .from(users)
      .where(eq(users.id, req.user!.id))
      .limit(1);

    res.json({
      server_configured: isWebPushConfigured(),
      user_opted_in:     userRow?.notify_push ?? false,
      subscription_count: subs.length,
      subscriptions:      subs,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/push/subscriptions ─────────────────────────────────────────
// List this user's active subscriptions (for a "devices receiving pushes"
// section in the settings UI). Endpoint URL is omitted — only the device
// label and last_seen_at are useful client-side.
pushRouter.get("/subscriptions", async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db
      .select({
        id:           pushSubscriptions.id,
        user_agent:   pushSubscriptions.user_agent,
        created_at:   pushSubscriptions.created_at,
        last_seen_at: pushSubscriptions.last_seen_at,
      })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.user_id, req.user!.id));
    res.json({ items: rows });
  } catch (err) { next(err); }
});
