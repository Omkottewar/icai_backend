import {
  pgTable, uuid, text, integer, timestamp, jsonb,
} from "drizzle-orm/pg-core";
import { paymentStatusEnum, paymentPurposeEnum } from "./enums";
import { users } from "./identity";
import { files } from "./files";

// ─── Payments ─────────────────────────────────────────────────────────────────

export const payments = pgTable("payments", {
  id:                   uuid("id").primaryKey().defaultRandom(),
  payer_user_id:        uuid("payer_user_id").references(() => users.id),
  amount_paise:         integer("amount_paise").notNull(),   // Amount in paise (₹ × 100)
  currency:             text("currency").notNull().default("INR"),
  status:               paymentStatusEnum("status").notNull().default("created"),
  purpose:              paymentPurposeEnum("purpose").notNull(),
  ref_type:             text("ref_type"),    // e.g. event_registration
  ref_id:               uuid("ref_id"),      // polymorphic back-ref (app must maintain)
  // Razorpay columns kept for old rows only. New paid flows use UPI QR
  // + manual verification (see below). Migration 0084.
  razorpay_order_id:    text("razorpay_order_id").unique(),
  razorpay_payment_id:  text("razorpay_payment_id"),
  razorpay_signature:   text("razorpay_signature"),
  // UPI QR verification fields — user submits `upi_utr` (UPI transaction
  // reference) and optionally attaches a `upi_screenshot_file_id` after
  // paying. Admin cross-checks against the bank statement and sets
  // `verified_by` / `verified_at` (approve) or `rejected_reason` (reject).
  upi_utr:                text("upi_utr"),
  upi_screenshot_file_id: uuid("upi_screenshot_file_id").references(() => files.id, { onDelete: "set null" }),
  verified_by:            uuid("verified_by").references(() => users.id, { onDelete: "set null" }),
  verified_at:            timestamp("verified_at", { withTimezone: true }),
  rejected_reason:        text("rejected_reason"),
  metadata:             jsonb("metadata").notNull().default({}),
  created_at:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:           timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at:           timestamp("deleted_at", { withTimezone: true }),
});

// payment_refunds, invoices, payment_disputes were dropped in migration 0015.
// They were scaffolding for unbuilt features. If reintroduced, design fresh.
