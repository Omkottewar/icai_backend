import { Router } from "express";
import { and, asc, desc, eq, gte, ilike, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { notificationTemplates, notificationDeliveries, notifications, users } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { notify } from "../../lib/notify.js";
import { REFERENCED_TEMPLATE_KEYS } from "../../lib/notifyHealthcheck.js";

export const notificationTemplatesAdminRouter = Router();

const ALLOWED_CHANNELS = new Set(["inapp", "email", "sms", "whatsapp", "webpush"]);

// ─── GET /api/admin/notification-templates ────────────────────────────────
notificationTemplatesAdminRouter.get("/", async (_req, res, next) => {
  try {
    const rows = await db
      .select()
      .from(notificationTemplates)
      .orderBy(asc(notificationTemplates.key));
    res.json({ items: rows });
  } catch (err) { next(err); }
});

// ─── PATCH /api/admin/notification-templates/:key ─────────────────────────
// Edit the wording / channels / enabled state of a template. The key itself
// is immutable — call sites reference it by name.
notificationTemplatesAdminRouter.patch("/:key", async (req: AuthedRequest, res, next) => {
  try {
    const key = need(trim(req.params.key), "Template key");

    const channelsRaw = Array.isArray(req.body?.channels) ? req.body.channels : null;
    const channels = channelsRaw
      ? channelsRaw.filter((c: unknown) => typeof c === "string" && ALLOWED_CHANNELS.has(c))
      : undefined;

    if (channelsRaw && channels && channels.length !== channelsRaw.length) {
      throw new ApiError(400, "Unknown channel in channels[]");
    }

    const patch: Record<string, unknown> = {
      updated_by: req.user?.id ?? null,
      updated_at: new Date(),
    };
    if (typeof req.body?.name === "string")        patch.name = trim(req.body.name);
    if (typeof req.body?.description === "string") patch.description = trim(req.body.description) || null;
    if (typeof req.body?.email_subject === "string") patch.email_subject = req.body.email_subject || null;
    if (typeof req.body?.email_body === "string")    patch.email_body = req.body.email_body || null;
    if (typeof req.body?.inapp_title === "string")   patch.inapp_title = req.body.inapp_title || null;
    if (typeof req.body?.inapp_body === "string")    patch.inapp_body = req.body.inapp_body || null;
    if (typeof req.body?.enabled === "boolean")      patch.enabled = req.body.enabled;
    if (channels)                                    patch.channels = channels;

    const [row] = await db.update(notificationTemplates)
      .set(patch as any)
      .where(eq(notificationTemplates.key, key))
      .returning();
    if (!row) throw new ApiError(404, "Template not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/notification-templates/_deliveries ───────────────────
// Recent attempts across all channels. Powers the "Notifications log"
// admin page so triaging "did X get notified about Y?" takes 5 seconds
// instead of a SQL query.
//
// Filters: ?status=sent|failed|skipped|queued, ?channel=email|webpush|inapp|sms|whatsapp,
//          ?template_key=event_registered, ?q=name-or-email substring,
//          ?since=2026-06-17T00:00:00Z (defaults to last 7 days).
// Pagination: ?page=1&pageSize=50 (max 200).
notificationTemplatesAdminRouter.get("/_deliveries", async (req, res, next) => {
  try {
    const status      = trim(req.query.status);
    const channel     = trim(req.query.channel);
    const templateKey = trim(req.query.template_key);
    const q           = trim(req.query.q);
    const sinceRaw    = trim(req.query.since);
    const page        = Math.max(1, Number(req.query.page) || 1);
    const pageSize    = Math.min(200, Math.max(10, Number(req.query.pageSize) || 50));
    const offset      = (page - 1) * pageSize;

    // Default to the last 7 days. Keeping a default ceiling stops the table
    // from accidentally returning every row in the system on a busy install.
    const since = sinceRaw
      ? new Date(sinceRaw)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const conds: any[] = [gte(notificationDeliveries.attempted_at, since)];
    if (status)      conds.push(eq(notificationDeliveries.status, status as any));
    if (channel)     conds.push(eq(notificationDeliveries.channel, channel as any));
    if (templateKey) conds.push(eq(notifications.template_key, templateKey));
    if (q)           conds.push(sql`(${users.name} ILIKE ${`%${q}%`} OR ${users.email} ILIKE ${`%${q}%`})`);

    const rows = await db
      .select({
        id:              notificationDeliveries.id,
        notification_id: notificationDeliveries.notification_id,
        channel:         notificationDeliveries.channel,
        recipient:       notificationDeliveries.recipient,
        status:          notificationDeliveries.status,
        error:           notificationDeliveries.error,
        attempted_at:    notificationDeliveries.attempted_at,
        sent_at:         notificationDeliveries.sent_at,
        template_key:    notifications.template_key,
        title:           notifications.title,
        link_url:        notifications.link_url,
        user_id:         notifications.user_id,
        user_name:       users.name,
        user_email:      users.email,
      })
      .from(notificationDeliveries)
      .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notification_id))
      .innerJoin(users, eq(users.id, notifications.user_id))
      .where(and(...conds))
      .orderBy(desc(notificationDeliveries.attempted_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(notificationDeliveries)
      .innerJoin(notifications, eq(notifications.id, notificationDeliveries.notification_id))
      .innerJoin(users, eq(users.id, notifications.user_id))
      .where(and(...conds));

    // Per-status / per-channel counts over the same time window so the
    // page can render a small status-strip without an extra round trip.
    const summary = await db
      .select({
        status:  notificationDeliveries.status,
        channel: notificationDeliveries.channel,
        n:       sql<number>`count(*)::int`.as("n"),
      })
      .from(notificationDeliveries)
      .where(gte(notificationDeliveries.attempted_at, since))
      .groupBy(notificationDeliveries.status, notificationDeliveries.channel);

    res.json({ rows, total, page, pageSize, summary, since: since.toISOString() });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/notification-templates/_health ───────────────────────
// Cheap healthcheck the admin UI calls to colour the "all good" badge.
// Returns counts of: known template keys missing/disabled, recent failures,
// SMTP/VAPID readiness flags.
notificationTemplatesAdminRouter.get("/_health", async (_req, res, next) => {
  try {
    const tpl = await db
      .select({ key: notificationTemplates.key, enabled: notificationTemplates.enabled })
      .from(notificationTemplates);
    const known = new Map(tpl.map((r) => [r.key, r.enabled]));
    const missing  = REFERENCED_TEMPLATE_KEYS.filter((k) => !known.has(k));
    const disabled = REFERENCED_TEMPLATE_KEYS.filter((k) => known.has(k) && !known.get(k));

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [{ failed24h }] = await db
      .select({ failed24h: sql<number>`count(*)::int`.as("failed24h") })
      .from(notificationDeliveries)
      .where(and(
        gte(notificationDeliveries.attempted_at, since),
        eq(notificationDeliveries.status, "failed"),
      ));

    const smtpConfigured  = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
    const vapidConfigured = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);

    res.json({
      missing_templates:   missing,
      disabled_templates:  disabled,
      failed_24h:          failed24h ?? 0,
      smtp_configured:     smtpConfigured,
      vapid_configured:    vapidConfigured,
      env:                 process.env.NODE_ENV || "development",
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/notification-templates/:key/preview ──────────────────
// Send the template to the currently signed-in admin with a {{vars}} payload,
// so the editor can sanity-check the rendered copy in their own inbox.
notificationTemplatesAdminRouter.post("/:key/preview", async (req: AuthedRequest, res, next) => {
  try {
    const key = need(trim(req.params.key), "Template key");
    const vars = (req.body?.vars && typeof req.body.vars === "object") ? req.body.vars : {};

    const result = await notify({
      user_id:      req.user!.id,
      template_key: key,
      vars,
    });
    if (!result) throw new ApiError(404, "Template not found or disabled");
    res.json({ ok: true, ...result });
  } catch (err) { handleApiError(err, res, next); }
});
