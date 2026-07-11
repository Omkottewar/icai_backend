// ─── /api/admin/reports/* ────────────────────────────────────────────────
// Formatted XLSX exports for branch office / treasurer / committee use.
//
// Every endpoint returns an Excel workbook (not raw CSV) with a styled
// title bar, filter breadcrumb, frozen header row, zebra-striped body,
// currency-formatted amounts, and a totals footer where applicable.
// See lib/reportsXlsx.ts for the shared builder.
//
// Filenames encode the filter context (e.g. `event-registrations-<slug>-2026-11-30.xlsx`)
// so downloaded files stay identifiable on the treasurer's desktop.
//
// Auth: mounted under adminRouter — every request is already gated by
// requireUser + requireAdmin from parent middleware.

import { Router } from "express";
import { and, asc, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../../db/client.js";
import {
  events, eventRegistrations, payments, users, memberProfiles,
  committees, budgets, bills, expenseCategories, branches,
} from "../../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { sendReport } from "../../lib/reportsXlsx.js";

export const reportsAdminRouter = Router();

// ─── 1. Event registrations roster ───────────────────────────────────────
// /api/admin/reports/event-registrations.xlsx?event_id=<uuid>
//
// Attendance sheet for a single event — printed on paper on event day so
// front desk can tick names as attendees arrive. Includes every seat
// (self + group-booked), the booker's name for guest seats, seat count
// summary and paid amount so the treasurer can also use this file for
// post-event reconciliation.
reportsAdminRouter.get("/event-registrations.xlsx", async (req, res, next) => {
  try {
    const eventId = need(trim(req.query.event_id), "event_id");

    const [event] = await db
      .select({ id: events.id, title: events.title, slug: events.slug, starts_at: events.starts_at, venue: events.venue })
      .from(events)
      .where(and(eq(events.id, eventId), isNull(events.deleted_at)))
      .limit(1);
    if (!event) throw new ApiError(404, "Event not found");

    const booker = alias(users, "booker");
    const rows = await db
      .select({
        name:            users.name,
        mrn:             memberProfiles.mrn,
        email:           users.email,
        phone:           users.phone,
        status:          eventRegistrations.status,
        booked_by:       booker.name,
        registered_at:   eventRegistrations.registered_at,
        attended_at:     eventRegistrations.attended_at,
        // Per-seat share of the payment total. For a solo booking this is
        // the full payment; for a group booking we divide by seat_count so
        // each seat shows its own cost and the TOTAL row still adds up to
        // the actual revenue collected (not seat_count × payment).
        // Old rows without seat_count in metadata fall back to 1 seat.
        seat_amount:     sql<number>`${payments.amount_paise} / coalesce(nullif((${payments.metadata}->>'seat_count')::int, 0), 1)`,
        // UTR belongs to a single UPI transaction — showing it on every
        // seat implies each seat had its own payment. Only stamp it on
        // the booker's row (booked_by_user_id IS NULL) so guest rows are
        // visibly blank.
        upi_utr:         sql<string | null>`case when ${eventRegistrations.booked_by_user_id} is null then ${payments.upi_utr} else null end`,
      })
      .from(eventRegistrations)
      .innerJoin(users, eq(users.id, eventRegistrations.user_id))
      .leftJoin(memberProfiles, eq(memberProfiles.user_id, users.id))
      .leftJoin(booker, eq(booker.id, eventRegistrations.booked_by_user_id))
      .leftJoin(payments, eq(payments.id, eventRegistrations.payment_id))
      .where(and(
        eq(eventRegistrations.event_id, eventId),
        isNull(eventRegistrations.deleted_at),
      ))
      .orderBy(asc(users.name));

    const startsIso = event.starts_at ? new Date(event.starts_at).toISOString().slice(0, 10) : "";
    const slugSafe = (event.slug || "event").replace(/[^a-z0-9-]/gi, "-");

    await sendReport(res, {
      filename: `event-registrations-${slugSafe}-${startsIso}`,
      title:    `Event Registrations — ${event.title}`,
      subtitle: `${startsIso}${event.venue ? " · " + event.venue : ""} · ${rows.length} seat(s)`,
      sheetName: "Registrations",
      showTotals: true,
      columns: [
        { header: "Name",            key: "name",           kind: "text",     width: 26 },
        { header: "MRN",             key: "mrn",            kind: "text",     width: 12 },
        { header: "Email",           key: "email",          kind: "text",     width: 28 },
        { header: "Phone",           key: "phone",          kind: "text",     width: 15 },
        { header: "Status",          key: "status",         kind: "text",     width: 13 },
        { header: "Booked by",       key: "booked_by",      kind: "text",     width: 22 },
        { header: "Registered at",   key: "registered_at",  kind: "datetime" },
        { header: "Attended at",     key: "attended_at",    kind: "datetime" },
        { header: "Seat amount",     key: "seat_amount",    kind: "currency" },
        { header: "UTR (booker)",    key: "upi_utr",        kind: "text",     width: 18 },
      ],
      rows,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── 2. Payments ledger ──────────────────────────────────────────────────
// /api/admin/reports/payments-ledger.xlsx?from=<yyyy-mm-dd>&to=<yyyy-mm-dd>&status=&purpose=
//
// Every payment row within the window, with GST split and refund totals.
// The statutory audit demands this ledger; it's also the treasurer's
// single source of truth for reconciling against the bank statement.
reportsAdminRouter.get("/payments-ledger.xlsx", async (req, res, next) => {
  try {
    const from = trim(req.query.from);
    const to   = trim(req.query.to);
    const status = trim(req.query.status);
    const purpose = trim(req.query.purpose);

    const conds: any[] = [isNull(payments.deleted_at)];
    if (from) conds.push(gte(payments.created_at, new Date(from)));
    if (to) {
      const toDate = new Date(to);
      toDate.setDate(toDate.getDate() + 1);
      conds.push(lt(payments.created_at, toDate));
    }
    if (status)  conds.push(eq(payments.status, status as any));
    if (purpose) conds.push(eq(payments.purpose, purpose as any));

    const rows = await db
      .select({
        created_at:   payments.created_at,
        payer:        users.name,
        payer_email:  users.email,
        mrn:          memberProfiles.mrn,
        purpose:      payments.purpose,
        status:       payments.status,
        amount_paise: payments.amount_paise,
        base_paise:   sql<number>`coalesce((${payments.metadata}->>'base_paise')::int, 0)`,
        gst_paise:    sql<number>`coalesce((${payments.metadata}->>'gst_paise')::int, 0)`,
        upi_utr:      payments.upi_utr,
        razorpay_id:  payments.razorpay_payment_id,
        verified_at:  payments.verified_at,
        event_title:  sql<string>`coalesce((${payments.metadata}->>'event_title'), '')`,
      })
      .from(payments)
      .leftJoin(users, eq(users.id, payments.payer_user_id))
      .leftJoin(memberProfiles, eq(memberProfiles.user_id, users.id))
      .where(and(...conds))
      .orderBy(desc(payments.created_at));

    const filterParts = [
      from || to ? `${from || "start"} → ${to || "today"}` : "all time",
      status  ? `status: ${status}`  : null,
      purpose ? `purpose: ${purpose}` : null,
    ].filter(Boolean);

    await sendReport(res, {
      filename: `payments-ledger-${from || "all"}-to-${to || "today"}`,
      title:    "Payments Ledger",
      subtitle: filterParts.join(" · "),
      sheetName: "Payments",
      showTotals: true,
      columns: [
        { header: "Date",         key: "created_at",   kind: "datetime" },
        { header: "Payer",        key: "payer",        kind: "text", width: 24 },
        { header: "MRN",          key: "mrn",          kind: "text", width: 12 },
        { header: "Email",        key: "payer_email",  kind: "text", width: 28 },
        { header: "Purpose",      key: "purpose",      kind: "text", width: 18 },
        { header: "Event",        key: "event_title",  kind: "text", width: 28 },
        { header: "Status",       key: "status",       kind: "text", width: 15 },
        { header: "Base amount",  key: "base_paise",   kind: "currency" },
        { header: "GST",          key: "gst_paise",    kind: "currency" },
        { header: "Total",        key: "amount_paise", kind: "currency" },
        { header: "UTR / RZP",    key: "upi_utr",      kind: "text", width: 20 },
        { header: "Verified at",  key: "verified_at",  kind: "datetime" },
      ],
      rows,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── 3. Budget vs actual (by committee × category) ───────────────────────
// /api/admin/reports/budget-vs-actual.xlsx?fy=<start_year>
//
// One row per (committee, category) with planned amount, actual spend
// (from `bills` in status='paid' or 'approved'), variance, and
// utilisation %. Uncategorised spend (budget row missing) surfaces at
// the bottom so the treasurer sees the leak.
reportsAdminRouter.get("/budget-vs-actual.xlsx", async (req, res, next) => {
  try {
    const fy = Number(req.query.fy);
    if (!Number.isInteger(fy) || fy < 2020 || fy > 2100) {
      throw new ApiError(400, "fy is required (start year, e.g. 2026 for FY 2026-27)");
    }
    const fyStart = new Date(Date.UTC(fy, 3, 1));            // 1 Apr FY
    const fyEnd   = new Date(Date.UTC(fy + 1, 3, 1));        // 1 Apr FY+1

    // Planned rows for the FY, one row per (committee?, category).
    const plannedRows = await db
      .select({
        committee_id:   budgets.committee_id,
        committee_name: committees.name,
        category_id:    budgets.category_id,
        category_label: expenseCategories.label,
        planned_paise:  budgets.planned_paise,
      })
      .from(budgets)
      .leftJoin(committees, eq(committees.id, budgets.committee_id))
      .innerJoin(expenseCategories, eq(expenseCategories.id, budgets.category_id))
      .where(eq(budgets.fy_start_year, fy))
      .orderBy(asc(expenseCategories.sort_order));

    // Actual spend — approved/paid bills in FY window, grouped the same way.
    const actualRows = await db
      .select({
        committee_id:  bills.committee_id,
        category_id:   bills.category_id,
        actual_paise:  sql<number>`coalesce(sum(${bills.amount_paise}), 0)::int`.as("actual_paise"),
        bill_count:    sql<number>`count(*)::int`.as("bill_count"),
      })
      .from(bills)
      .where(and(
        isNull(bills.deleted_at),
        sql`${bills.status} in ('approved', 'paid')`,
        gte(bills.bill_date, fyStart.toISOString().slice(0, 10)),
        lt(bills.bill_date, fyEnd.toISOString().slice(0, 10)),
      ))
      .groupBy(bills.committee_id, bills.category_id);

    // Merge planned + actual by (committee_id, category_id). Also collect
    // any (c, cat) pair that has actuals but no plan → uncategorised.
    const key = (a: string | null, b: string | null) => `${a ?? "-"}|${b ?? "-"}`;
    const actualMap = new Map(actualRows.map((r) => [key(r.committee_id, r.category_id), r]));

    // Fetch names for actuals-only rows so we can render them nicely.
    const orphanIds = actualRows.filter((r) => {
      return !plannedRows.some((p) => p.committee_id === r.committee_id && p.category_id === r.category_id);
    });
    const orphanCommitteeIds = Array.from(new Set(orphanIds.map((r) => r.committee_id).filter(Boolean))) as string[];
    const orphanCategoryIds  = Array.from(new Set(orphanIds.map((r) => r.category_id ).filter(Boolean))) as string[];
    const [orphanCommittees, orphanCategories] = await Promise.all([
      orphanCommitteeIds.length
        ? db.select({ id: committees.id, name: committees.name }).from(committees).where(sql`${committees.id} = ANY(${orphanCommitteeIds})`)
        : Promise.resolve([]),
      orphanCategoryIds.length
        ? db.select({ id: expenseCategories.id, label: expenseCategories.label }).from(expenseCategories).where(sql`${expenseCategories.id} = ANY(${orphanCategoryIds})`)
        : Promise.resolve([]),
    ]);
    const committeeName = new Map(orphanCommittees.map((c) => [c.id, c.name]));
    const categoryLabel = new Map(orphanCategories.map((c) => [c.id, c.label]));

    type Row = {
      committee: string; category: string; planned_paise: number;
      actual_paise: number; bill_count: number; variance_paise: number;
      utilisation: number | null;
    };
    const rows: Row[] = [];

    for (const p of plannedRows) {
      const a = actualMap.get(key(p.committee_id, p.category_id));
      const planned = p.planned_paise ?? 0;
      const actual  = a?.actual_paise ?? 0;
      rows.push({
        committee:      p.committee_name ?? "(Branch-wide)",
        category:       p.category_label ?? "—",
        planned_paise:  planned,
        actual_paise:   actual,
        bill_count:     a?.bill_count ?? 0,
        variance_paise: planned - actual,
        utilisation:    planned > 0 ? actual / planned : null,
      });
    }
    // Uncategorised — orphan actuals with no matching budget row.
    for (const orphan of orphanIds) {
      rows.push({
        committee:      committeeName.get(orphan.committee_id ?? "") ?? "(Branch-wide)",
        category:       (categoryLabel.get(orphan.category_id ?? "") ?? "(Uncategorised)") + " — unbudgeted",
        planned_paise:  0,
        actual_paise:   orphan.actual_paise ?? 0,
        bill_count:     orphan.bill_count ?? 0,
        variance_paise: -(orphan.actual_paise ?? 0),
        utilisation:    null,
      });
    }

    await sendReport(res, {
      filename: `budget-vs-actual-fy${fy}-${(fy + 1) % 100}`,
      title:    `Budget vs Actual — FY ${fy}-${String((fy + 1) % 100).padStart(2, "0")}`,
      subtitle: `Actuals include bills in status 'approved' or 'paid' · ${rows.length} row(s)`,
      sheetName: "Budget",
      showTotals: true,
      columns: [
        { header: "Committee",     key: "committee",      kind: "text",     width: 24 },
        { header: "Category",      key: "category",       kind: "text",     width: 26 },
        { header: "Planned",       key: "planned_paise",  kind: "currency" },
        { header: "Actual",        key: "actual_paise",   kind: "currency" },
        { header: "Bills",         key: "bill_count",     kind: "number" },
        { header: "Variance",      key: "variance_paise", kind: "currency" },
        { header: "Utilisation",   key: "utilisation",    kind: "percent",  skipTotal: true },
      ],
      rows,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// The cpe-balance report was removed in migration 0087 alongside the
// rest of the CPE feature (upstream ICAI publish API withdrawn).

// ─── 4. Member directory ─────────────────────────────────────────────────
// /api/admin/reports/member-directory.xlsx
//
// All portal members with a profile (excludes students, employers, guests).
// This is the branch office's outreach list — every committee asks for it
// at some point.
reportsAdminRouter.get("/member-directory.xlsx", async (_req, res, next) => {
  try {
    const rows = await db
      .select({
        mrn:               memberProfiles.mrn,
        name:              users.name,
        email:             users.email,
        phone:             users.phone,
        category:          sql<string>`case when ${memberProfiles.is_fca} then 'FCA' else 'ACA' end`.as("category"),
        cop_status:        memberProfiles.cop_status,
        is_practising:     sql<string>`case when ${memberProfiles.is_practising} then 'Yes' else 'No' end`.as("is_practising"),
        member_since:      memberProfiles.member_since,
        city:              memberProfiles.city,
        pincode:           memberProfiles.pincode,
        branch_name:       branches.name,
        joined_portal_at:  users.created_at,
      })
      .from(memberProfiles)
      .innerJoin(users, eq(users.id, memberProfiles.user_id))
      .leftJoin(branches, eq(branches.id, users.branch_id))
      .where(and(isNull(users.deleted_at), isNull(memberProfiles.deleted_at)))
      .orderBy(asc(users.name));

    await sendReport(res, {
      filename: `member-directory-${new Date().toISOString().slice(0, 10)}`,
      title:    "Member Directory",
      subtitle: `${rows.length} member(s) with active portal accounts`,
      sheetName: "Members",
      columns: [
        { header: "Name",            key: "name",             kind: "text", width: 26 },
        { header: "MRN",             key: "mrn",              kind: "text", width: 12 },
        { header: "FCA / ACA",       key: "category",         kind: "text", width: 10 },
        { header: "COP",             key: "cop_status",       kind: "text", width: 11 },
        { header: "Practising",      key: "is_practising",    kind: "text", width: 12 },
        { header: "Email",           key: "email",            kind: "text", width: 28 },
        { header: "Phone",           key: "phone",            kind: "text", width: 15 },
        { header: "City",            key: "city",             kind: "text", width: 14 },
        { header: "Pincode",         key: "pincode",          kind: "text", width: 10 },
        { header: "Member since",    key: "member_since",     kind: "date" },
        { header: "Joined portal",   key: "joined_portal_at", kind: "date" },
        { header: "Branch",          key: "branch_name",      kind: "text", width: 18 },
      ],
      rows,
    });
  } catch (err) { handleApiError(err, res, next); }
});
