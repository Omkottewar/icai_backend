// Digest cron for job alerts. Fires daily at 07:00 IST for
// frequency='daily_digest' subs, and weekly (Mon 07:00 IST) for
// frequency='weekly_digest' subs.
//
// Implementation choice: single setInterval that ticks every 15 minutes and
// checks whether we've already sent today (per frequency). Idempotent via a
// per-user last_notified_at column — a subscriber that already got a digest
// in the current window is skipped. Matches the tick-based approach in
// escalations.ts so ops don't juggle multiple cron systems.

import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
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

const TICK_MS = 15 * 60 * 1000;      // 15 minutes
const DIGEST_HOUR_IST = 7;           // 07:00 IST send window
const IST_OFFSET_MIN = 330;          // IST = UTC+5:30

let intervalHandle: NodeJS.Timeout | null = null;

function nowInIST(): Date {
  return new Date(Date.now() + IST_OFFSET_MIN * 60 * 1000);
}

function isSameDayUTC(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() &&
         a.getUTCMonth() === b.getUTCMonth() &&
         a.getUTCDate() === b.getUTCDate();
}

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

async function runDigestSweep(frequency: "daily_digest" | "weekly_digest", windowHours: number): Promise<void> {
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const nowIST = nowInIST();

  // Load every eligible sub for this frequency in one go, then group by user.
  const subs = await db
    .select({
      sub_id: jobAlertSubscriptions.id,
      user_id: jobAlertSubscriptions.user_id,
      category_id: jobAlertSubscriptions.category_id,
      posting_type: jobAlertSubscriptions.posting_type,
      filter_location: jobAlertSubscriptions.filter_location,
      filter_experience: jobAlertSubscriptions.filter_experience,
      last_notified_at: jobAlertSubscriptions.last_notified_at,
      category_name: jobCategories.name,
    })
    .from(jobAlertSubscriptions)
    .leftJoin(jobCategories, eq(jobCategories.id, jobAlertSubscriptions.category_id))
    .where(and(
      eq(jobAlertSubscriptions.frequency, frequency),
      isNull(jobAlertSubscriptions.unsubscribed_at),
      sql`${jobAlertSubscriptions.confirmed_at} IS NOT NULL`,
    ));

  if (subs.length === 0) return;

  // Load all postings created within the digest window in one pass. Small
  // table + narrow window = safe to pull all rows and match in memory.
  const postings = await db
    .select({
      id: jobPostings.id,
      type: jobPostings.type,
      title: jobPostings.title,
      location: jobPostings.location,
      experience_required: jobPostings.experience_required,
      category_id: jobPostings.category_id,
      created_at: jobPostings.created_at,
      firm_name: firms.name,
      employer_name: employers.company_name,
    })
    .from(jobPostings)
    .leftJoin(firms, eq(firms.id, jobPostings.firm_id))
    .leftJoin(employers, eq(employers.id, jobPostings.employer_id))
    .where(and(
      eq(jobPostings.status, "active"),
      isNull(jobPostings.deleted_at),
      gt(jobPostings.created_at, cutoff),
    ))
    .orderBy(desc(jobPostings.created_at));

  if (postings.length === 0) return;

  // Group subs by user so each user gets one email covering all their subs.
  const byUser = new Map<string, typeof subs>();
  for (const s of subs) {
    if (s.last_notified_at && isSameDayUTC(s.last_notified_at, new Date())) continue;
    const arr = byUser.get(s.user_id) ?? [];
    arr.push(s);
    byUser.set(s.user_id, arr);
  }

  const base = publicBaseUrl();

  for (const [user_id, userSubs] of byUser) {
    // Filter postings against every sub of this user, dedup by posting id.
    const matched = new Map<string, typeof postings[number] & { via_category: string }>();
    for (const p of postings) {
      for (const s of userSubs) {
        if (p.category_id !== s.category_id) continue;
        if (p.type !== s.posting_type) continue;
        if (s.filter_location) {
          if (!p.location) continue;
          if (!p.location.toLowerCase().includes(s.filter_location.toLowerCase())) continue;
        }
        if (s.filter_experience) {
          if (!p.experience_required) continue;
          if (!p.experience_required.toLowerCase().includes(s.filter_experience.toLowerCase())) continue;
        }
        matched.set(p.id, { ...p, via_category: s.category_name ?? "your alert" });
        break;
      }
    }

    if (matched.size === 0) continue;

    const rows = Array.from(matched.values());
    const digest_body = rows.map((p) =>
      `• ${p.title} — ${orgLabel(p)}\n  ${base}/jobs/${encodeURIComponent(p.id)}`
    ).join("\n\n");
    const digest_summary = rows.slice(0, 3).map((p) => p.title).join(" · ")
      + (rows.length > 3 ? ` +${rows.length - 3} more` : "");

    const manageToken = issueToken(user_id, "job_alert_manage", 14 * 24 * 60 * 60);
    const manage_url = `${base}/job-alerts/manage?token=${encodeURIComponent(manageToken)}`;
    const listing_url = `${base}/job-vacancies`;

    await notify({
      user_id,
      template_key: frequency === "daily_digest" ? "job_alert_daily_digest" : "job_alert_weekly_digest",
      link_url: listing_url,
      vars: {
        count: rows.length,
        plural: rows.length === 1 ? "" : "s",
        digest_body,
        digest_summary,
        listing_url,
        manage_url,
      },
    });

    await db.update(jobAlertSubscriptions)
      .set({ last_notified_at: new Date() })
      .where(and(
        eq(jobAlertSubscriptions.user_id, user_id),
        eq(jobAlertSubscriptions.frequency, frequency),
      ));
  }
}

async function tick(): Promise<void> {
  const ist = nowInIST();
  const hour = ist.getUTCHours();
  const dayOfWeek = ist.getUTCDay();   // 0 = Sun, 1 = Mon (IST-aligned)

  // Only fire between 07:00–07:14 IST — the outer 15-min interval gives us
  // one bite at the send window per day. Miss it (host reboot etc.) and
  // the digest waits until tomorrow.
  if (hour !== DIGEST_HOUR_IST) return;

  await runDigestSweep("daily_digest", 24);
  if (dayOfWeek === 1) {
    await runDigestSweep("weekly_digest", 24 * 7);
  }
}

export function startJobAlertsCron(): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    tick().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[jobAlertsCron] tick failed", err);
    });
  }, TICK_MS);
}

// Exposed for /api/admin/jobs/_dev/run-digest — lets ops trigger a send
// off-cycle without waiting for 07:00. Not wired by default; add a route
// only if a real need appears.
export async function runDigestNow(frequency: "daily_digest" | "weekly_digest"): Promise<void> {
  await runDigestSweep(frequency, frequency === "daily_digest" ? 24 : 24 * 7);
}
