// Job-alerts dispatch — the "when a posting activates, email the subscribers"
// side of the feature. Called from routes/employer.ts (auto-publish path) and
// routes/admin/jobs.ts (admin publish path) whenever a posting moves into
// status='active'. Digest dispatch lives in jobAlertsCron.ts.
//
// Design:
//   • Loads confirmed, non-unsub subscribers matching (category_id,
//     posting_type) whose optional filters pass (case-insensitive substring
//     compare on location / experience).
//   • Fans out via notify() one user at a time — the notify pipeline handles
//     the audit trail, email opt-out, and per-channel best-effort delivery.
//   • Never throws — a broken alert must not roll back the posting insert.

import { and, eq, isNull, ilike, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  jobAlertSubscriptions,
  jobCategories,
  jobPostings,
  firms,
  employers,
  users,
} from "../../schema/index.js";
import { notify } from "./notify.js";
import { issueToken } from "./tokens.js";

// Two-week validity is long enough that a slow mailbox still resolves, short
// enough that a token leaked from an email archive won't work indefinitely.
const MANAGE_TOKEN_TTL_SECONDS = 14 * 24 * 60 * 60;

function publicBaseUrl(): string {
  return (
    process.env.PUBLIC_APP_URL ||
    process.env.VITE_PUBLIC_APP_URL ||
    "https://icainagpur.in"
  ).replace(/\/+$/, "");
}

function orgLabel(row: { firm_name: string | null; employer_name: string | null }): string {
  return row.firm_name || row.employer_name || "ICAI Nagpur";
}

function typeLabel(t: string): string {
  if (t === "articleship") return "articleship";
  if (t === "assignment")  return "assignment";
  return "job";
}

/**
 * Fire per-subscriber instant alerts for a newly activated posting. Safe to
 * call multiple times — subscribers with an existing notification_deliveries
 * row for this template + posting can be deduped by admin later; we don't
 * hard-dedupe here because "second activation" is a legitimate re-post.
 */
export async function dispatchJobAlerts(posting_id: string): Promise<void> {
  try {
    const [posting] = await db
      .select({
        id: jobPostings.id,
        type: jobPostings.type,
        title: jobPostings.title,
        location: jobPostings.location,
        experience_required: jobPostings.experience_required,
        category_id: jobPostings.category_id,
        firm_name: firms.name,
        employer_name: employers.company_name,
        category_name: jobCategories.name,
      })
      .from(jobPostings)
      .leftJoin(firms, eq(firms.id, jobPostings.firm_id))
      .leftJoin(employers, eq(employers.id, jobPostings.employer_id))
      .leftJoin(jobCategories, eq(jobCategories.id, jobPostings.category_id))
      .where(and(eq(jobPostings.id, posting_id), isNull(jobPostings.deleted_at)))
      .limit(1);

    if (!posting || !posting.category_id) {
      // No category → no one subscribed. Silent no-op; admin/employer UI
      // nudges posters to pick a category.
      return;
    }

    // Match subs where filter_location and filter_experience are either NULL
    // or ILIKE the posting's fields. If the posting is missing a location
    // and the sub demanded one, the sub is excluded (that's the safer
    // read of "I only want Nagpur jobs" — surface it or don't).
    const subs = await db
      .select({
        sub_id: jobAlertSubscriptions.id,
        user_id: jobAlertSubscriptions.user_id,
        filter_location: jobAlertSubscriptions.filter_location,
        filter_experience: jobAlertSubscriptions.filter_experience,
      })
      .from(jobAlertSubscriptions)
      .where(and(
        eq(jobAlertSubscriptions.category_id, posting.category_id),
        eq(jobAlertSubscriptions.posting_type, posting.type),
        eq(jobAlertSubscriptions.frequency, "instant"),
        isNull(jobAlertSubscriptions.unsubscribed_at),
        // Must be confirmed (double opt-in).
        sql`${jobAlertSubscriptions.confirmed_at} IS NOT NULL`,
      ));

    if (subs.length === 0) return;

    const base = publicBaseUrl();
    const posting_url = `${base}/job-vacancies?type=${encodeURIComponent(posting.type)}#p-${posting.id}`;
    const org_name = orgLabel(posting);
    const location_line = posting.location ? `\n  ${posting.location}` : "";
    const experience_line = posting.experience_required ? `\n  ${posting.experience_required}` : "";

    for (const sub of subs) {
      // Client-side filter — cheaper than a per-row SQL LIKE because most
      // subs don't set filters at all.
      if (sub.filter_location) {
        if (!posting.location) continue;
        if (!posting.location.toLowerCase().includes(sub.filter_location.toLowerCase())) continue;
      }
      if (sub.filter_experience) {
        if (!posting.experience_required) continue;
        if (!posting.experience_required.toLowerCase().includes(sub.filter_experience.toLowerCase())) continue;
      }

      const manageToken = issueToken(sub.user_id, "job_alert_manage", MANAGE_TOKEN_TTL_SECONDS);
      const manage_url = `${base}/job-alerts/manage?token=${encodeURIComponent(manageToken)}`;

      await notify({
        user_id: sub.user_id,
        template_key: "job_alert_new_posting",
        link_url: posting_url,
        vars: {
          posting_type: typeLabel(posting.type),
          posting_title: posting.title,
          category_name: posting.category_name ?? "your category",
          org_name,
          location_line,
          experience_line,
          posting_url,
          manage_url,
        },
      });

      await db.update(jobAlertSubscriptions)
        .set({ last_notified_at: new Date() })
        .where(eq(jobAlertSubscriptions.id, sub.sub_id));
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[jobAlerts] dispatch failed", { posting_id, err });
  }
}

/**
 * Fire the double-opt-in confirmation email. Safe to call multiple times —
 * it just re-sends the same template. Called from the subscribe endpoint
 * whenever the caller has any unconfirmed subs.
 */
export async function sendConfirmationEmail(user_id: string, category_names: string[]): Promise<void> {
  const [u] = await db.select({ email: users.email, name: users.name })
    .from(users).where(eq(users.id, user_id)).limit(1);
  if (!u) return;
  const base = publicBaseUrl();
  const token = issueToken(user_id, "job_alert_confirm", 7 * 24 * 60 * 60);
  const confirm_url = `${base}/job-alerts/confirm?token=${encodeURIComponent(token)}`;
  await notify({
    user_id,
    template_key: "job_alert_confirm",
    link_url: confirm_url,
    force_email: true,      // even if user opted out of general emails, this is a required opt-in step
    vars: {
      category_list: category_names.join(", "),
      confirm_url,
    },
  });
}
