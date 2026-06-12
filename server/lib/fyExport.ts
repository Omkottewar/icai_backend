import type { Response } from "express";
import { and, eq, gte, lt, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { payments, paymentRefunds, bills, iutTransfers, cabfAssistanceRequests, users, events } from "../../schema/index.js";

// FY consolidated CSV export.
//
// The treasurer needs a single end-of-year file with every financial movement
// the branch was involved in. We emit five sections back-to-back in one CSV:
//
//   1. Successful payments (event registrations, CABF donations, etc.)
//   2. Refunds processed
//   3. Bills paid
//   4. IUT transfers executed
//   5. CABF assistance disbursements
//
// We stream rows directly to the response so a multi-thousand-row FY doesn't
// blow up memory. Each section starts with a header row prefixed with `# `
// so a spreadsheet can split it visually but a simple parser can still read
// the file as a flat list.

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "string" ? v : String(v);
  if (s.includes(",") || s.includes("\"") || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(",") + "\n";
}

function rupees(paise: number | null | undefined): string {
  if (paise === null || paise === undefined) return "";
  return (paise / 100).toFixed(2);
}

/**
 * Stream the consolidated CSV for the given FY directly to the Express
 * response. The caller has already set the Content-Type / Disposition
 * headers and confirmed authentication. Closes the response.
 */
export async function streamFyCsv(
  res: Response,
  fyStart: Date,
  fyEnd: Date,
  fyLabel: string,
): Promise<void> {
  res.write(`# FY ${fyLabel} consolidated financial export\n`);
  res.write(`# generated ${new Date().toISOString()}\n`);

  // ─── 1. Payments ─────────────────────────────────────────────────────
  res.write("\n# section: payments\n");
  res.write(csvRow(["payment_id", "date", "amount_rupees", "purpose", "ref_type", "payer_name", "razorpay_payment_id"]));
  const paymentRows = await db
    .select({
      id: payments.id,
      created_at: payments.created_at,
      amount_paise: payments.amount_paise,
      purpose: payments.purpose,
      ref_type: payments.ref_type,
      payer_name: users.name,
      razorpay_payment_id: payments.razorpay_payment_id,
    })
    .from(payments)
    .leftJoin(users, eq(users.id, payments.payer_user_id))
    .where(and(
      eq(payments.status, "success"),
      gte(payments.created_at, fyStart),
      lt(payments.created_at, fyEnd),
      isNull(payments.deleted_at),
    ));
  for (const r of paymentRows) {
    res.write(csvRow([
      r.id,
      r.created_at?.toISOString().slice(0, 10) ?? "",
      rupees(r.amount_paise),
      r.purpose ?? "",
      r.ref_type ?? "",
      r.payer_name ?? "",
      r.razorpay_payment_id ?? "",
    ]));
  }

  // ─── 2. Refunds ──────────────────────────────────────────────────────
  res.write("\n# section: refunds\n");
  res.write(csvRow(["refund_id", "payment_id", "processed_date", "amount_rupees", "reason"]));
  const refundRows = await db
    .select({
      id: paymentRefunds.id,
      payment_id: paymentRefunds.payment_id,
      processed_at: paymentRefunds.processed_at,
      amount_paise: paymentRefunds.amount_paise,
      reason: paymentRefunds.reason,
    })
    .from(paymentRefunds)
    .where(and(
      eq(paymentRefunds.status, "processed"),
      gte(paymentRefunds.processed_at, fyStart),
      lt(paymentRefunds.processed_at, fyEnd),
    ));
  for (const r of refundRows) {
    res.write(csvRow([
      r.id,
      r.payment_id,
      r.processed_at?.toISOString().slice(0, 10) ?? "",
      rupees(r.amount_paise),
      r.reason ?? "",
    ]));
  }

  // ─── 3. Bills paid ───────────────────────────────────────────────────
  res.write("\n# section: bills_paid\n");
  res.write(csvRow(["bill_id", "paid_date", "vendor", "amount_rupees", "budget_rupees", "event_title", "bill_number"]));
  const billRows = await db
    .select({
      id: bills.id,
      paid_at: bills.paid_at,
      vendor_name: bills.vendor_name,
      amount_paise: bills.amount_paise,
      budget_paise: bills.budget_paise,
      bill_number: bills.bill_number,
      event_title: events.title,
    })
    .from(bills)
    .leftJoin(events, eq(events.id, bills.event_id))
    .where(and(
      eq(bills.status, "paid"),
      gte(bills.paid_at, fyStart),
      lt(bills.paid_at, fyEnd),
      isNull(bills.deleted_at),
    ));
  for (const r of billRows) {
    res.write(csvRow([
      r.id,
      r.paid_at?.toISOString().slice(0, 10) ?? "",
      r.vendor_name,
      rupees(r.amount_paise),
      rupees(r.budget_paise),
      r.event_title ?? "",
      r.bill_number ?? "",
    ]));
  }

  // ─── 4. IUT transfers ────────────────────────────────────────────────
  res.write("\n# section: iut_transfers_executed\n");
  res.write(csvRow(["transfer_id", "executed_date", "from_account", "to_account", "amount_rupees", "purpose", "reference_number"]));
  const iutRows = await db
    .select()
    .from(iutTransfers)
    .where(and(
      eq(iutTransfers.status, "executed"),
      gte(iutTransfers.executed_at, fyStart),
      lt(iutTransfers.executed_at, fyEnd),
    ));
  for (const r of iutRows) {
    res.write(csvRow([
      r.id,
      r.executed_at?.toISOString().slice(0, 10) ?? "",
      r.from_account,
      r.to_account,
      rupees(r.amount_paise),
      r.purpose,
      r.reference_number ?? "",
    ]));
  }

  // ─── 5. CABF disbursements ───────────────────────────────────────────
  res.write("\n# section: cabf_disbursements\n");
  res.write(csvRow(["request_id", "member_name", "disbursed_date", "amount_rupees", "category"]));
  const cabfRows = await db
    .select({
      id: cabfAssistanceRequests.id,
      disbursed_at: cabfAssistanceRequests.disbursed_at,
      disbursed_amount_paise: cabfAssistanceRequests.disbursed_amount_paise,
      category: cabfAssistanceRequests.category,
      member_name: users.name,
    })
    .from(cabfAssistanceRequests)
    .leftJoin(users, eq(users.id, cabfAssistanceRequests.member_user_id))
    .where(and(
      eq(cabfAssistanceRequests.status, "disbursed"),
      gte(cabfAssistanceRequests.disbursed_at, fyStart),
      lt(cabfAssistanceRequests.disbursed_at, fyEnd),
    ));
  for (const r of cabfRows) {
    res.write(csvRow([
      r.id,
      r.member_name ?? "",
      r.disbursed_at?.toISOString().slice(0, 10) ?? "",
      rupees(r.disbursed_amount_paise),
      r.category,
    ]));
  }

  res.end();
}

/**
 * Parse "2026-27" or "2026" into an FY date range using April 1 boundaries.
 */
export function parseFyRange(label: string): { start: Date; end: Date; normalised: string } {
  const m = label.match(/^(\d{4})(?:-(\d{2}|\d{4}))?$/);
  if (!m) throw new Error("FY must be in form YYYY or YYYY-YY (e.g. 2026 or 2026-27)");
  const startYear = Number(m[1]);
  const start = new Date(Date.UTC(startYear, 3, 1));      // April 1
  const end   = new Date(Date.UTC(startYear + 1, 3, 1));  // next April 1
  const normalised = `${startYear}-${String(startYear + 1).slice(-2)}`;
  return { start, end, normalised };
}
