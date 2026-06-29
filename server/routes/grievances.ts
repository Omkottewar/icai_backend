// Public grievance / contact / suggestion endpoints.
//
// Two routes:
//   POST /api/grievances            — file a new grievance (no login required)
//   GET  /api/grievances/track      — look up by ticket_no + email
//
// The admin-facing endpoints live under /api/admin/grievances and are
// gated by requireAdmin; this file is intentionally open access.
//
// Submission flow:
//   1. Validate + sanitise the body.
//   2. Look up the active subject → email routing row.
//   3. Generate a ticket_no (GRV-YYYY-NNNNNN, monotonically increasing).
//   4. Insert the grievance row.
//   5. Fire two emails best-effort: acknowledgement to the submitter and
//      a notification to the routed inbox. Failures are logged but do
//      not roll back the submission — the row is the durable record.
//
// Rate limit: 5 submissions per IP per hour. The form is the kind of
// thing bots love so the limit sits well below human use.

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  grievances,
  grievanceSubjectRoutes,
  notificationTemplates,
} from "../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { sendEmail } from "../lib/email.js";
import { verifyRecaptcha } from "../lib/recaptcha.js";

export const grievancesRouter = Router();

const submissionLimiter = rateLimit({
  standardHeaders: "draft-7",
  legacyHeaders: false,
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: 5,
  message: {
    error: "rate_limited",
    message: "Too many submissions from this IP. Please wait a bit and try again.",
  },
});

const AGAINST_TYPES = ["member", "firm", "branch"] as const;
type AgainstType = (typeof AGAINST_TYPES)[number];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+\d][\d\s\-]{6,18}$/;

/** Render the {{var}} placeholders inside a template body. Unknown vars render empty. */
function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => vars[key] ?? "");
}

/**
 * Generate the next ticket number for the current calendar year.
 * Format: GRV-YYYY-NNNNNN, zero-padded sequence resets each year.
 *
 * Uses a single SQL expression so concurrent submissions can't collide on
 * the same number (the UNIQUE constraint would catch it but this avoids
 * the retry loop in the common path).
 */
async function nextTicketNo(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `GRV-${year}-`;
  const result = await db.execute(sql`
    SELECT LPAD(
      (COALESCE(
        MAX(NULLIF(REGEXP_REPLACE(ticket_no, '^GRV-\d{4}-', ''), '')::int),
        0
      ) + 1)::text,
      6, '0'
    ) AS next
    FROM grievances
    WHERE ticket_no LIKE ${prefix + "%"}
  `);
  const row = Array.from(result as Iterable<{ next: string }>)[0];
  return prefix + (row?.next ?? "000001");
}

// ─── GET /api/grievances/subjects ───────────────────────────────────────────
// Public list of active subject options for the contact form dropdown.
// Cached for a minute — the admin can update routes from the admin UI and
// the form will pick up the new labels on the next page load.
grievancesRouter.get("/subjects", async (_req, res, next) => {
  try {
    const rows = await db
      .select({
        value: grievanceSubjectRoutes.subject,
        label: grievanceSubjectRoutes.label,
      })
      .from(grievanceSubjectRoutes)
      .where(eq(grievanceSubjectRoutes.active, true))
      .orderBy(grievanceSubjectRoutes.subject);
    res.set("cache-control", "public, max-age=60");
    res.json({ items: rows });
  } catch (err) { next(err); }
});

