// Web Push helper.
//
// Lazy-initialises the `web-push` library against the VAPID keypair in the
// environment, exposes the public key for the frontend bootstrap, and
// provides a single sendPush() entrypoint that callers (notify.ts) use to
// fan a payload out to one subscription.
//
// Stale-subscription handling lives here too: when the push service returns
// 404 or 410, the subscription row is hard-deleted so notify.ts never tries
// it again. Other errors are surfaced to the caller for the delivery audit.

import webpush from "web-push";
import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { pushSubscriptions } from "../../schema/index.js";

let configured: { ok: true } | { ok: false; reason: string } | null = null;

/**
 * Read VAPID env once and call web-push.setVapidDetails. Subsequent calls
 * are no-ops. Returns the configuration verdict so callers can fail fast
 * with a useful error instead of "TypeError: VAPID public key is not a..."
 */
function ensureConfigured(): { ok: true } | { ok: false; reason: string } {
  if (configured) return configured;

  const pub  = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  const subj = process.env.VAPID_SUBJECT;

  if (!pub || !priv) {
    configured = { ok: false, reason: "VAPID keys not configured" };
    return configured;
  }
  if (!subj || !(subj.startsWith("mailto:") || subj.startsWith("https://"))) {
    configured = { ok: false, reason: "VAPID_SUBJECT must be mailto: or https:" };
    return configured;
  }

  try {
    webpush.setVapidDetails(subj, pub, priv);
    configured = { ok: true };
  } catch (err) {
    configured = { ok: false, reason: (err as Error).message };
  }
  return configured;
}

export function getVapidPublicKey(): string | null {
  ensureConfigured();
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

export function isWebPushConfigured(): boolean {
  return ensureConfigured().ok === true;
}

export type PushPayload = {
  title: string;
  body?: string;
  url?: string;          // where to navigate on click
  tag?: string;          // collapse / replace identifier
  icon?: string;
  badge?: string;
  data?: Record<string, unknown>;
};

export type PushSendResult =
  | { status: "sent" }
  | { status: "skipped"; reason: string }
  | { status: "failed";  error: string };

/**
 * Send one push to one subscription. Prunes the row on 404/410 (the standard
 * "subscription is dead" signal from push services). Never throws — returns
 * a result the audit row can record verbatim.
 */
export async function sendPush(
  sub: { id: string; endpoint: string; p256dh: string; auth: string },
  payload: PushPayload,
): Promise<PushSendResult> {
  const cfg = ensureConfigured();
  if (!cfg.ok) return { status: "skipped", reason: cfg.reason };

  const pushSubscription = {
    endpoint: sub.endpoint,
    keys: { p256dh: sub.p256dh, auth: sub.auth },
  };

  try {
    await webpush.sendNotification(pushSubscription, JSON.stringify(payload), {
      TTL: 60 * 60 * 24, // 24h — past this the push service drops it
    });
    return { status: "sent" };
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    // 404 = endpoint never existed; 410 = unsubscribed/expired. Either way the
    // row is dead — drop it so we don't keep paying for failed sends.
    if (status === 404 || status === 410) {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
      return { status: "skipped", reason: "subscription_expired" };
    }
    return { status: "failed", error: (err as Error).message };
  }
}
