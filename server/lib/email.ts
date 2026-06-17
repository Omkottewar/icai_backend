// Email transport. Uses nodemailer over SMTP — the .env file already has the
// usual SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / EMAIL_FROM slots.
//
// Behaviour when SMTP is not configured:
//   • In development, mail is logged to stdout and treated as "sent". This
//     lets the rest of the pipeline (notification rows, delivery audit) run
//     end-to-end without a real mailbox.
//   • In production, missing SMTP credentials cause sendEmail() to throw, so
//     the delivery row is recorded as failed and the admin can see the gap.
//
// nodemailer is loaded lazily so a missing dependency in dev does not crash
// the import graph at boot.

import "dotenv/config";

let transporterPromise: Promise<any> | null = null;
let transporterDisabled = false;

function smtpConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

async function getTransporter() {
  if (transporterDisabled) return null;
  if (!smtpConfigured()) return null;
  if (transporterPromise) return transporterPromise;

  transporterPromise = (async () => {
    let nodemailer: any;
    try {
      // dynamic import so the module is only required when SMTP is configured.
      nodemailer = await import("nodemailer");
    } catch (err) {
      // nodemailer not installed yet — disable until restart so we don't keep
      // re-throwing on every send.
      transporterDisabled = true;
      // eslint-disable-next-line no-console
      console.warn("[email] nodemailer not installed; emails will be logged only");
      return null;
    }
    const t = nodemailer.default.createTransport({
      host:   process.env.SMTP_HOST,
      port:   Number(process.env.SMTP_PORT ?? 587),
      secure: Number(process.env.SMTP_PORT ?? 587) === 465,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
    return t;
  })();

  return transporterPromise;
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

/**
 * Send a single transactional email.
 *
 * Returns a structured result instead of throwing — the caller (notify())
 * records this on the delivery audit row regardless of outcome.
 */
// Hard blocklist — recipients matching ANY of these domain suffixes are
// rejected before nodemailer ever sees them, regardless of NODE_ENV. This
// is belt-and-braces protection against accidentally emailing the real
// ICAI organisation while developing or after a config flip.
//
// To send to one of these in production (after you've audited the
// recipient list), remove the entry or set ALLOW_ICAI_OUTBOUND=1.
//
// Ordered MOST-SPECIFIC first so the audit log shows the closest match
// (e.g. "blocked_domain:nagpur.icai.org" instead of the broader
// "icai.org") — easier triage when reading the deliveries table.
const BLOCKED_DOMAINS = [
  "nagpur.icai.org",
  "wirc-icai.org",
  "icai.org",
  "icai.in",
];

function isBlockedRecipient(addr: string): string | null {
  if (process.env.ALLOW_ICAI_OUTBOUND === "1") return null;
  // Extract the bare email from "Name <email@host>" or plain "email@host".
  const m = addr.match(/<([^>]+)>|([^\s<>]+@[^\s<>]+)/);
  const email = (m?.[1] ?? m?.[2] ?? addr).toLowerCase().trim();
  const host = email.split("@")[1];
  if (!host) return null;
  for (const blocked of BLOCKED_DOMAINS) {
    if (host === blocked || host.endsWith("." + blocked)) return blocked;
  }
  return null;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const from = process.env.EMAIL_FROM || "ICAI Nagpur <no-reply@nagpur.icai.org>";

  // Safety net — runs before transport setup so even a totally misconfigured
  // SMTP path can't slip through. Logs loudly so the admin log makes it
  // obvious why a delivery was refused.
  const blockedDomain = isBlockedRecipient(input.to);
  if (blockedDomain) {
    // eslint-disable-next-line no-console
    console.warn(`[email] BLOCKED outbound to '${input.to}' — domain '${blockedDomain}' is on the safety blocklist. Set ALLOW_ICAI_OUTBOUND=1 to override.`);
    return { status: "skipped", reason: `blocked_domain:${blockedDomain}` };
  }

  const transporter = await getTransporter();
  if (!transporter) {
    if (process.env.NODE_ENV === "production") {
      return { status: "failed", error: "smtp_not_configured" };
    }
    // dev fallback — log and pretend it sent
    // eslint-disable-next-line no-console
    console.log(`[email:dev] from=${from} to=${input.to}\n  subject=${input.subject}\n  body=${input.body.slice(0, 200)}${input.body.length > 200 ? "…" : ""}`);
    return { status: "skipped", reason: "smtp_not_configured_dev" };
  }

  // Dev safety net — when DEV_EMAIL_OVERRIDE is set (and we're not in
  // production), redirect every outbound email to that single inbox. Keeps
  // test grievances, registrations, escalations, etc. from accidentally
  // hitting real branch addresses while wiring SMTP up. The original
  // recipient is prepended to the subject so the override inbox can still
  // tell who *would have* received each mail.
  const override = process.env.DEV_EMAIL_OVERRIDE;
  const finalTo      = override && process.env.NODE_ENV !== "production" ? override : input.to;
  const finalSubject = override && process.env.NODE_ENV !== "production"
    ? `[→ ${input.to}] ${input.subject}`
    : input.subject;

  try {
    const info = await transporter.sendMail({
      from,
      to:      finalTo,
      subject: finalSubject,
      text:    input.body,
      html:    input.html,
    });
    return { status: "sent", messageId: info?.messageId };
  } catch (err) {
    return {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
