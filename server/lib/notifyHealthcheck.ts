// Boot-time sanity check for the notification system.
//
// Why: the #1 cause of "I'm not getting notifications" was a code path
// referencing a template_key that didn't exist in the DB. notify() would
// silently return null and the user would have no way of knowing why
// nothing fired. This module hardcodes the list of keys the codebase
// references and pings the DB at startup to confirm each one exists +
// is enabled. Mismatches go to console.warn — loud but non-fatal so a
// missing template never blocks the server from booting.

import { inArray } from "drizzle-orm";
import { db } from "../../db/client.js";
import { notificationTemplates } from "../../schema/index.js";

// Every template_key the backend code dispatches through notify() /
// notifyAsync(). Keep this list in sync when you add a new dispatch call.
//
// If you add a new key here without seeding it in the DB, the boot log
// will tell you exactly what's missing — much better than discovering
// silent drops in production.
export const REFERENCED_TEMPLATE_KEYS = [
  "event_registered",
  "checklist_pending_approval",
  "task_assigned",
  "checklist_assigned",
  "checklist_submitted",
  "checklist_approved",
  "checklist_rejected",
] as const;

export async function runNotificationHealthcheck(): Promise<void> {
  try {
    const rows = await db
      .select({ key: notificationTemplates.key, enabled: notificationTemplates.enabled })
      .from(notificationTemplates)
      .where(inArray(notificationTemplates.key, REFERENCED_TEMPLATE_KEYS as unknown as string[]));

    const found = new Map(rows.map((r) => [r.key, r.enabled]));
    const missing: string[] = [];
    const disabled: string[] = [];

    for (const key of REFERENCED_TEMPLATE_KEYS) {
      if (!found.has(key)) {
        missing.push(key);
      } else if (!found.get(key)) {
        disabled.push(key);
      }
    }

    // Email (Resend) readiness — log clearly at boot whether emails will
    // fly or be silently swallowed. The codebase uses Resend's HTTP API
    // (lib/email.ts), not SMTP.
    const resendReady = !!process.env.RESEND_API_KEY;
    const isProd = process.env.NODE_ENV === "production";

    // eslint-disable-next-line no-console
    console.log("─".repeat(60));
    // eslint-disable-next-line no-console
    console.log("[notify] startup health check:");
    // eslint-disable-next-line no-console
    console.log(`  • templates referenced in code: ${REFERENCED_TEMPLATE_KEYS.length}`);
    // eslint-disable-next-line no-console
    console.log(`  • templates found + enabled:    ${REFERENCED_TEMPLATE_KEYS.length - missing.length - disabled.length}`);
    if (missing.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`  ⚠ MISSING from DB: ${missing.join(", ")} — these dispatches will be silently dropped.`);
    }
    if (disabled.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`  ⚠ DISABLED in DB: ${disabled.join(", ")} — these dispatches will be silently dropped.`);
    }
    if (!resendReady) {
      // eslint-disable-next-line no-console
      console.warn(
        `  ⚠ RESEND_API_KEY not set — ` +
        (isProd
          ? "emails will FAIL in production. Set RESEND_API_KEY now."
          : "emails will be logged to stdout only in dev. Set RESEND_API_KEY to actually send.")
      );
    } else {
      // eslint-disable-next-line no-console
      console.log(`  ✓ Resend configured.`);
    }
    const vapidReady = !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT);
    if (!vapidReady) {
      // eslint-disable-next-line no-console
      console.warn(`  ⚠ VAPID keys missing (VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY/VAPID_SUBJECT) — web push will be skipped.`);
    } else {
      // eslint-disable-next-line no-console
      console.log(`  ✓ VAPID keys configured.`);
    }
    // eslint-disable-next-line no-console
    console.log("─".repeat(60));
  } catch (err) {
    // Don't block boot on a DB hiccup — log loudly and move on.
    // eslint-disable-next-line no-console
    console.error("[notify] startup health check failed:", err);
  }
}
