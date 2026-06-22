import { Router } from "express";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { aliasedTable } from "drizzle-orm";
import { db } from "../../../db/client.js";
import {
  events,
  eventRegistrations,
  users,
  committees,
  checklistInstances,
  checklistTemplates,
  checklistInstanceApprovals,
  paymentRefunds,
  bills,
  iutTransfers,
  mockTests,
  mentorshipRequests,
  articleshipMatches,
} from "../../../schema/index.js";
import { loadUserPermissions } from "../../auth/permissions.js";
import { getMonthlyRevenue, fillMissingMonths, getCurrentMonthRevenuePaise } from "../../lib/revenueAggregates.js";
import { getCabfStats } from "../../lib/cabfStats.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";

export const homeAdminRouter = Router();

// ─── In-process per-user response cache ──────────────────────────────────
//
// /api/admin/home is the most expensive endpoint we have — up to ~21
// parallel queries against the DB. The frontend already caches it for
// 30s + polls every 60s, but the FIRST hit after the polling refresh
// still pays the full cost.
//
// We back that with a server-side memo: same userId asked within 30s gets
// the previous response synthesised from memory instead of re-running
// every query. Cuts p50 for the polling-warm case from ~200ms to <5ms.
// The cache key includes the user's role-codes hash, so a role change
// invalidates the entry immediately on the next read.
const HOME_CACHE = new Map<string, { ts: number; codesKey: string; body: unknown }>();
const HOME_CACHE_TTL_MS = 30_000;
const HOME_CACHE_MAX_ENTRIES = 200;

function homeCacheGet(userId: string, codesKey: string) {
  const hit = HOME_CACHE.get(userId);
  if (!hit) return null;
  if (Date.now() - hit.ts > HOME_CACHE_TTL_MS) return null;
  if (hit.codesKey !== codesKey) return null;   // roles changed → bust
  return hit.body;
}

function homeCacheSet(userId: string, codesKey: string, body: unknown) {
  // Tiny LRU-ish eviction: when we're near the cap, drop the oldest
  // half. Cheap and bounded — never grows unbounded under churn.
  if (HOME_CACHE.size >= HOME_CACHE_MAX_ENTRIES) {
    const oldest = Array.from(HOME_CACHE.entries())
      .sort((a, b) => a[1].ts - b[1].ts)
      .slice(0, Math.floor(HOME_CACHE_MAX_ENTRIES / 2));
    for (const [k] of oldest) HOME_CACHE.delete(k);
  }
  HOME_CACHE.set(userId, { ts: Date.now(), codesKey, body });
}

