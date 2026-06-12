import { Router } from "express";
import { and, asc, desc, eq, gt, gte, isNotNull, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Response, NextFunction } from "express";
import { db } from "../../db/client.js";
import {
  events, eventRegistrations, users, committees,
  userRoleAssignments, roles, checklistInstances,
} from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { loadUserPermissions } from "../auth/permissions.js";
import { ApiError, handleApiError, trim } from "../lib/apiError.js";

export const branchRouter = Router();
branchRouter.use(requireUser);

// Gate every endpoint behind branch_chairman OR admin.
async function requireBranchAccess(req: AuthedRequest, res: Response, next: NextFunction) {
  const p = await loadUserPermissions(req.user!.id);
  if (!p.isBranchChairman && !p.isAdmin) return res.status(403).json({ error: "forbidden" });
  next();
}

// Parse "YYYY-MM-DD" into a Date (start-of-day UTC). Returns null on bad input.
function parseDate(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

// â”€â”€â”€ GET /api/branch/metrics â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns everything the branch chairman dashboard needs in one shot.
// Query params:
//   from, to (YYYY-MM-DD) â€” scope events/registrations/signups
//   committee_id          â€” filter to one committee
branchRouter.get("/metrics", requireBranchAccess, async (req, res, next) => {
  try {
    const from = parseDate(trim(req.query.from));
    const to   = parseDate(trim(req.query.to));
    const committeeId = trim(req.query.committee_id);

    // Build common condition fragments
    const evDateConds = [isNull(events.deleted_at)];
    if (from) evDateConds.push(gte(events.starts_at, from));
    if (to)   evDateConds.push(lte(events.starts_at, to));
    if (committeeId) evDateConds.push(eq(events.committee_id, committeeId));

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfYear  = new Date(now.getFullYear(), 0, 1);
    const next30Days   = new Date(now.getTime() + 30 * 86_400_000);

    // â”€â”€â”€ KPIs (fan-out, then await) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const [
      eventsTotal, eventsThisMonth, eventsThisYear, eventsUpcoming,
      eventsByStatus,
      regsTotal, regsAttended, regsThisMonth,
      usersByRole, usersNewThisMonth,
      activeMcmCount, activeCommitteeChairCount, activeCommitteesCount,
      pendingApprovals, approvedThisMonth,
      avgCycleHours,
      byCommittee, eventsPerMonth, regsPerMonth,
      recentEvents, pendingApprovalsList,
    ] = await Promise.all([
      // Events totals
      db.select({ n: sql<number>`count(*)::int`.as("n") }).from(events).where(and(...evDateConds)).then((r) => r[0]?.n ?? 0),
      db.select({ n: sql<number>`count(*)::int`.as("n") }).from(events).where(and(isNull(events.deleted_at), gte(events.starts_at, startOfMonth))).then((r) => r[0]?.n ?? 0),
      db.select({ n: sql<number>`count(*)::int`.as("n") }).from(events).where(and(isNull(events.deleted_at), gte(events.starts_at, startOfYear))).then((r) => r[0]?.n ?? 0),
      db.select({ n: sql<number>`count(*)::int`.as("n") }).from(events).where(and(isNull(events.deleted_at), gte(events.starts_at, now), lte(events.starts_at, next30Days), eq(events.status, "published"))).then((r) => r[0]?.n ?? 0),

      // Events by status (current snapshot, ignoring date filter)
      db
        .select({ status: events.status, n: sql<number>`count(*)::int`.as("n") })
        .from(events)
        .where(isNull(events.deleted_at))
        .groupBy(events.status),

      // Registrations totals
      db
        .select({ n: sql<number>`count(*)::int`.as("n") })
        .from(eventRegistrations)
        .where(isNull(eventRegistrations.deleted_at))
        .then((r) => r[0]?.n ?? 0),

      // For attendance rate: attended / (attended + no_show)
      db
        .select({ n: sql<number>`count(*)::int`.as("n") })
        .from(eventRegistrations)
        .where(and(isNull(eventRegistrations.deleted_at), eq(eventRegistrations.status, "attended")))
        .then((r) => r[0]?.n ?? 0),

      db
        .select({ n: sql<number>`count(*)::int`.as("n") })
        .from(eventRegistrations)
        .where(and(isNull(eventRegistrations.deleted_at), gte(eventRegistrations.registered_at, startOfMonth)))
        .then((r) => r[0]?.n ?? 0),

      // Users by primary_role
      db
        .select({ primary_role: users.primary_role, n: sql<number>`count(*)::int`.as("n") })
        .from(users)
        .where(isNull(users.deleted_at))
        .groupBy(users.primary_role),

      db
        .select({ n: sql<number>`count(*)::int`.as("n") })
        .from(users)
        .where(and(isNull(users.deleted_at), gte(users.created_at, startOfMonth)))
        .then((r) => r[0]?.n ?? 0),

      // Active MCMs / committee chairmen / active committees
      db
        .select({ n: sql<number>`count(distinct ${userRoleAssignments.user_id})::int`.as("n") })
        .from(userRoleAssignments)
        .innerJoin(roles, eq(roles.id, userRoleAssignments.role_id))
        .where(and(
          eq(roles.code, "mcm"),
          or(isNull(userRoleAssignments.effective_to), gte(userRoleAssignments.effective_to, new Date().toISOString().slice(0, 10))),
        ))
        .then((r) => r[0]?.n ?? 0),

      db
        .select({ n: sql<number>`count(distinct ${userRoleAssignments.user_id})::int`.as("n") })
        .from(userRoleAssignments)
        .innerJoin(roles, eq(roles.id, userRoleAssignments.role_id))
        .where(and(
          eq(roles.code, "committee_chairman"),
          or(isNull(userRoleAssignments.effective_to), gte(userRoleAssignments.effective_to, new Date().toISOString().slice(0, 10))),
        ))
        .then((r) => r[0]?.n ?? 0),

      db
        .select({ n: sql<number>`count(*)::int`.as("n") })
        .from(committees)
        .where(eq(committees.active, true))
        .then((r) => r[0]?.n ?? 0),

      // Approvals — read from the generic checklist_instances engine.
      db
        .select({ n: sql<number>`count(*)::int`.as("n") })
        .from(checklistInstances)
        .where(and(eq(checklistInstances.status, "awaiting_review"), isNull(checklistInstances.deleted_at)))
        .then((r) => r[0]?.n ?? 0),

      db
        .select({ n: sql<number>`count(*)::int`.as("n") })
        .from(checklistInstances)
        .where(and(
          eq(checklistInstances.status, "approved"),
          gte(checklistInstances.reviewed_at, startOfMonth),
          isNull(checklistInstances.deleted_at),
        ))
        .then((r) => r[0]?.n ?? 0),

      // Average approval cycle time (hours) — created → reviewed, only for approved
      db
        .select({
          avg_hours: sql<number>`COALESCE(EXTRACT(EPOCH FROM AVG(${checklistInstances.reviewed_at} - ${checklistInstances.created_at})) / 3600, 0)::float`.as("avg_hours"),
        })
        .from(checklistInstances)
        .where(and(
          eq(checklistInstances.status, "approved"),
          isNotNull(checklistInstances.reviewed_at),
          isNull(checklistInstances.deleted_at),
        ))
        .then((r) => r[0]?.avg_hours ?? 0),

      // Per-committee breakdown: events count + registrations count
      db
        .select({
          committee_id: committees.id,
          committee_code: committees.code,
          committee_name: committees.name,
          events_count: sql<number>`COUNT(DISTINCT ${events.id})::int`.as("events_count"),
          registrations_count: sql<number>`COUNT(${eventRegistrations.id})::int`.as("registrations_count"),
        })
        .from(committees)
        .leftJoin(events, and(eq(events.committee_id, committees.id), isNull(events.deleted_at)))
        .leftJoin(eventRegistrations, and(eq(eventRegistrations.event_id, events.id), isNull(eventRegistrations.deleted_at)))
        .where(eq(committees.active, true))
        .groupBy(committees.id, committees.code, committees.name)
        .orderBy(desc(sql`COUNT(DISTINCT ${events.id})`)),

      // Events per month (last 12 months)
      db.execute(sql`
        SELECT
          to_char(date_trunc('month', starts_at), 'YYYY-MM') AS month,
          COUNT(*)::int AS n
        FROM events
        WHERE deleted_at IS NULL
          AND starts_at >= now() - interval '12 months'
        GROUP BY 1
        ORDER BY 1
      `),

      // Registrations per month (last 12 months)
      db.execute(sql`
        SELECT
          to_char(date_trunc('month', registered_at), 'YYYY-MM') AS month,
          COUNT(*)::int AS n
        FROM event_registrations
        WHERE deleted_at IS NULL
          AND registered_at >= now() - interval '12 months'
        GROUP BY 1
        ORDER BY 1
      `),

      // Recent events (last 10 by start time, respecting filters)
      db
        .select({
          id: events.id,
          title: events.title,
          starts_at: events.starts_at,
          status: events.status,
          committee_code: committees.code,
          committee_name: committees.name,
          registered_count: events.registered_count,
          capacity: events.capacity,
        })
        .from(events)
        .leftJoin(committees, eq(committees.id, events.committee_id))
        .where(and(...evDateConds))
        .orderBy(desc(events.starts_at))
        .limit(10),

      // Pending approvals list (top 5 oldest) — from checklist_instances
      db
        .select({
          id: checklistInstances.id,
          event_id: checklistInstances.event_id,
          event_title: events.title,
          committee_code: committees.code,
          committee_name: committees.name,
          updated_at: checklistInstances.updated_at,
        })
        .from(checklistInstances)
        .innerJoin(events, eq(events.id, checklistInstances.event_id))
        .leftJoin(committees, eq(committees.id, events.committee_id))
        .where(and(
          eq(checklistInstances.status, "awaiting_review"),
          isNull(checklistInstances.deleted_at),
        ))
        .orderBy(asc(checklistInstances.updated_at))
        .limit(5),
    ]);

    // Attendance rate
    const regsNoShow = await db
      .select({ n: sql<number>`count(*)::int`.as("n") })
      .from(eventRegistrations)
      .where(and(isNull(eventRegistrations.deleted_at), eq(eventRegistrations.status, "no_show")))
      .then((r) => r[0]?.n ?? 0);
    const concluded = regsAttended + regsNoShow;
    const attendanceRate = concluded > 0 ? regsAttended / concluded : null;

    res.json({
      kpis: {
        events: {
          total: eventsTotal,
          this_month: eventsThisMonth,
          this_year: eventsThisYear,
          upcoming_30d: eventsUpcoming,
          by_status: Object.fromEntries(eventsByStatus.map((r) => [r.status, r.n])),
        },
        registrations: {
          total: regsTotal,
          attended: regsAttended,
          this_month: regsThisMonth,
          attendance_rate: attendanceRate,
        },
        users: {
          total: usersByRole.reduce((s, r) => s + r.n, 0),
          by_primary_role: Object.fromEntries(usersByRole.map((r) => [r.primary_role, r.n])),
          new_this_month: usersNewThisMonth,
        },
        people: {
          active_mcm: activeMcmCount,
          active_committee_chair: activeCommitteeChairCount,
          active_committees: activeCommitteesCount,
        },
        approvals: {
          pending: pendingApprovals,
          approved_this_month: approvedThisMonth,
          avg_cycle_hours: Math.round(avgCycleHours * 10) / 10,
        },
      },
      by_committee: byCommittee,
      events_per_month: Array.from(eventsPerMonth),
      registrations_per_month: Array.from(regsPerMonth),
      recent_events: recentEvents.map((r) => ({
        ...r,
        banner_url: null,
      })),
      pending_approvals: pendingApprovalsList,
      filters_applied: { from: from?.toISOString() ?? null, to: to?.toISOString() ?? null, committee_id: committeeId || null },
    });
  } catch (err) { handleApiError(err, res, next); }
});
