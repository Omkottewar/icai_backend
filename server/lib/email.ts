// Email transport. Uses the Resend HTTP API (https://resend.com).
// The verified sending domain for this tenant is icainagpur.in — set in the
// Resend dashboard alongside the SPF/DKIM/DMARC DNS records on Hostinger.
//
// Behaviour when RESEND_API_KEY is not configured:
//   • In development, mail is logged to stdout and treated as "skipped". This
//     lets the rest of the pipeline (notification rows, delivery audit) run
//     end-to-end without a real API key.
//   • In production, missing credentials cause sendEmail() to return a
//     "failed" result, so the delivery row is recorded as failed and the
//     admin can see the gap.
//
// The Resend SDK is loaded lazily so a missing dependency in dev does not
// crash the import graph at boot.

import "dotenv/config";

let clientPromise: Promise<any> | null = null;
let clientDisabled = false;

function resendConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

async function getClient() {
  if (clientDisabled) return null;
  if (!resendConfigured()) return null;
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    let Resend: any;
    try {
      const mod = await import("resend");
      Resend = mod.Resend;
    } catch (err) {
      clientDisabled = true;
      // eslint-disable-next-line no-console
      console.warn("[email] resend SDK not installed; emails will be logged only");
      return null;
    }
    return new Resend(process.env.RESEND_API_KEY);
  })();

  return clientPromise;
}

export type SendEmailInput = {
  to: string;
  subject: string;
  body: string;          // plain-text body
  html?: string;          // optional HTML body
};

export type SendEmailResult =
  | { status: "sent"; messageId?: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

// Hard blocklist — recipients matching ANY of these domain suffixes are
// rejected before Resend ever sees them, regardless of NODE_ENV. Belt-and-
// braces protection against accidentally emailing the real ICAI organisation
// while developing or after a config flip.
//
// To send to one of these in production (after auditing the recipient list),
// remove the entry or set ALLOW_ICAI_OUTBOUND=1.
//
// Ordered MOST-SPECIFIC first so the audit log shows the closest match
// (e.g. "blocked_domain:nagpur.icai.org" instead of the broader "icai.org").
const BLOCKED_DOMAINS = [
  "nagpur.icai.org",
  "wirc-icai.org",
  "icai.org",
  "icai.in",
];

function isBlockedRecipient(addr: string): string | null {
  if (process.env.ALLOW_ICAI_OUTBOUND === "1") return null;
  const m = addr.match(/<([^>]+)>|([^\s<>]+@[^\s<>]+)/);
  const email = (m?.[1] ?? m?.[2] ?? addr).toLowerCase().trim();
  const host = email.split("@")[1];
  if (!host) return null;
  for (const blocked of BLOCKED_DOMAINS) {
    if (host === blocked || host.endsWith("." + blocked)) return blocked;
  }
  return null;
}

/**
 * Send a single transactional email.
 *
 * Returns a structured result instead of throwing — the caller (notify())
 * records this on the delivery audit row regardless of outcome.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const from = process.env.EMAIL_FROM || "ICAI Nagpur <no-reply@icainagpur.in>";

  // Safety net — runs before client setup so even a totally misconfigured
  // path can't slip through. Logs loudly so the admin log makes it obvious
  // why a delivery was refused.
  const blockedDomain = isBlockedRecipient(input.to);
  if (blockedDomain) {
    // eslint-disable-next-line no-console
    console.warn(`[email] BLOCKED outbound to '${input.to}' — domain '${blockedDomain}' is on the safety blocklist. Set ALLOW_ICAI_OUTBOUND=1 to override.`);
    return { status: "skipped", reason: `blocked_domain:${blockedDomain}` };
  }

  const client = await getClient();
  if (!client) {
    if (process.env.NODE_ENV === "production") {
      return { status: "failed", error: "resend_not_configured" };
    }
    // dev fallback — log and pretend it sent
    // eslint-disable-next-line no-console
    console.log(`[email:dev] from=${from} to=${input.to}\n  subject=${input.subject}\n  body=${input.body.slice(0, 200)}${input.body.length > 200 ? "…" : ""}`);
    return { status: "skipped", reason: "resend_not_configured_dev" };
  }

  // Dev safety net — when DEV_EMAIL_OVERRIDE is set (and we're not in
  // production), redirect every outbound email to that single inbox. Keeps
  // test grievances, registrations, escalations, etc. from accidentally
  // hitting real branch addresses while wiring up. The original recipient
  // is prepended to the subject so the override inbox can still tell who
  // *would have* received each mail.
  const override = process.env.DEV_EMAIL_OVERRIDE;
  const finalTo      = override && process.env.NODE_ENV !== "production" ? override : input.to;
  const finalSubject = override && process.env.NODE_ENV !== "production"
    ? `[→ ${input.to}] ${input.subject}`
    : input.subject;

  try {
    const { data, error } = await client.emails.send({
      from,
      to:      finalTo,
      subject: finalSubject,
      text:    input.body,
      html:    input.html,
    });
    if (error) {
      return {
        status: "failed",
        error: typeof error === "string" ? error : (error.message || JSON.stringify(error)),
      };
    }
    return { status: "sent", messageId: data?.id };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