// ─── GET /api/admin/home ──────────────────────────────────────────────────
// Role-aware payload for the admin landing page.
//
// Variant priority (most specific wins):
//   wicasa > committee_chairman > accountant > treasurer > chairman > sysadmin
//
// Each variant only triggers the queries it needs — we don't fetch WICASA
// data for the treasurer or refund data for the WICASA chairman. The
// branches below pick the lists conditionally, then a single Promise.all
// fans them out.
homeAdminRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    const perms = await loadUserPermissions(user.id);
    const now = new Date();

    // Per-user response cache check (see HOME_CACHE above).
    const codesKey = Array.from(perms.codes).sort().join("|");
    const cached = homeCacheGet(user.id, codesKey);
    if (cached) {
      res.set("cache-control", "private, max-age=30");
      return res.json(cached);
    }

    // ─── Identify which committees this user chairs ────────────────────
    // and whether any of them are the WICASA committee.
    const committeeChairOf = perms.committeeChairmanOf;
    let wicasaCommitteeIds: string[] = [];
    if (committeeChairOf.length > 0) {
      const wicasaRows = await db
        .select({ id: committees.id })
        .from(committees)
        .where(inArray(committees.code, ["WICASA", "wicasa"]));
      wicasaCommitteeIds = wicasaRows.map((r) => r.id);
    }
    const isWicasa = committeeChairOf.some((id) => wicasaCommitteeIds.includes(id));

    const isChairman    = perms.codes.has("branch_chairman");
    const isVice        = perms.codes.has("branch_vice_chairman");
    const isSecretary   = perms.codes.has("branch_secretary");
    const isTreasurer   = perms.codes.has("branch_treasurer");
    const isAccountant  = perms.codes.has("accountant");

    let variant: string;
    if (isWicasa)                                       variant = "wicasa";
    else if (isAccountant && !isTreasurer)              variant = "accountant";
    else if (isTreasurer)                               variant = "treasurer";
    else if (committeeChairOf.length > 0)               variant = "committee_chairman";
    else if (isChairman || isVice || isSecretary)       variant = "chairman";
    else                                                variant = "sysadmin";

    // ─── Common: events pending approval (chairman / sysadmin) ──────────
    const pendingEventsP = (variant === "chairman" || variant === "sysadmin")
      ? db.select({
          id: events.id, slug: events.slug, title: events.title,
          starts_at: events.starts_at, status: events.status,
          committee_id: events.committee_id,
          committee_name: committees.name,
        })
        .from(events)
        .leftJoin(committees, eq(committees.id, events.committee_id))
        .where(and(eq(events.status, "pending_approval"), isNull(events.deleted_at)))
        .orderBy(asc(events.starts_at))
        .limit(10)
      : Promise.resolve([] as any[]);

    // ─── Common: checklist reviews awaiting THIS user ──────────────────
    // (a) Legacy single-reviewer instances where the user is the named reviewer.
    const myReviewQueueP = db.select({
      id: checklistInstances.id, title: checklistInstances.title,
      status: checklistInstances.status, updated_at: checklistInstances.updated_at,
      submitted_at: checklistInstances.submitted_at,
      template_name: checklistTemplates.name,
    })
      .from(checklistInstances)
      .leftJoin(checklistTemplates, eq(checklistTemplates.id, checklistInstances.template_id))
      .where(and(
        eq(checklistInstances.assigned_review_user_id, user.id),
        eq(checklistInstances.status, "awaiting_review"),
        isNull(checklistInstances.deleted_at),
      ))
      .orderBy(asc(checklistInstances.submitted_at))
      .limit(10);

    // (a2) Checklists awaiting THIS user to FILL (not review). Without this,
    // the committee chairman / treasurer / anyone who is the named filler
    // sees nothing on their dashboard even after the admin releases their
    // checklist — the existing 'myReviewQueue' only matches reviewers.
    const myFillQueueP = db.select({
      id: checklistInstances.id, title: checklistInstances.title,
      status: checklistInstances.status, updated_at: checklistInstances.updated_at,
      template_name: checklistTemplates.name,
      event_id: checklistInstances.event_id,
      event_title: events.title,
    })
      .from(checklistInstances)
      .leftJoin(checklistTemplates, eq(checklistTemplates.id, checklistInstances.template_id))
      .leftJoin(events, eq(events.id, checklistInstances.event_id))
      .where(and(
        eq(checklistInstances.assigned_fill_user_id, user.id),
        eq(checklistInstances.status, "awaiting_fill"),
        isNull(checklistInstances.deleted_at),
      ))
      .orderBy(asc(checklistInstances.updated_at))
      .limit(10);

    // (b) Multi-stage approval stages where the user holds the required role.
    // Each office bearer role owns exactly one stage code today:
    //   branch_chairman      → 'branch_chairman'
    //   branch_treasurer     → 'treasurer_iut'
    //   branch_vice_chairman → 'vc_agenda'
    // We don't filter on the user's role here — we filter on what role the
    // stage requires. The instance must still be 'awaiting_review' AND
    // the stage must still be 'pending'.
    const myRoleStages: string[] = [];
    if (perms.codes.has("branch_chairman"))      myRoleStages.push("branch_chairman");
    if (perms.codes.has("branch_treasurer"))     myRoleStages.push("treasurer_iut");
    if (perms.codes.has("branch_vice_chairman")) myRoleStages.push("vc_agenda");

    const myStageQueueP = myRoleStages.length > 0
      ? db.select({
          stage_id:     checklistInstanceApprovals.id,
          stage_code:   checklistInstanceApprovals.stage_code,
          stage_label:  checklistInstanceApprovals.stage_label,
          instance_id:  checklistInstances.id,
          title:        checklistInstances.title,
          submitted_at: checklistInstances.submitted_at,
          updated_at:   checklistInstanceApprovals.created_at,
          event_id:     checklistInstances.event_id,
          event_title:  events.title,
          template_name: checklistTemplates.name,
        })
        .from(checklistInstanceApprovals)
        .innerJoin(checklistInstances, eq(checklistInstances.id, checklistInstanceApprovals.instance_id))
        .leftJoin(checklistTemplates, eq(checklistTemplates.id, checklistInstances.template_id))
        .leftJoin(events, eq(events.id, checklistInstances.event_id))
        .where(and(
          inArray(checklistInstanceApprovals.stage_code, myRoleStages),
          eq(checklistInstanceApprovals.status, "pending"),
          eq(checklistInstances.status, "awaiting_review"),
          isNull(checklistInstances.deleted_at),
        ))
        .orderBy(asc(checklistInstances.submitted_at))
        .limit(10)
      : Promise.resolve([] as any[]);

    // ─── Committee chairman: events for THEIR committees ───────────────
    const myCommitteeEventsP = (variant === "committee_chairman" && committeeChairOf.length > 0)
      ? db.select({
          id: events.id, slug: events.slug, title: events.title,
          starts_at: events.starts_at, status: events.status,
          registered_count: events.registered_count, capacity: events.capacity,
          committee_id: events.committee_id,
          committee_name: committees.name,
        })
        .from(events)
        .leftJoin(committees, eq(committees.id, events.committee_id))
        .where(and(
          inArray(events.committee_id, committeeChairOf),
          isNull(events.deleted_at),
          gt(events.starts_at, now),
        ))
        .orderBy(asc(events.starts_at))
        .limit(8)
      : Promise.resolve([] as any[]);

    // ─── Treasurer / accountant: pending bills ──────────────────────────
    // Accountant sees bills awaiting them to draft/submit; treasurer sees
    // bills awaiting approval. We split by `status`. Sysadmin used to be
    // included here too, but SysAdminHome doesn't render bills/refunds/
    // IUTs anywhere — admin opens those panels directly via /admin/bills
    // etc., so loading them upfront is wasted I/O.
    const wantsBills = variant === "treasurer" || variant === "accountant";
    const pendingBillsP = wantsBills
      ? db.select({
          id: bills.id, vendor_name: bills.vendor_name, description: bills.description,
          amount_paise: bills.amount_paise, bill_date: bills.bill_date, status: bills.status,
          submitted_at: bills.submitted_at, event_id: bills.event_id,
        })
        .from(bills)
        .where(and(
          isNull(bills.deleted_at),
          variant === "accountant"
            ? eq(bills.status, "draft")
            : eq(bills.status, "submitted"),
        ))
        .orderBy(desc(bills.created_at))
        .limit(10)
      : Promise.resolve([] as any[]);

    // ─── Treasurer: pending refunds + pending IUTs ──────────────────────
    // Sysadmin variant intentionally omitted — see comment on wantsBills.
    const wantsTreasurerLists = variant === "treasurer";
    const pendingRefundsP = wantsTreasurerLists
      ? db.select({
          id: paymentRefunds.id, amount_paise: paymentRefunds.amount_paise,
          reason: paymentRefunds.reason, requested_at: paymentRefunds.requested_at,
          payer_name: users.name,
        })
        .from(paymentRefunds)
        .leftJoin(users, eq(users.id, paymentRefunds.requested_by))
        .where(eq(paymentRefunds.status, "requested"))
        .orderBy(asc(paymentRefunds.requested_at))
        .limit(10)
      : Promise.resolve([] as any[]);

    const pendingIutsP = wantsTreasurerLists
      ? db.select({
          id: iutTransfers.id, amount_paise: iutTransfers.amount_paise,
          purpose: iutTransfers.purpose, transfer_date: iutTransfers.transfer_date,
          from_account: iutTransfers.from_account, to_account: iutTransfers.to_account,
          requested_at: iutTransfers.requested_at,
        })
        .from(iutTransfers)
        .where(eq(iutTransfers.status, "requested"))
        .orderBy(asc(iutTransfers.requested_at))
        .limit(10)
      : Promise.resolve([] as any[]);

    // ─── Treasurer: revenue by month (last 12 months) ───────────────────
    const revenueByMonthP = wantsTreasurerLists
      ? (async () => {
          const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
          const monthEnd   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
          const raw = await getMonthlyRevenue(monthStart, monthEnd);
          return fillMissingMonths(raw, monthStart, monthEnd);
        })()
      : Promise.resolve([] as any[]);

    // ─── Treasurer: CABF stats ──────────────────────────────────────────
    const cabfStatsP = wantsTreasurerLists
      ? getCabfStats()
      : Promise.resolve(null as any);

    // ─── WICASA: upcoming mock tests + mentorship + matchmaking ─────────
    // Same trim as treasurer/bills: sysadmin doesn't show WICASA panels.
    const upcomingMockTestsP = variant === "wicasa"
      ? db.select({
          id: mockTests.id, title: mockTests.title, series_name: mockTests.series_name,
          level: mockTests.level, scheduled_at: mockTests.scheduled_at,
          venue: mockTests.venue, capacity: mockTests.capacity, status: mockTests.status,
        })
        .from(mockTests)
        .where(and(
          isNull(mockTests.deleted_at),
          gt(mockTests.scheduled_at, now),
        ))
        .orderBy(asc(mockTests.scheduled_at))
        .limit(6)
      : Promise.resolve([] as any[]);

    const pendingMentorshipP = variant === "wicasa"
      ? (() => {
          const studentU = aliasedTable(users, "student_u");
          return db.select({
            id: mentorshipRequests.id, topic: mentorshipRequests.topic,
            preferred_window: mentorshipRequests.preferred_window,
            created_at: mentorshipRequests.created_at,
            student_name: studentU.name,
          })
          .from(mentorshipRequests)
          .leftJoin(studentU, eq(studentU.id, mentorshipRequests.student_user_id))
          .where(eq(mentorshipRequests.status, "pending"))
          .orderBy(asc(mentorshipRequests.created_at))
          .limit(8);
        })()
      : Promise.resolve([] as any[]);

    const pendingMatchesP = variant === "wicasa"
      ? db.select({
          id: articleshipMatches.id, status: articleshipMatches.status,
          preferred_location: articleshipMatches.preferred_location,
          preferred_firm_size: articleshipMatches.preferred_firm_size,
          created_at: articleshipMatches.created_at,
          student_name: users.name,
        })
        .from(articleshipMatches)
        .leftJoin(users, eq(users.id, articleshipMatches.student_user_id))
        .where(eq(articleshipMatches.status, "submitted"))
        .orderBy(asc(articleshipMatches.created_at))
        .limit(8)
      : Promise.resolve([] as any[]);

    // ─── Headline stats (always cheap) ──────────────────────────────────
    const upcomingCountP = db.select({ c: sql<number>`count(*)::int` })
      .from(events)
      .where(and(
        eq(events.status, "published"),
        gt(events.starts_at, now),
        isNull(events.deleted_at),
      ));

    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const nextMonth  = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));

    const eventsThisMonthP = db.select({ c: sql<number>`count(*)::int` })
      .from(events)
      .where(and(
        gte(events.starts_at, monthStart),
        lt(events.starts_at, nextMonth),
        isNull(events.deleted_at),
      ));

    const regsThisMonthP = db.select({ c: sql<number>`count(*)::int` })
      .from(eventRegistrations)
      .where(and(
        gte(eventRegistrations.registered_at, monthStart),
        lt(eventRegistrations.registered_at, nextMonth),
        isNull(eventRegistrations.deleted_at),
      ));

    // Members + students in a single users-table scan — saves a round-trip
    // versus the two-query version we used to run.
    const userCountsP = db.select({
      members:  sql<number>`count(*) filter (where ${users.primary_role} = 'member')::int`.as("members"),
      students: sql<number>`count(*) filter (where ${users.primary_role} = 'student')::int`.as("students"),
    })
      .from(users)
      .where(isNull(users.deleted_at));

    // Revenue: chairman + treasurer need this for their hero strip; sysadmin
    // doesn't display it and accountant doesn't either, so they skip the
    // (relatively expensive) revenue aggregation entirely.
    const revenueMonthP = wantsTreasurerLists || variant === "chairman"
      ? getCurrentMonthRevenuePaise()
      : Promise.resolve(0);

    const refundsPendingP = wantsTreasurerLists
      ? db.select({ c: count() }).from(paymentRefunds).where(eq(paymentRefunds.status, "requested"))
      : Promise.resolve([{ c: 0 }] as any[]);

    const billsPendingApprovalP = wantsTreasurerLists
      ? db.select({ c: count() }).from(bills).where(and(eq(bills.status, "submitted"), isNull(bills.deleted_at)))
      : Promise.resolve([{ c: 0 }] as any[]);

    const billsPendingRecordP = variant === "accountant"
      ? db.select({ c: count() }).from(bills).where(and(eq(bills.status, "draft"), isNull(bills.deleted_at)))
      : Promise.resolve([{ c: 0 }] as any[]);

    const [
      pendingEvents,
      myReviewQueue,
      myFillQueue,
      myStageQueue,
      myCommitteeEvents,
      pendingBills,
      pendingRefunds,
      pendingIuts,
      revenueByMonth,
      cabfStats,
      upcomingMockTests,
      pendingMentorship,
      pendingMatches,
      [{ c: upcomingCount }],
      [{ c: eventsThisMonth }],
      [{ c: regsThisMonth }],
      [userCounts],
      revenueMonthPaise,
      [{ c: refundsPending }],
      [{ c: billsPendingApproval }],
      [{ c: billsPendingRecord }],
    ] = await Promise.all([
      pendingEventsP,
      myReviewQueueP,
      myFillQueueP,
      myStageQueueP,
      myCommitteeEventsP,
      pendingBillsP,
      pendingRefundsP,
      pendingIutsP,
      revenueByMonthP,
      cabfStatsP,
      upcomingMockTestsP,
      pendingMentorshipP,
      pendingMatchesP,
      upcomingCountP,
      eventsThisMonthP,
      regsThisMonthP,
      userCountsP,
      revenueMonthP,
      refundsPendingP,
      billsPendingApprovalP,
      billsPendingRecordP,
    ]);

    // ─── Compose the inbox ─────────────────────────────────────────────
    // Each variant gets a curated inbox of the things it most needs to act
    // on. We keep the generic `inbox` for backwards-compat; specialised
    // lists live in `lists`.
    const inbox: Array<{
      id: string;
      kind: string;
      title: string;
      subtitle?: string;
      pending_since?: string;
      action_label: string;
      action_href: string;
    }> = [];

    for (const e of pendingEvents) {
      inbox.push({
        id:            `event:${e.id}`,
        kind:          "event_approval",
        title:         e.title,
        subtitle:      `${e.committee_name ?? "—"} · ${new Date(e.starts_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`,
        pending_since: e.starts_at instanceof Date ? e.starts_at.toISOString() : String(e.starts_at),
        action_label:  "Review & approve",
        action_href:   `/admin/events?edit=${e.id}`,
      });
    }
    for (const c of myReviewQueue) {
      inbox.push({
        id:            `checklist:${c.id}`,
        kind:          "checklist_review",
        title:         c.title,
        subtitle:      c.template_name ?? "Checklist",
        pending_since: c.submitted_at?.toISOString?.() ?? c.updated_at?.toISOString?.(),
        action_label:  "Review",
        action_href:   `/my-checklists`,
      });
    }
    // Checklists assigned to THIS user to fill (committee chairmen + anyone
    // else who's the named filler on a released instance). Distinct from the
    // review queue above — the filler isn't reviewing, they're answering the
    // questions before submitting for review.
    for (const c of myFillQueue) {
      inbox.push({
        id:            `checklist:fill:${c.id}`,
        kind:          "checklist_fill",
        title:         c.event_title ?? c.title,
        subtitle:      c.template_name ?? "Checklist",
        pending_since: c.updated_at?.toISOString?.(),
        action_label:  "Fill checklist",
        action_href:   `/my-checklists?id=${c.id}`,
      });
    }
    // Multi-stage approval rows where the viewer owns the stage. For the
    // treasurer this is the "IUT / budget review" stage on any event-bound
    // checklist that's awaiting review; for the chairman the overall
    // stage; for the VC the agenda stage.
    for (const s of myStageQueue) {
      // Skip if we already have this instance in the legacy queue (a single
      // checklist shouldn't appear twice in one inbox).
      if (myReviewQueue.some((r: any) => r.id === s.instance_id)) continue;
      inbox.push({
        id:            `stage:${s.stage_id}`,
        kind:          "checklist_stage",
        title:         s.event_title ?? s.title,
        subtitle:      s.stage_label,
        pending_since: s.submitted_at?.toISOString?.() ?? s.updated_at?.toISOString?.(),
        action_label:  "Review",
        action_href:   `/my-checklists?id=${s.instance_id}`,
      });
    }
    // Treasurer also wants refunds + bills + IUTs in their inbox
    if (variant === "treasurer" || variant === "sysadmin") {
      for (const r of pendingRefunds) {
        inbox.push({
          id:            `refund:${r.id}`,
          kind:          "refund_approval",
          title:         `Refund · ₹${(r.amount_paise / 100).toLocaleString("en-IN")}`,
          subtitle:      r.payer_name ? `Requested by ${r.payer_name}` : r.reason,
          pending_since: r.requested_at?.toISOString?.(),
          action_label:  "Review",
          action_href:   `/admin/refunds?id=${r.id}`,
        });
      }
      for (const b of pendingBills) {
        if (b.status !== "submitted") continue;
        inbox.push({
          id:            `bill:${b.id}`,
          kind:          "bill_approval",
          title:         `${b.vendor_name} · ₹${(b.amount_paise / 100).toLocaleString("en-IN")}`,
          subtitle:      b.description ?? undefined,
          pending_since: b.submitted_at?.toISOString?.(),
          action_label:  "Review",
          action_href:   `/admin/bills?id=${b.id}`,
        });
      }
      for (const i of pendingIuts) {
        inbox.push({
          id:            `iut:${i.id}`,
          kind:          "iut_approval",
          title:         `IUT · ${i.from_account} → ${i.to_account}`,
          subtitle:      `₹${(i.amount_paise / 100).toLocaleString("en-IN")} · ${i.purpose}`,
          pending_since: i.requested_at?.toISOString?.(),
          action_label:  "Review",
          action_href:   `/admin/iut-transfers?id=${i.id}`,
        });
      }
    }
    // Accountant: drafts the user owns
    if (variant === "accountant") {
      for (const b of pendingBills) {
        if (b.status !== "draft") continue;
        inbox.push({
          id:            `bill:${b.id}`,
          kind:          "bill_draft",
          title:         `${b.vendor_name} · ₹${(b.amount_paise / 100).toLocaleString("en-IN")}`,
          subtitle:      "Draft — needs submission",
          action_label:  "Edit",
          action_href:   `/admin/bills?id=${b.id}`,
        });
      }
    }
    // WICASA inbox: pending mentorship requests + articleship submissions
    if (variant === "wicasa") {
      for (const m of pendingMentorship) {
        inbox.push({
          id:            `mentorship:${m.id}`,
          kind:          "mentorship_request",
          title:         `Mentorship · ${m.topic}`,
          subtitle:      m.student_name ? `From ${m.student_name}` : undefined,
          pending_since: m.created_at?.toISOString?.(),
          action_label:  "Assign mentor",
          action_href:   `/admin/mentorship?id=${m.id}`,
        });
      }
      for (const am of pendingMatches) {
        inbox.push({
          id:            `articleship:${am.id}`,
          kind:          "articleship_match",
          title:         `Articleship submission`,
          subtitle:      `${am.student_name ?? "Student"} · ${am.preferred_location ?? "Any location"}`,
          pending_since: am.created_at?.toISOString?.(),
          action_label:  "Recommend firms",
          action_href:   `/admin/articleship-matches?id=${am.id}`,
        });
      }
    }

    const body = {
      variant,
      roles: {
        is_admin:              perms.isAdmin,
        is_branch_chairman:    isChairman,
        is_vice_chairman:      isVice,
        is_secretary:          isSecretary,
        is_treasurer:          isTreasurer,
        is_accountant:         isAccountant,
        is_wicasa:             isWicasa,
        committee_chairman_of: committeeChairOf,
      },
      inbox,
      lists: {
        my_committee_events: myCommitteeEvents,
        pending_refunds:     pendingRefunds,
        pending_bills:       pendingBills,
        pending_iuts:        pendingIuts,
        revenue_by_month:    revenueByMonth,
        upcoming_mock_tests: upcomingMockTests,
        pending_mentorship:  pendingMentorship,
        pending_articleship_matches: pendingMatches,
      },
      stats: {
        upcoming_events:         upcomingCount,
        registrations_month:     regsThisMonth,
        events_this_month:       eventsThisMonth,
        members:                 userCounts.members,
        students:                userCounts.students,
        inbox_count:             inbox.length,
        revenue_month_paise:     revenueMonthPaise,
        refunds_pending:         refundsPending,
        bills_pending_approval:  billsPendingApproval,
        bills_pending_record:    billsPendingRecord,
        cabf_receipts_month_paise: cabfStats?.receipts_this_month_paise ?? 0,
        cabf_receipts_month_count: cabfStats?.receipts_this_month_count ?? 0,
        cabf_requests_pending:   (cabfStats?.requests_pending_review ?? 0) + (cabfStats?.requests_pending_disbursement ?? 0),
      },
    };
    homeCacheSet(user.id, codesKey, body);
    res.set("cache-control", "private, max-age=30");
    res.json(body);
  } catch (err) { next(err); }
});
