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
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../../db/client.js";
import {
  events, eventRegistrations, payments, users, memberProfiles,
  committees, budgets, bills, expenseCategories, branches,
} from "../../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { addReportSheet, newReportWorkbook, sendReport, sendWorkbook } from "../../lib/reportsXlsx.js";

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
        upi_utr:      sql<string>`coalesce(${payments.sabpaisa_txn_id}, ${payments.razorpay_payment_id}, ${payments.upi_utr})`,
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

// ─── GET /api/admin/reports/payments-full.xlsx ────────────────────────────
// "Everything about payments" in one workbook, for the treasurer/accountant:
//   1. Summary        collected / GST / refunds / net, by status, purpose, month
//   2. Payments       every payment row with GST split, gateway ids, refunds
//   3. Seat holders   each event seat bought with a payment (incl. group bookings)
//   4. Refunds        every refund request and where it stands
//   5. Refunds owed   payments flagged for refund with no processed refund yet
// Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD filters on the payment date (IST
// calendar days are close enough to UTC dates for an audit export; the
// window is inclusive of `to`).
const PURPOSE_LABEL: Record<string, string> = {
  event_registration: "Event registration",
  cop_renewal: "COP renewal",
  firm_registration: "Firm registration",
  job_posting: "Job posting",
  assignment_posting: "Assignment posting",
  cabf_donation: "CABF donation",
  consultation: "Consultation",
  room_booking: "Room booking",
  other: "Other",
};
const IST_MONTH = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", month: "short", year: "numeric" });
const IST_MONTH_KEY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" });

