// Admin insights & dashboards — three role-focused endpoints that each
// return a single JSON payload for a whole dashboard:
//
//   GET /api/admin/insights/chairman     — Chairman insights (event portfolio,
//                                            speakers, committees, growth,
//                                            financial cockpit, retention,
//                                            smart alerts, weekly digest)
//   GET /api/admin/insights/wicasa       — WICASA head dashboard (student
//                                            pulse, mock tests, articleship
//                                            funnel, scholarships, SLA,
//                                            reading room)
//   GET /api/admin/insights/alerts       — Just the smart-alerts list (for
//                                            lightweight polling from any
//                                            page's header widget)
//
// Each endpoint fans out its queries in parallel with Promise.all so the
// response is bounded by the slowest single query. All queries use
// aggregation (`count(*) filter (where …)`) to keep the DB round-trip
// count small.

import { Router } from "express";
import { and, desc, eq, gt, gte, ilike, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import {
  events, eventRegistrations,
  users, memberProfiles,
  committees,
  payments, paymentRefunds, bills, budgets,
  mockTests,
  articleshipMatches,
  scholarshipApplications,
  counsellingRequests,
  grievances,
  readingRoomDeposits,
  studentSuggestions,
} from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { handleApiError } from "../../lib/apiError.js";

export const insightsAdminRouter = Router();

// ─── In-process cache ────────────────────────────────────────────────────
//
// Both insights endpoints fan out 10+ heavy analytics queries in parallel.
// The frontend polls them, and admins often have both tabs open — that
// hammered the Supabase transaction pooler until connections queued past
// the statement_timeout and unrelated fast queries (myFillQueue etc.)
// started dying with "canceling statement due to statement timeout".
//
// A 60s per-endpoint memo is fine: this data is roll-up counts, not live
// state, and 1-minute freshness is well within the "check my dashboard"
// use case. TTL is short enough that stat swings after a big event still
// show up quickly. No user-scoping — the payload is the same for any
// admin viewer.
const INSIGHTS_CACHE = new Map<string, { ts: number; body: unknown }>();
const INSIGHTS_CACHE_TTL_MS = 60_000;

function insightsCacheGet(key: string): unknown | null {
  const hit = INSIGHTS_CACHE.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > INSIGHTS_CACHE_TTL_MS) {
    INSIGHTS_CACHE.delete(key);
    return null;
  }
  return hit.body;
}
function insightsCacheSet(key: string, body: unknown) {
  INSIGHTS_CACHE.set(key, { ts: Date.now(), body });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function daysAgo(n: number) {
  return new Date(Date.now() - n * 86_400_000);
}
function monthsAgo(n: number) {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d;
}
function firstOfCurrentMonth() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

// Serialize a Date for interpolation into a raw `sql\`\`` template that
// applies a `::timestamptz` cast. Passing a Date directly makes postgres.js
// bind it as `text` (because the parameter position has no column-type
// context — the cast happens *after* the placeholder) and its serializer
// then throws "The 'string' argument must be of type string ... Received
// an instance of Date". ISO 8601 is unambiguous input for timestamptz, so
// converting to string sidesteps the whole issue.
function iso(d: Date): string {
  return d.toISOString();
}

/**
 * Compute the current-active fiscal year start (April in India). Used for
 * financial cockpit windows.
 */
function currentFyStartYear(now = new Date()) {
  return now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}

// ─── GET /alerts ───────────────────────────────────────────────────────────
// Real-time smart alerts. Cheap to compute; can be polled by any admin page.
// Each alert has: id (stable key), severity ("critical"|"warn"|"info"),
// title, detail (one line), href (link to the resource that resolves it).
insightsAdminRouter.get("/alerts", async (_req: AuthedRequest, res, next) => {
  try {
    // 30s cache — the alerts widget is polled from every admin page's
    // header, so the same 5 aggregate queries would fire N times per minute
    // per open admin tab. Cache keeps the pool free for actual work.
    const cached = insightsCacheGet("alerts");
    if (cached) return res.json(cached);

    const now  = new Date();
    const in5d = new Date(now.getTime() + 5 * 86_400_000);
    const t24h = daysAgo(1);
    const t48h = daysAgo(2);
    const t7d  = daysAgo(7);

    // Promise.allSettled — mirrors chairman/wicasa so a single slow
    // sub-query degrades that one alert instead of taking down the whole
    // header widget across the admin panel.
    const alertsSettled = await Promise.allSettled([
      // Under-filling events: starts within 5 days, capacity set,
      // registered_count < 50% of capacity.
      db.select({
        id:       events.id,
        slug:     events.slug,
        title:    events.title,
        starts_at: events.starts_at,
        capacity: events.capacity,
        registered_count: events.registered_count,
      })
        .from(events)
        .where(and(
          isNull(events.deleted_at),
          eq(events.status, "published"),
          gt(events.starts_at, now),
          lt(events.starts_at, in5d),
          sql`${events.capacity} IS NOT NULL AND ${events.capacity} > 0`,
          sql`(${events.registered_count}::float / ${events.capacity}::float) < 0.5`,
        ))
        .limit(10),

      // Payments awaiting verification > 24h.
      db.select({ n: sql<number>`count(*)::int`.as("n") })
        .from(payments)
        .where(and(
          eq(payments.status, "pending_verification"),
          isNull(payments.deleted_at),
          lt(payments.created_at, t24h),
        )),

      // Grievance SLA breach: open > 48h without resolution.
      db.select({ n: sql<number>`count(*)::int`.as("n") })
        .from(grievances)
        .where(and(
          eq(grievances.status, "open"),
          lt(grievances.created_at, t48h),
        )),

      // Refunds requested > 7 days ago, not yet processed.
      db.select({ n: sql<number>`count(*)::int`.as("n") })
        .from(paymentRefunds)
        .where(and(
          sql`${paymentRefunds.status} IN ('requested', 'approved')`,
          lt(paymentRefunds.created_at, t7d),
        )),

      // Reading room deposits awaiting verification > 24h.
      db.select({ n: sql<number>`count(*)::int`.as("n") })
        .from(readingRoomDeposits)
        .where(and(
          eq(readingRoomDeposits.status, "pending_verification"),
          lt(readingRoomDeposits.created_at, t24h),
        )),
    ]);

    // Unwrap with per-slot fallbacks so a single failure just drops that
    // alert rather than 500ing the header widget.
    const alertLabels = ["underfilling", "pendingUtr", "slaBreach", "staleRefunds", "readingPending"];
    const unwrapA = <T>(i: number, fallback: T): T => {
      const s = alertsSettled[i];
      if (s.status === "fulfilled") return s.value as T;
      // eslint-disable-next-line no-console
      console.error(`[insights/alerts] ${alertLabels[i]} failed:`, s.reason?.message ?? s.reason);
      return fallback;
    };
    const underfilling    = unwrapA<any[]>(0, []);
    const pendingUtr      = unwrapA<any[]>(1, [{ n: 0 }]);
    const slaBreach       = unwrapA<any[]>(2, [{ n: 0 }]);
    const staleRefunds    = unwrapA<any[]>(3, [{ n: 0 }]);
    const readingPending  = unwrapA<any[]>(4, [{ n: 0 }]);

    const alerts: Array<{
      id: string; severity: "critical" | "warn" | "info";
      title: string; detail: string; href: string;
    }> = [];

    for (const e of underfilling) {
      const cap = e.capacity ?? 0;
      const reg = e.registered_count;
      const daysLeft = Math.max(0, Math.round((new Date(e.starts_at).getTime() - now.getTime()) / 86_400_000));
      alerts.push({
        id: `underfill:${e.id}`,
        severity: daysLeft <= 2 ? "critical" : "warn",
        title: `${e.title} — under-filling`,
        detail: `${reg}/${cap} seats (${Math.round((reg / cap) * 100)}%) — starts in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`,
        href: `/admin/events`,
      });
    }
    if ((pendingUtr[0]?.n ?? 0) > 10) {
      alerts.push({
        id: "utr:backlog",
        severity: (pendingUtr[0]!.n) > 25 ? "critical" : "warn",
        title: "UTR verification backlog",
        detail: `${pendingUtr[0]!.n} payments awaiting verification > 24h — approve to release seats`,
        href: `/admin/payments`,
      });
    }
    if ((slaBreach[0]?.n ?? 0) > 0) {
      alerts.push({
        id: "grievance:sla",
        severity: "critical",
        title: "Grievance SLA breach",
        detail: `${slaBreach[0]!.n} grievance${slaBreach[0]!.n === 1 ? "" : "s"} open > 48h — 48h SLA breached`,
        href: `/admin/grievances`,
      });
    }
    if ((staleRefunds[0]?.n ?? 0) > 0) {
      alerts.push({
        id: "refunds:stale",
        severity: "warn",
        title: "Refund delays",
        detail: `${staleRefunds[0]!.n} refund${staleRefunds[0]!.n === 1 ? "" : "s"} pending > 7 days — process to keep members happy`,
        href: `/admin/refunds`,
      });
    }
    if ((readingPending[0]?.n ?? 0) > 0) {
      alerts.push({
        id: "reading:pending",
        severity: "info",
        title: "Reading-room deposits awaiting verification",
        detail: `${readingPending[0]!.n} deposit${readingPending[0]!.n === 1 ? "" : "s"} awaiting UTR verification`,
        href: `/admin/reading-room`,
      });
    }

    const payload = { generated_at: now.toISOString(), count: alerts.length, alerts };
    insightsCacheSet("alerts", payload);
    res.json(payload);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /chairman ─────────────────────────────────────────────────────────
// Chairman insights — one big payload feeding the full insights dashboard.
//
// Each query is wrapped in a `safe()` that catches + logs its own error
// and returns a sensible empty default. A single broken query (missing
// column on an older DB, permissions on a specific view, etc.) then
// degrades that one section instead of taking down the whole endpoint.
insightsAdminRouter.get("/chairman", async (_req: AuthedRequest, res, next) => {
  try {
    const cached = insightsCacheGet("chairman");
    if (cached) return res.json(cached);

    const now       = new Date();
    const fy        = currentFyStartYear(now);
    const fyStart   = new Date(Date.UTC(fy, 3, 1));
    const t30d      = daysAgo(30);
    const t90d      = daysAgo(90);
    const t365d     = daysAgo(365);
    const forecast30d = new Date(now.getTime() + 30 * 86_400_000);

    const labels = [
      "eventPortfolio", "topSpeakers", "committeeLeaderboard",
      "signupsMonthly", "registrationsMonthly",
      "cashInflow30d", "cashOutflow30d",
      "billsPending", "refundsPending",
      "retentionCohort", "idleCommittees",
    ];

    const settled = await Promise.allSettled([
      // Event portfolio — last 90 days: committee × program_type roll-up
      // with attendance %, fee revenue, count.
      db.select({
        committee_id:   events.committee_id,
        committee_name: committees.name,
        program_type:   events.program_type,
        event_count:    sql<number>`count(*)::int`.as("event_count"),
        avg_fill:       sql<number>`
          COALESCE(AVG(
            CASE WHEN ${events.capacity} IS NOT NULL AND ${events.capacity} > 0
              THEN ${events.registered_count}::float / ${events.capacity}::float
              ELSE NULL
            END
          ) * 100.0, 0)::int
        `.as("avg_fill"),
        total_registered: sql<number>`COALESCE(SUM(${events.registered_count}), 0)::int`.as("total_registered"),
        revenue_paise:    sql<number>`COALESCE(SUM(${events.fee_paise} * ${events.registered_count}), 0)::bigint`.as("revenue_paise"),
      })
        .from(events)
        .leftJoin(committees, eq(committees.id, events.committee_id))
        .where(and(
          isNull(events.deleted_at),
          gte(events.starts_at, t90d),
          sql`${events.status} IN ('published', 'completed')`,
        ))
        .groupBy(events.committee_id, committees.name, events.program_type)
        .orderBy(sql`event_count DESC`)
        .limit(50),

      // Top speakers by session count. Uses events.speaker_name (the
      // free-text legacy field) — the event_speakers junction table only
      // links to users.id, so a proper by-user leaderboard would need a
      // second join. This covers external speakers too, which is what
      // matters for the "should we invite them again" question.
      db.select({
        name: events.speaker_name,
        sessions: sql<number>`count(*)::int`.as("sessions"),
        latest_session: sql<Date>`MAX(${events.starts_at})`.as("latest_session"),
        total_reach: sql<number>`COALESCE(SUM(${events.registered_count}), 0)::int`.as("total_reach"),
      })
        .from(events)
        .where(and(
          isNull(events.deleted_at),
          gte(events.starts_at, t365d),
          sql`${events.speaker_name} IS NOT NULL AND ${events.speaker_name} <> ''`,
        ))
        .groupBy(events.speaker_name)
        .orderBy(sql`sessions DESC, total_reach DESC`)
        .limit(15),

      // Committee leaderboard — last 90 days.
      db.select({
        id:     committees.id,
        name:   committees.name,
        code:   committees.code,
        events_held:      sql<number>`count(${events.id})::int`.as("events_held"),
        total_registered: sql<number>`COALESCE(SUM(${events.registered_count}), 0)::int`.as("total_registered"),
        revenue_paise:    sql<number>`COALESCE(SUM(${events.fee_paise} * ${events.registered_count}), 0)::bigint`.as("revenue_paise"),
        last_event_at:    sql<Date | null>`MAX(${events.starts_at})`.as("last_event_at"),
      })
        .from(committees)
        .leftJoin(events, and(
          eq(events.committee_id, committees.id),
          isNull(events.deleted_at),
          gte(events.starts_at, t90d),
          sql`${events.status} IN ('published', 'completed')`,
        ))
        .where(eq(committees.active, true))
        .groupBy(committees.id, committees.name, committees.code)
        .orderBy(sql`events_held DESC, total_registered DESC`),

      // Signups by month — last 12 months. date_trunc keeps months tidy.
      db.execute(sql`
        SELECT
          to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
          count(*) FILTER (WHERE primary_role = 'member')::int  AS members,
          count(*) FILTER (WHERE primary_role = 'student')::int AS students,
          count(*)::int                                          AS total
        FROM users
        WHERE deleted_at IS NULL
          AND created_at >= ${iso(monthsAgo(12))}::timestamptz
        GROUP BY 1
        ORDER BY 1
      `),

      // Registrations by month — last 12 months.
      db.execute(sql`
        SELECT
          to_char(date_trunc('month', registered_at), 'YYYY-MM') AS month,
          count(*)::int AS registrations
        FROM event_registrations
        WHERE deleted_at IS NULL
          AND registered_at >= ${iso(monthsAgo(12))}::timestamptz
        GROUP BY 1
        ORDER BY 1
      `),

      // Cash inflow expected in next 30 days from confirmed paid events.
      db.select({
        paise: sql<number>`COALESCE(SUM(${events.fee_paise} * ${events.registered_count}), 0)::bigint`.as("paise"),
        events_count: sql<number>`count(*)::int`.as("events_count"),
      })
        .from(events)
        .where(and(
          isNull(events.deleted_at),
          eq(events.status, "published"),
          gte(events.starts_at, now),
          lt(events.starts_at, forecast30d),
          sql`${events.fee_paise} > 0`,
        )),

      // Cash outflow committed: bills approved but not yet paid.
      db.select({
        paise: sql<number>`COALESCE(SUM(${bills.amount_paise}), 0)::bigint`.as("paise"),
        bills_count: sql<number>`count(*)::int`.as("bills_count"),
      })
        .from(bills)
        .where(and(
          isNull(bills.deleted_at),
          eq(bills.status, "approved"),
        )),

      // Bills awaiting approval.
      db.select({ n: sql<number>`count(*)::int`.as("n") })
        .from(bills)
        .where(and(
          isNull(bills.deleted_at),
          sql`${bills.status} IN ('submitted', 'draft')`,
        )),

      // Refunds waiting to be processed.
      db.select({ n: sql<number>`count(*)::int`.as("n") })
        .from(paymentRefunds)
        .where(sql`${paymentRefunds.status} IN ('requested', 'approved')`),

      // Member retention cohort — for each of the last 6 monthly cohorts,
      // how many members registered for ≥1 event in each subsequent month.
      // Done as one CTE-heavy query.
      db.execute(sql`
        WITH cohort_users AS (
          SELECT
            id,
            date_trunc('month', created_at) AS cohort_month
          FROM users
          WHERE deleted_at IS NULL
            AND created_at >= ${iso(monthsAgo(6))}::timestamptz
        ),
        registrations_by_month AS (
          SELECT
            r.user_id,
            date_trunc('month', r.registered_at) AS reg_month
          FROM event_registrations r
          WHERE r.deleted_at IS NULL
            AND r.registered_at >= ${iso(monthsAgo(6))}::timestamptz
        )
        SELECT
          to_char(cu.cohort_month, 'YYYY-MM') AS cohort,
          count(DISTINCT cu.id)::int          AS cohort_size,
          count(DISTINCT CASE WHEN rbm.reg_month = cu.cohort_month                          THEN cu.id END)::int AS m0,
          count(DISTINCT CASE WHEN rbm.reg_month = cu.cohort_month + interval '1 month'    THEN cu.id END)::int AS m1,
          count(DISTINCT CASE WHEN rbm.reg_month = cu.cohort_month + interval '2 months'   THEN cu.id END)::int AS m2,
          count(DISTINCT CASE WHEN rbm.reg_month = cu.cohort_month + interval '3 months'   THEN cu.id END)::int AS m3
        FROM cohort_users cu
        LEFT JOIN registrations_by_month rbm ON rbm.user_id = cu.id
        GROUP BY cu.cohort_month
        ORDER BY cu.cohort_month DESC
      `),

      // Committees with no event in 60+ days (idle).
      db.execute(sql`
        SELECT c.id, c.name, c.code, MAX(e.starts_at) AS last_event_at
        FROM committees c
        LEFT JOIN events e ON e.committee_id = c.id AND e.deleted_at IS NULL AND e.status IN ('published','completed')
        WHERE c.active = true
        GROUP BY c.id, c.name, c.code
        HAVING MAX(e.starts_at) IS NULL OR MAX(e.starts_at) < ${iso(daysAgo(60))}::timestamptz
        ORDER BY MAX(e.starts_at) NULLS FIRST
        LIMIT 20
      `),
    ]);

    // Unwrap results — log rejections and fall back to empty arrays / zero
    // so a single broken query never 500s the entire dashboard.
    const unwrap = <T>(i: number, fallback: T): T => {
      const s = settled[i];
      if (s.status === "fulfilled") return s.value as T;
      // eslint-disable-next-line no-console
      console.error(`[insights/chairman] ${labels[i]} failed:`,
        s.reason?.message ?? s.reason,
        s.reason?.query ? `\n  query: ${String(s.reason.query).slice(0, 240)}` : "");
      return fallback;
    };

    const eventPortfolio       = unwrap<any[]>(0,  []);
    const topSpeakers          = unwrap<any[]>(1,  []);
    const committeeLeaderboard = unwrap<any[]>(2,  []);
    const signupsMonthly       = unwrap<any[]>(3,  []);
    const registrationsMonthly = unwrap<any[]>(4,  []);
    const cashInflow30d        = unwrap<any[]>(5,  [{ paise: 0, events_count: 0 }]);
    const cashOutflow30d       = unwrap<any[]>(6,  [{ paise: 0, bills_count: 0 }]);
    const billsPending         = unwrap<any[]>(7,  [{ n: 0 }]);
    const refundsPending       = unwrap<any[]>(8,  [{ n: 0 }]);
    const retentionCohort      = unwrap<any[]>(9,  []);
    const idleCommittees       = unwrap<any[]>(10, []);

    // Growth quick-numbers derived from the monthly signup series.
    const signupsList = signupsMonthly as Array<{ month: string; members: number; students: number; total: number }>;
    const signupsThisMonth = signupsList.filter((r) => r.month === new Date().toISOString().slice(0, 7))[0]?.total ?? 0;
    const signupsPrevMonth = signupsList[signupsList.length - 2]?.total ?? 0;

    const payload = {
      generated_at: now.toISOString(),
      window: { fy_start: fyStart.toISOString(), t90d: t90d.toISOString(), t365d: t365d.toISOString() },
      portfolio: eventPortfolio,
      top_speakers: topSpeakers,
      committees: committeeLeaderboard,
      growth: {
        signups_monthly: signupsList,
        registrations_monthly: registrationsMonthly,
        signups_this_month: signupsThisMonth,
        signups_prev_month: signupsPrevMonth,
      },
      financial: {
        cash_inflow_30d_paise:  Number(cashInflow30d[0]?.paise  ?? 0),
        cash_inflow_events:     cashInflow30d[0]?.events_count  ?? 0,
        cash_outflow_committed_paise: Number(cashOutflow30d[0]?.paise ?? 0),
        cash_outflow_bills:     cashOutflow30d[0]?.bills_count  ?? 0,
        bills_pending_approval: billsPending[0]?.n ?? 0,
        refunds_pending:        refundsPending[0]?.n ?? 0,
      },
      retention_cohort: retentionCohort,
      idle_committees:  idleCommittees,
    };
    insightsCacheSet("chairman", payload);
    res.json(payload);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /wicasa ───────────────────────────────────────────────────────────
insightsAdminRouter.get("/wicasa", async (_req: AuthedRequest, res, next) => {
  try {
    const cached = insightsCacheGet("wicasa");
    if (cached) return res.json(cached);

    const now  = new Date();
    const t30d = daysAgo(30);
    const t90d = daysAgo(90);

    const wicasaLabels = [
      "studentPulse", "newSignups12m", "studentEventStats", "upcomingStudentEvents",
      "mockTestSummary", "mockTestAttemptStats", "articleshipFunnel", "scholarshipFunnel",
      "counsellingSummary", "studentSuggestionsOpen", "readingRoomUsage", "readingRoomPendingDeposits",
    ];
    const wicasaSettled = await Promise.allSettled([
      // Total students + engagement (any registration in last 30d).
      db.execute(sql`
        WITH student_ids AS (
          SELECT id FROM users WHERE deleted_at IS NULL AND primary_role = 'student'
        ),
        active AS (
          SELECT DISTINCT user_id FROM event_registrations
          WHERE deleted_at IS NULL AND registered_at >= ${iso(t30d)}::timestamptz
        )
        SELECT
          (SELECT count(*) FROM student_ids)::int AS total_students,
          (SELECT count(*) FROM student_ids WHERE id IN (SELECT user_id FROM active))::int AS active_30d,
          (SELECT count(*) FROM users WHERE primary_role = 'student' AND deleted_at IS NULL AND created_at >= ${iso(t30d)}::timestamptz)::int AS new_30d
      `),

      db.execute(sql`
        SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
               count(*)::int AS n
        FROM users
        WHERE primary_role = 'student'
          AND deleted_at IS NULL
          AND created_at >= ${iso(monthsAgo(12))}::timestamptz
        GROUP BY 1 ORDER BY 1
      `),

      // Student events last 90d — count, avg attendance, attendance no-shows.
      db.select({
        events_count:       sql<number>`count(*)::int`.as("events_count"),
        total_registrations: sql<number>`COALESCE(SUM(${events.registered_count}), 0)::int`.as("total_registrations"),
        avg_fill:           sql<number>`
          COALESCE(AVG(
            CASE WHEN ${events.capacity} IS NOT NULL AND ${events.capacity} > 0
              THEN ${events.registered_count}::float / ${events.capacity}::float
              ELSE NULL
            END
          ) * 100.0, 0)::int
        `.as("avg_fill"),
      })
        .from(events)
        .where(and(
          isNull(events.deleted_at),
          gte(events.starts_at, t90d),
          sql`${events.audience} IN ('students', 'all')`,
          sql`${events.status} IN ('published', 'completed')`,
        )),

      // Upcoming student events (next 30 days).
      db.select({
        id: events.id, slug: events.slug, title: events.title,
        starts_at: events.starts_at,
        capacity: events.capacity,
        registered_count: events.registered_count,
        committee_name: committees.name,
      })
        .from(events)
        .leftJoin(committees, eq(committees.id, events.committee_id))
        .where(and(
          isNull(events.deleted_at),
          eq(events.status, "published"),
          sql`${events.audience} IN ('students', 'all')`,
          gte(events.starts_at, now),
        ))
        .orderBy(events.starts_at)
        .limit(10),

      // Mock tests summary — total, upcoming, completed.
      db.select({
        total:     sql<number>`count(*)::int`.as("total"),
        upcoming:  sql<number>`count(*) filter (where ${mockTests.status} = 'scheduled')::int`.as("upcoming"),
        completed: sql<number>`count(*) filter (where ${mockTests.status} = 'completed')::int`.as("completed"),
      }).from(mockTests),

      // Attempt & pass stats — last 90d. The final grade lives in
      // `score_total` (auto + manual combined); `score` never existed as a
      // column. `passed` uses a 40% floor as a coarse default since the
      // per-test pass mark isn't stored on the attempts table.
      db.execute(sql`
        SELECT
          count(*)::int AS attempts,
          count(*) FILTER (WHERE submitted_at IS NOT NULL)::int AS submitted,
          count(*) FILTER (WHERE score_total IS NOT NULL AND score_total >= 40)::int AS passed,
          count(*) FILTER (WHERE score_total IS NOT NULL AND score_total <  40)::int AS failed,
          AVG(score_total) FILTER (WHERE score_total IS NOT NULL) AS avg_score
        FROM mock_test_attempts
        WHERE created_at >= ${iso(t90d)}::timestamptz
      `),

      // Articleship funnel by status.
      db.select({
        status: articleshipMatches.status,
        n:      sql<number>`count(*)::int`.as("n"),
      }).from(articleshipMatches).groupBy(articleshipMatches.status),

      // Scholarship funnel by status.
      db.select({
        status: scholarshipApplications.status,
        n:      sql<number>`count(*)::int`.as("n"),
      }).from(scholarshipApplications).groupBy(scholarshipApplications.status),

      // Counselling requests summary + avg-response-time.
      db.select({
        total:   sql<number>`count(*)::int`.as("total"),
        pending: sql<number>`count(*) filter (where ${counsellingRequests.status} = 'pending')::int`.as("pending"),
      }).from(counsellingRequests),

      // Student suggestions with open threads.
      db.select({ n: sql<number>`count(*)::int`.as("n") })
        .from(studentSuggestions)
        .where(sql`${studentSuggestions.status} IN ('open', 'in_review')`),

      // Reading room bookings by month (last 6 months).
      db.execute(sql`
        SELECT
          concat(year, '-', LPAD(month::text, 2, '0')) AS ym,
          count(*)::int AS bookings
        FROM reading_room_bookings
        WHERE cancelled_at IS NULL
          AND created_at >= ${iso(monthsAgo(6))}::timestamptz
        GROUP BY year, month
        ORDER BY year, month
      `),

      // Reading room deposits pending verification.
      db.select({ n: sql<number>`count(*)::int`.as("n") })
        .from(readingRoomDeposits)
        .where(eq(readingRoomDeposits.status, "pending_verification")),
    ]);

    // Fallback shapes match what a successful query would return so the
    // downstream code below doesn't have to null-check every field. Same
    // pattern as chairman's `unwrap` — a single slow / broken sub-query
    // degrades that one tile instead of taking down the whole payload.
    const unwrapW = <T>(i: number, fallback: T): T => {
      const s = wicasaSettled[i];
      if (s.status === "fulfilled") return s.value as T;
      // eslint-disable-next-line no-console
      console.error(`[insights/wicasa] ${wicasaLabels[i]} failed:`,
        s.reason?.message ?? s.reason);
      return fallback;
    };
    const studentPulse              = unwrapW<any[]>(0,  [{ total_students: 0, active_30d: 0, new_30d: 0 }]);
    const newSignups12m             = unwrapW<any[]>(1,  []);
    const studentEventStats         = unwrapW<any[]>(2,  [{ events_count: 0, total_registrations: 0, avg_fill: 0 }]);
    const upcomingStudentEvents     = unwrapW<any[]>(3,  []);
    const mockTestSummary           = unwrapW<any[]>(4,  [{ total: 0, upcoming: 0, completed: 0 }]);
    const mockTestAttemptStats      = unwrapW<any[]>(5,  [{ attempts: 0, submitted: 0, passed: 0, failed: 0, avg_score: null }]);
    const articleshipFunnel         = unwrapW<any[]>(6,  []);
    const scholarshipFunnel         = unwrapW<any[]>(7,  []);
    const counsellingSummary        = unwrapW<any[]>(8,  [{}]);
    const studentSuggestionsOpen    = unwrapW<any[]>(9,  [{ n: 0 }]);
    const readingRoomUsage          = unwrapW<any[]>(10, []);
    const readingRoomPendingDeposits = unwrapW<any[]>(11, [{ n: 0 }]);

    const payload = {
      generated_at: now.toISOString(),
      student_pulse: (studentPulse as any)[0],
      new_signups_12m: newSignups12m,
      events: {
        last_90d: studentEventStats[0],
        upcoming: upcomingStudentEvents,
      },
      mock_tests: {
        summary: mockTestSummary[0],
        attempts_last_90d: (mockTestAttemptStats as any)[0],
      },
      articleship: {
        funnel: articleshipFunnel,
      },
      scholarship: {
        funnel: scholarshipFunnel,
      },
      services: {
        counselling: counsellingSummary[0],
        suggestions_open: studentSuggestionsOpen[0]?.n ?? 0,
      },
      reading_room: {
        usage_monthly: readingRoomUsage,
        pending_deposits: readingRoomPendingDeposits[0]?.n ?? 0,
      },
    };
    insightsCacheSet("wicasa", payload);
    res.json(payload);
  } catch (err) { handleApiError(err, res, next); }
});
