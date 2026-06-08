import { Router } from "express";
import { asc, eq } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { notificationTemplates } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { notify } from "../../lib/notify.js";

export const notificationTemplatesAdminRouter = Router();

const ALLOWED_CHANNELS = new Set(["inapp", "email", "sms", "whatsapp"]);

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