// ─── POST /api/grievances ────────────────────────────────────────────────────
// Public form submission. Returns { ticket_no } on success.
grievancesRouter.post("/", submissionLimiter, async (req, res, next) => {
  try {
    // reCAPTCHA v3 — token is sent in the body as `recaptcha_token`. The
    // verifier silently passes when no secret is configured (dev) and fails
    // closed in production. action="grievance_submit" must match the frontend.
    const captcha = await verifyRecaptcha(
      typeof req.body?.recaptcha_token === "string" ? req.body.recaptcha_token : undefined,
      "grievance_submit",
      (req.ip ?? req.socket.remoteAddress) || undefined,
    );
    if (!captcha.ok) {
      throw new ApiError(400, "Could not verify you are human. Please refresh and try again.");
    }

    const name    = need(trim(req.body?.name),    "Name");
    const email   = need(trim(req.body?.email),   "Email").toLowerCase();
    const subject = need(trim(req.body?.subject), "Subject");
    const message = need(trim(req.body?.message), "Message");

    if (name.length > 200)    throw new ApiError(400, "Name is too long (max 200 chars)");
    if (message.length > 5000) throw new ApiError(400, "Message is too long (max 5000 chars)");
    if (!EMAIL_RE.test(email)) throw new ApiError(400, "Email looks invalid");

    const phone = trim(req.body?.phone) || null;
    if (phone && !PHONE_RE.test(phone)) {
      throw new ApiError(400, "Phone looks invalid");
    }

    const against_type: AgainstType = AGAINST_TYPES.includes(req.body?.against_type)
      ? req.body.against_type
      : "branch";
    const against_ref = trim(req.body?.against_ref) || null;

    // Look up the route. If the subject isn't a known route, fall back to
    // 'other' (which is seeded) — better than rejecting the submission.
    const [route] = await db
      .select()
      .from(grievanceSubjectRoutes)
      .where(and(eq(grievanceSubjectRoutes.subject, subject), eq(grievanceSubjectRoutes.active, true)))
      .limit(1);
    const [fallback] = route ? [] : await db
      .select()
      .from(grievanceSubjectRoutes)
      .where(eq(grievanceSubjectRoutes.subject, "other"))
      .limit(1);
    const targetRoute = route ?? fallback;
    if (!targetRoute) {
      throw new ApiError(500, "Grievance routing is not configured. Contact the admin.");
    }

    const ticket_no = await nextTicketNo();

    const [row] = await db.insert(grievances).values({
      ticket_no,
      name,
      email,
      phone,
      subject: targetRoute.subject,
      against_type,
      against_ref,
      message,
    }).returning({ id: grievances.id, ticket_no: grievances.ticket_no });

    // Fire-and-forget the two notification emails. The submission is already
    // committed; mail failure should not bubble up to the user.
    void dispatchGrievanceEmails({
      ticket_no: row.ticket_no,
      submitterName: name,
      submitterEmail: email,
      submitterPhone: phone,
      subjectLabel: targetRoute.label,
      message,
      againstType: against_type,
      againstRef: against_ref,
      routeEmail: targetRoute.route_email,
    });

    res.json({ ticket_no: row.ticket_no });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/grievances/track?ticket_no=…&email=… ──────────────────────────
// Public status lookup. Ticket + email must both match — keeps the surface
// safe from someone enumerating tickets without knowing the submitter email.
grievancesRouter.get("/track", async (req, res, next) => {
  try {
    const ticket_no = trim(req.query.ticket_no);
    const email     = trim(req.query.email).toLowerCase();
    if (!ticket_no || !email) {
      throw new ApiError(400, "Both ticket_no and email are required");
    }
    const [row] = await db
      .select({
        ticket_no:  grievances.ticket_no,
        subject:    grievances.subject,
        status:     grievances.status,
        created_at: grievances.created_at,
        resolved_at: grievances.resolved_at,
        resolution_note: grievances.resolution_note,
      })
      .from(grievances)
      .where(and(eq(grievances.ticket_no, ticket_no), eq(grievances.email, email)))
      .limit(1);
    if (!row) throw new ApiError(404, "No grievance matches that ticket + email");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── helpers ─────────────────────────────────────────────────────────────────

type DispatchInput = {
  ticket_no: string;
  submitterName: string;
  submitterEmail: string;
  submitterPhone: string | null;
  subjectLabel: string;
  message: string;
  againstType: AgainstType;
  againstRef: string | null;
  routeEmail: string;
};

async function dispatchGrievanceEmails(input: DispatchInput): Promise<void> {
  const appUrl = process.env.APP_URL ?? "";
  const statusLink = `${appUrl}/track-grievance?ticket_no=${encodeURIComponent(input.ticket_no)}&email=${encodeURIComponent(input.submitterEmail)}`;
  const firstName = input.submitterName.split(/\s+/)[0] || input.submitterName;

  // 1. Acknowledgement to the submitter — uses the existing grievance_ack
  //    template so the wording stays editable from the admin console.
  try {
    const [tmpl] = await db
      .select()
      .from(notificationTemplates)
      .where(eq(notificationTemplates.key, "grievance_ack"))
      .limit(1);
    if (tmpl && tmpl.enabled) {
      const vars = {
        first_name: firstName,
        ticket_no: input.ticket_no,
        status_link: statusLink,
      };
      const subject = render(tmpl.email_subject ?? "Grievance received", vars);
      const body    = render(tmpl.email_body ?? "Thank you, your grievance has been logged.", vars);
      await sendEmail({ to: input.submitterEmail, subject, body });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[grievances] ack mail failed", { ticket_no: input.ticket_no, err });
  }

  // 2. Notification to the routed admin inbox. Plain-text, no template —
  //    this email is operational, not user-facing.
  try {
    const adminSubject = `[${input.ticket_no}] New ${input.subjectLabel} grievance from ${input.submitterName}`;
    const adminBody = [
      `Ticket: ${input.ticket_no}`,
      `Subject: ${input.subjectLabel}`,
      `Against: ${input.againstType}${input.againstRef ? ` (${input.againstRef})` : ""}`,
      ``,
      `From: ${input.submitterName} <${input.submitterEmail}>`,
      input.submitterPhone ? `Phone: ${input.submitterPhone}` : null,
      ``,
      `Message:`,
      input.message,
      ``,
      `Open in admin: ${appUrl}/admin/grievances?ticket_no=${encodeURIComponent(input.ticket_no)}`,
    ].filter(Boolean).join("\n");
    await sendEmail({ to: input.routeEmail, subject: adminSubject, body: adminBody });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[grievances] route mail failed", { ticket_no: input.ticket_no, err });
  }
}