reportsAdminRouter.get("/payments-full.xlsx", async (req, res, next) => {
  try {
    const from = trim(req.query.from);
    const to   = trim(req.query.to);
    const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (from && !isDay(from)) throw new ApiError(400, "from must be YYYY-MM-DD");
    if (to && !isDay(to))     throw new ApiError(400, "to must be YYYY-MM-DD");
    const fromSql = from ? sql`AND p.created_at >= ${from}::date` : sql``;
    const toSql   = to   ? sql`AND p.created_at < (${to}::date + INTERVAL '1 day')` : sql``;

    const paymentRows = (await db.execute(sql`
      SELECT
        p.id                                   AS payment_id,
        p.created_at,
        u.name                                 AS payer,
        mp.mrn,
        u.email                                AS payer_email,
        u.phone                                AS payer_phone,
        p.purpose,
        COALESCE(e.title, p.metadata->>'event_title', jp.title, '') AS item,
        e.starts_at                            AS event_date,
        emp.company_name                       AS employer,
        COALESCE((p.metadata->>'seat_count')::int,
                 CASE WHEN p.purpose = 'event_registration' THEN 1 END) AS seats,
        p.status,
        p.provider,
        COALESCE((p.metadata->>'base_paise')::int,
                 p.amount_paise - COALESCE((p.metadata->>'gst_paise')::int, 0)) AS base_paise,
        COALESCE((p.metadata->>'gst_percent')::numeric, 0) / 100.0 AS gst_rate,
        COALESCE((p.metadata->>'gst_paise')::int, 0) AS gst_paise,
        p.amount_paise                         AS total_paise,
        COALESCE((SELECT SUM(r.amount_paise) FROM payment_refunds r
                   WHERE r.payment_id = p.id AND r.status = 'processed'), 0)::int AS refunded_paise,
        p.metadata->>'needs_refund'            AS refund_flag,
        COALESCE(p.sabpaisa_txn_id, p.razorpay_payment_id, p.upi_utr) AS gateway_ref,
        p.client_txn_id,
        p.sabpaisa_payment_mode AS payment_mode,
        p.verified_at,
        vu.name                                AS verified_by,
        p.rejected_reason,
        p.updated_at
      FROM payments p
      LEFT JOIN users u            ON u.id = p.payer_user_id
      LEFT JOIN member_profiles mp ON mp.user_id = u.id
      LEFT JOIN events e           ON p.purpose = 'event_registration' AND e.id = p.ref_id
      LEFT JOIN job_postings jp    ON p.purpose = 'job_posting' AND jp.id = p.ref_id
      LEFT JOIN employers emp      ON emp.id = jp.employer_id
      LEFT JOIN users vu           ON vu.id = p.verified_by
      WHERE p.deleted_at IS NULL ${fromSql} ${toSql}
      ORDER BY p.created_at DESC
    `)) as unknown as Array<Record<string, any>>;

    for (const r of paymentRows) {
      r.purpose_label = PURPOSE_LABEL[r.purpose] ?? r.purpose;
      r.gst_rate = r.gst_rate == null ? null : Number(r.gst_rate);
      r.net_paise = r.status === "success" ? Number(r.total_paise) - Number(r.refunded_paise) : 0;
    }

    const seatRows = (await db.execute(sql`
      SELECT
        e.title                     AS event,
        e.starts_at                 AS event_date,
        a.name                      AS attendee,
        mp.mrn,
        a.email                     AS attendee_email,
        b.name                      AS booked_by,
        CASE WHEN er.deleted_at IS NOT NULL THEN 'cancelled' ELSE er.status::text END AS seat_status,
        er.registered_at,
        er.attended_at,
        p.id                        AS payment_id,
        p.status                    AS payment_status,
        COALESCE(p.sabpaisa_txn_id, p.razorpay_payment_id, p.upi_utr) AS gateway_ref,
        (p.amount_paise / GREATEST(COALESCE((p.metadata->>'seat_count')::int, 1), 1))::int AS paid_per_seat_paise
      FROM event_registrations er
      JOIN payments p              ON p.id = er.payment_id
      JOIN events e                ON e.id = er.event_id
      JOIN users a                 ON a.id = er.user_id
      LEFT JOIN users b            ON b.id = COALESCE(er.booked_by_user_id, p.payer_user_id)
      LEFT JOIN member_profiles mp ON mp.user_id = a.id
      WHERE p.deleted_at IS NULL ${fromSql} ${toSql}
      ORDER BY e.starts_at DESC, e.title, a.name
    `)) as unknown as Array<Record<string, any>>;

    const refundRows = (await db.execute(sql`
      SELECT
        r.requested_at,
        r.status,
        r.amount_paise,
        r.reason,
        p.id                        AS payment_id,
        u.name                      AS payer,
        COALESCE(e.title, p.metadata->>'event_title', jp.title, '') AS item,
        p.amount_paise              AS payment_total_paise,
        COALESCE(p.sabpaisa_txn_id, p.razorpay_payment_id, p.upi_utr) AS gateway_ref,
        rq.name                     AS requested_by,
        ap.name                     AS approved_by,
        r.approved_at,
        r.processed_at,
        r.razorpay_refund_id        AS gateway_refund_id,
        r.notes
      FROM payment_refunds r
      JOIN payments p          ON p.id = r.payment_id
      LEFT JOIN users u        ON u.id = p.payer_user_id
      LEFT JOIN events e       ON p.purpose = 'event_registration' AND e.id = p.ref_id
      LEFT JOIN job_postings jp ON p.purpose = 'job_posting' AND jp.id = p.ref_id
      LEFT JOIN users rq       ON rq.id = r.requested_by
      LEFT JOIN users ap       ON ap.id = r.approved_by
      WHERE p.deleted_at IS NULL ${fromSql} ${toSql}
      ORDER BY r.requested_at DESC
    `)) as unknown as Array<Record<string, any>>;

    const owedRows = paymentRows
      .filter((r) => r.refund_flag && Number(r.refunded_paise) < Number(r.total_paise))
      .map((r) => ({
        created_at: r.created_at,
        payer: r.payer,
        payer_email: r.payer_email,
        payer_phone: r.payer_phone,
        item: r.item,
        reason: String(r.refund_flag).replace(/_/g, " "),
        total_paise: r.total_paise,
        refunded_paise: r.refunded_paise,
        owed_paise: Number(r.total_paise) - Number(r.refunded_paise),
        gateway_ref: r.gateway_ref,
        payment_id: r.payment_id,
      }));

    // ── Summary ──────────────────────────────────────────────────────────
    type Bucket = { section: string; item: string; count: number; base_paise: number; gst_paise: number; total_paise: number };
    const bucket = (map: Map<string, Bucket>, section: string, item: string, r: Record<string, any>) => {
      const k = `${section}|${item}`;
      const b = map.get(k) ?? { section, item, count: 0, base_paise: 0, gst_paise: 0, total_paise: 0 };
      b.count += 1;
      b.base_paise += Number(r.base_paise) || 0;
      b.gst_paise += Number(r.gst_paise) || 0;
      b.total_paise += Number(r.total_paise) || 0;
      map.set(k, b);
    };
    const success = paymentRows.filter((r) => r.status === "success");
    const totals = new Map<string, Bucket>();
    for (const r of success) bucket(totals, "Overall", "Collected (successful payments)", r);
    const refundedTotal = paymentRows.reduce((s, r) => s + (Number(r.refunded_paise) || 0), 0);
    const owedTotal = owedRows.reduce((s, r) => s + r.owed_paise, 0);
    const collected = totals.get("Overall|Collected (successful payments)")?.total_paise ?? 0;

    const byStatus = new Map<string, Bucket>();
    for (const r of paymentRows) bucket(byStatus, "By status (all payments)", String(r.status), r);
    const byPurpose = new Map<string, Bucket>();
    for (const r of success) bucket(byPurpose, "By purpose (successful)", r.purpose_label, r);
    const byMonth = new Map<string, Bucket>();
    const monthOrder = new Map<string, string>();
    for (const r of success) {
      const d = new Date(r.created_at);
      const label = IST_MONTH.format(d);
      monthOrder.set(label, IST_MONTH_KEY.format(d));
      bucket(byMonth, "By month (successful)", label, r);
    }
    const blank = { count: null, base_paise: null, gst_paise: null };
    const summaryRows: Array<Record<string, unknown>> = [
      ...totals.values(),
      { section: "Overall", item: "Refunded (processed)", ...blank, total_paise: -refundedTotal },
      { section: "Overall", item: "Net collected (after refunds)", ...blank, total_paise: collected - refundedTotal },
      { section: "Overall", item: "Refunds owed (flagged, not yet processed)", count: owedRows.length, base_paise: null, gst_paise: null, total_paise: owedTotal },
      ...[...byStatus.values()].sort((a, b) => b.count - a.count),
      ...[...byPurpose.values()].sort((a, b) => b.total_paise - a.total_paise),
      ...[...byMonth.values()].sort((a, b) => (monthOrder.get(b.item) ?? "").localeCompare(monthOrder.get(a.item) ?? "")),
    ];

    const window = from || to ? `${from || "start"} → ${to || "today"}` : "all time";
    const wb = newReportWorkbook();

    addReportSheet(wb, {
      filename: "", title: "Payments — summary", subtitle: `Payment date: ${window} · amounts in ₹`,
      sheetName: "Summary",
      columns: [
        { header: "Section",   key: "section",     kind: "text", width: 26 },
        { header: "Item",      key: "item",        kind: "text", width: 40 },
        { header: "Payments",  key: "count",       kind: "number" },
        { header: "Base",      key: "base_paise",  kind: "currency" },
        { header: "GST",       key: "gst_paise",   kind: "currency" },
        { header: "Total",     key: "total_paise", kind: "currency" },
      ],
      rows: summaryRows,
    });

    addReportSheet(wb, {
      filename: "", title: "Payments", subtitle: `Every payment · ${window}`,
      sheetName: "Payments", showTotals: true,
      columns: [
        { header: "Date",              key: "created_at",          kind: "datetime" },
        { header: "Payer",             key: "payer",               kind: "text", width: 24 },
        { header: "MRN",               key: "mrn",                 kind: "text", width: 12 },
        { header: "Email",             key: "payer_email",         kind: "text", width: 28 },
        { header: "Phone",             key: "payer_phone",         kind: "text", width: 15 },
        { header: "Purpose",           key: "purpose_label",       kind: "text", width: 18 },
        { header: "For (event / job)", key: "item",                kind: "text", width: 32 },
        { header: "Event date",        key: "event_date",          kind: "date" },
        { header: "Employer",          key: "employer",            kind: "text", width: 22 },
        { header: "Seats",             key: "seats",               kind: "number", skipTotal: true },
        { header: "Status",            key: "status",              kind: "text", width: 14 },
        { header: "Base",              key: "base_paise",          kind: "currency" },
        { header: "GST %",             key: "gst_rate",            kind: "percent", skipTotal: true },
        { header: "GST",               key: "gst_paise",           kind: "currency" },
        { header: "Total",             key: "total_paise",         kind: "currency" },
        { header: "Refunded",          key: "refunded_paise",      kind: "currency" },
        { header: "Net (success − refunds)", key: "net_paise",     kind: "currency" },
        { header: "Refund flag",       key: "refund_flag",         kind: "text", width: 22 },
        { header: "Gateway txn / UTR", key: "gateway_ref",         kind: "text", width: 24 },
        { header: "Our txn ID",        key: "client_txn_id",       kind: "text", width: 24 },
        { header: "Payment mode",      key: "payment_mode",        kind: "text", width: 14 },
        { header: "Verified at",       key: "verified_at",         kind: "datetime" },
        { header: "Verified by",       key: "verified_by",         kind: "text", width: 20 },
        { header: "Rejection reason",  key: "rejected_reason",     kind: "text", width: 28 },
        { header: "Last updated",      key: "updated_at",          kind: "datetime" },
        { header: "Payment ID",        key: "payment_id",          kind: "text", width: 38 },
      ],
      rows: paymentRows,
    });

    addReportSheet(wb, {
      filename: "", title: "Event seats bought online", subtitle: `One row per seat · payment date: ${window}`,
      sheetName: "Seat holders", showTotals: true,
      columns: [
        { header: "Event",          key: "event",               kind: "text", width: 32 },
        { header: "Event date",     key: "event_date",          kind: "date" },
        { header: "Attendee",       key: "attendee",            kind: "text", width: 24 },
        { header: "MRN",            key: "mrn",                 kind: "text", width: 12 },
        { header: "Email",          key: "attendee_email",      kind: "text", width: 28 },
        { header: "Booked / paid by", key: "booked_by",         kind: "text", width: 24 },
        { header: "Seat status",    key: "seat_status",         kind: "text", width: 14 },
        { header: "Registered at",  key: "registered_at",       kind: "datetime" },
        { header: "Attended at",    key: "attended_at",         kind: "datetime" },
        { header: "Paid per seat",  key: "paid_per_seat_paise", kind: "currency" },
        { header: "Payment status", key: "payment_status",      kind: "text", width: 14 },
        { header: "Gateway txn", key: "gateway_ref", kind: "text", width: 24 },
        { header: "Payment ID",     key: "payment_id",          kind: "text", width: 38 },
      ],
      rows: seatRows,
    });

    addReportSheet(wb, {
      filename: "", title: "Refunds", subtitle: `Every refund request · payment date: ${window}`,
      sheetName: "Refunds", showTotals: true,
      columns: [
        { header: "Requested at",   key: "requested_at",        kind: "datetime" },
        { header: "Status",         key: "status",              kind: "text", width: 12 },
        { header: "Refund amount",  key: "amount_paise",        kind: "currency" },
        { header: "Reason",         key: "reason",              kind: "text", width: 30 },
        { header: "Payer",          key: "payer",               kind: "text", width: 24 },
        { header: "For (event / job)", key: "item",             kind: "text", width: 30 },
        { header: "Original payment", key: "payment_total_paise", kind: "currency", skipTotal: true },
        { header: "Requested by",   key: "requested_by",        kind: "text", width: 20 },
        { header: "Approved by",    key: "approved_by",         kind: "text", width: 20 },
        { header: "Approved at",    key: "approved_at",         kind: "datetime" },
        { header: "Processed at",   key: "processed_at",        kind: "datetime" },
        { header: "Gateway refund", key: "gateway_refund_id", kind: "text", width: 24 },
        { header: "Gateway txn", key: "gateway_ref", kind: "text", width: 24 },
        { header: "Notes",          key: "notes",               kind: "text", width: 30 },
        { header: "Payment ID",     key: "payment_id",          kind: "text", width: 38 },
      ],
      rows: refundRows,
    });

    addReportSheet(wb, {
      filename: "", title: "Refunds owed", subtitle: "Payments flagged for refund (sold out, cancellation approved, posting deleted…) with no processed refund yet",
      sheetName: "Refunds owed", showTotals: true,
      columns: [
        { header: "Paid at",        key: "created_at",          kind: "datetime" },
        { header: "Payer",          key: "payer",               kind: "text", width: 24 },
        { header: "Email",          key: "payer_email",         kind: "text", width: 28 },
        { header: "Phone",          key: "payer_phone",         kind: "text", width: 15 },
        { header: "For (event / job)", key: "item",             kind: "text", width: 30 },
        { header: "Why",            key: "reason",              kind: "text", width: 26 },
        { header: "Paid",           key: "total_paise",         kind: "currency" },
        { header: "Already refunded", key: "refunded_paise",    kind: "currency" },
        { header: "Still owed",     key: "owed_paise",          kind: "currency" },
        { header: "Gateway txn", key: "gateway_ref", kind: "text", width: 24 },
        { header: "Payment ID",     key: "payment_id",          kind: "text", width: 38 },
      ],
      rows: owedRows,
    });

    await sendWorkbook(res, wb, `payments-all-${from || "start"}-to-${to || "today"}`);
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
        ? db.select({ id: committees.id, name: committees.name }).from(committees).where(inArray(committees.id, orphanCommitteeIds))
        : Promise.resolve([]),
      orphanCategoryIds.length
        ? db.select({ id: expenseCategories.id, label: expenseCategories.label }).from(expenseCategories).where(inArray(expenseCategories.id, orphanCategoryIds))
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
