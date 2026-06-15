// Notification dispatcher.
//
// One entry point — notify({ user_id, template_key, vars, link_url }) — does
// everything:
//   1. Look up the template.
//   2. Interpolate {{vars}} into title / body / subject.
//   3. Insert a row in `notifications` (the in-app inbox).
//   4. For every enabled channel on the template, write a `notification_deliveries`
//      row and attempt the channel send.
//
// Failures are recorded on the delivery row but do NOT throw — the caller's
// business action (e.g. event registration) must not roll back just because
// SMTP is down.

import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  notifications,
  notificationTemplates,
  notificationDeliveries,
  pushSubscriptions,
  users,
} from "../../schema/index.js";
import { sendEmail } from "./email.js";
import { sendPush } from "./webpush.js";

export type NotifyInput = {
  user_id: string;
  template_key: string;
  vars?: Record<string, string | number | null | undefined>;
  link_url?: string;
  /** Overrides the user's contact preference for this single send (e.g. password reset). */
  force_email?: boolean;
};

export type NotifyResult = {
  notification_id: string;
  deliveries: Array<{ channel: string; status: string; error?: string }>;
};

/** Replace {{var}} placeholders. Unknown vars render as empty string. */
function render(template: string | null | undefined, vars: Record<string, string | number | null | undefined>): string {
  if (!template) return "";
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

/**
 * Fire a notification. Never throws — returns the dispatch summary so callers
 * can log / audit. The notification row is always written; channel sends are
 * best-effort.
 */
export async function notify(input: NotifyInput): Promise<NotifyResult | null> {
  const vars = input.vars ?? {};

  // Step 1 — fetch the template + the recipient in parallel.
  const [tmplRow, userRow] = await Promise.all([
    db.select().from(notificationTemplates).where(eq(notificationTemplates.key, input.template_key)).limit(1),
    db.select({
      id: users.id,
      name: users.name,
      email: users.email,
      phone: users.phone,
      notify_email: users.notify_email,
      notify_push: users.notify_push,
    }).from(users).where(eq(users.id, input.user_id)).limit(1),
  ]);

  const tmpl = tmplRow[0];
  const user = userRow[0];
  if (!tmpl || !tmpl.enabled || !user) return null;

  // Conventional helper variables every template can use without the caller
  // having to pass them. Caller-supplied `vars` win on conflict.
  const enrichedVars = {
    first_name: (user.name ?? "").split(/\s+/)[0] || user.name || "there",
    user_name:  user.name,
    user_email: user.email,
    ...vars,
  };

  const title = render(tmpl.inapp_title ?? tmpl.email_subject ?? tmpl.name, enrichedVars);
  const body  = render(tmpl.inapp_body  ?? tmpl.email_body, enrichedVars);

  // Step 2 — write the in-app row first. We do this even if the template's
  // channel list omits 'inapp', so admins can still audit what fired from
  // the user's inbox view. (Toggle this if it's noisy in practice.)
  const [notif] = await db.insert(notifications).values({
    user_id:      input.user_id,
    template_key: input.template_key,
    title,
    body,
    link_url:     input.link_url ?? null,
    metadata:     enrichedVars as object,
  }).returning();

  const channels = tmpl.channels ?? [];
  const deliveries: NotifyResult["deliveries"] = [];

  // Step 3 — fan out to each channel. Today only email is wired; sms /
  // whatsapp are listed in the template column for the future, but skipped
  // here with an explicit 'skipped' row.
  for (const channel of channels) {
    if (channel === "inapp") continue; // already covered by the row above

    if (channel === "email") {
      const wantsEmail = input.force_email || user.notify_email !== false;
      if (!wantsEmail) {
        await db.insert(notificationDeliveries).values({
          notification_id: notif.id,
          channel:         "email",
          recipient:       user.email,
          status:          "skipped",
          error:           "user_opted_out",
        });
        deliveries.push({ channel, status: "skipped", error: "user_opted_out" });
        continue;
      }
      if (!user.email) {
        await db.insert(notificationDeliveries).values({
          notification_id: notif.id,
          channel:         "email",
          recipient:       "",
          status:          "skipped",
          error:           "no_recipient",
        });
        deliveries.push({ channel, status: "skipped", error: "no_recipient" });
        continue;
      }

      const subject = render(tmpl.email_subject ?? tmpl.name, enrichedVars);
      const emailBody = render(tmpl.email_body ?? tmpl.inapp_body ?? "", enrichedVars);
      const result = await sendEmail({ to: user.email, subject, body: emailBody });

      await db.insert(notificationDeliveries).values({
        notification_id: notif.id,
        channel:         "email",
        recipient:       user.email,
        status:          result.status === "sent" ? "sent"
                       : result.status === "skipped" ? "skipped"
                       : "failed",
        error:           result.status === "failed" ? result.error
                       : result.status === "skipped" ? result.reason
                       : null,
        sent_at:         result.status === "sent" ? new Date() : null,
      });
      deliveries.push({ channel, status: result.status, error: result.status !== "sent" ? (result as any).error ?? (result as any).reason : undefined });
      continue;
    }

    if (channel === "webpush") {
      // User-level opt-out gate. notify_push defaults to true, so users only
      // miss pushes if they explicitly turned them off in settings.
      if (user.notify_push === false) {
        await db.insert(notificationDeliveries).values({
          notification_id: notif.id,
          channel:         "webpush",
          recipient:       "",
          status:          "skipped",
          error:           "user_opted_out",
        });
        deliveries.push({ channel, status: "skipped", error: "user_opted_out" });
        continue;
      }

      const subs = await db
        .select({
          id:       pushSubscriptions.id,
          endpoint: pushSubscriptions.endpoint,
          p256dh:   pushSubscriptions.p256dh,
          auth:     pushSubscriptions.auth,
        })
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.user_id, input.user_id));

      if (subs.length === 0) {
        await db.insert(notificationDeliveries).values({
          notification_id: notif.id,
          channel:         "webpush",
          recipient:       "",
          status:          "skipped",
          error:           "no_subscription",
        });
        deliveries.push({ channel, status: "skipped", error: "no_subscription" });
        continue;
      }

      // Fan out to every device this user has registered. Each device gets
      // its own delivery row so admins can see "delivered to 2 of 3 devices"
      // in the audit trail.
      let anySent = false;
      for (const sub of subs) {
        const result = await sendPush(sub, {
          title,
          body,
          url: input.link_url ?? undefined,
          tag: input.template_key,
          data: { notification_id: notif.id, template_key: input.template_key },
        });
        await db.insert(notificationDeliveries).values({
          notification_id: notif.id,
          channel:         "webpush",
          recipient:       sub.endpoint.slice(0, 200), // truncate for audit
          status:          result.status,
          error:           result.status === "failed" ? result.error
                         : result.status === "skipped" ? result.reason
                         : null,
          sent_at:         result.status === "sent" ? new Date() : null,
        });
        if (result.status === "sent") anySent = true;
      }
      deliveries.push({
        channel,
        status: anySent ? "sent" : "failed",
        error:  anySent ? undefined : "all_devices_failed",
      });
      continue;
    }

    // sms / whatsapp — not yet implemented; record skipped for the audit.
    await db.insert(notificationDeliveries).values({
      notification_id: notif.id,
      channel,
      recipient:       channel === "sms" || channel === "whatsapp" ? (user.phone ?? "") : "",
      status:          "skipped",
      error:           "channel_not_implemented",
    });
    deliveries.push({ channel, status: "skipped", error: "channel_not_implemented" });
  }

  return { notification_id: notif.id, deliveries };
}

/**
 * Fire and forget. Use this when the caller does not want to await the
 * dispatch — e.g. inside an HTTP handler where notification failure must not
 * delay the response. Errors are swallowed and logged.
 */
export function notifyAsync(input: NotifyInput): void {
  notify(input).catch((err) => {
    // eslint-disable-next-line no-console
    console.error("[notify] dispatch failed", { template_key: input.template_key, user_id: input.user_id, err });
  });
}
