import {
  pgTable, uuid, text, integer, numeric, timestamp, jsonb,
} from "drizzle-orm/pg-core";
import {
  paymentStatusEnum, paymentPurposeEnum,
  refundStatusEnum, disputeStatusEnum,
} from "./enums";
import { users } from "./identity";

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
  razorpay_order_id:    text("razorpay_order_id").unique(),
  razorpay_payment_id:  text("razorpay_payment_id"),
  razorpay_signature:   text("razorpay_signature"),
  metadata:             jsonb("metadata").notNull().default({}),
  created_at:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:           timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deleted_at:           timestamp("deleted_at", { withTimezone: true }),
});

// ─── Payment Refunds ──────────────────────────────────────────────────────────
// One row per refund attempt — supports partial/multi-tranche refunds

export const paymentRefunds = pgTable("payment_refunds", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  payment_id:          uuid("payment_id").notNull().references(() => payments.id),
  razorpay_refund_id:  text("razorpay_refund_id").unique(),
  amount_paise:        integer("amount_paise").notNull(),
  reason:              text("reason"),
  status:              refundStatusEnum("status").notNull().default("pending"),
  initiated_by:        uuid("initiated_by").references(() => users.id),  // staff who initiated
  created_at:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  processed_at:        timestamp("processed_at", { withTimezone: true }),
});

// ─── Invoices ─────────────────────────────────────────────────────────────────
// GST-compliant invoices required under Indian law

export const invoices = pgTable("invoices", {
  id:                   uuid("id").primaryKey().defaultRandom(),
  invoice_no:           text("invoice_no").notNull().unique(),     // NGP/2025-26/000001
  payment_id:           uuid("payment_id").notNull().references(() => payments.id),
  payer_user_id:        uuid("payer_user_id").references(() => users.id),
  amount_paise:         integer("amount_paise").notNull(),          // total incl. GST
  taxable_amount_paise: integer("taxable_amount_paise").notNull(),  // pre-tax amount
  gst_rate:             numeric("gst_rate", { precision: 5, scale: 2 }).notNull().default("0"),
  cgst_paise:           integer("cgst_paise").notNull().default(0),
  sgst_paise:           integer("sgst_paise").notNull().default(0),
  igst_paise:           integer("igst_paise").notNull().default(0),
  billing_name:         text("billing_name").notNull(),    // snapshotted at invoice time
  billing_address:      text("billing_address"),
  billing_gstin:        text("billing_gstin"),             // buyer GSTIN for B2B
  pan:                  text("pan"),
  financial_year:       text("financial_year").notNull(), // 2025-26
  issued_at:            timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
  cancelled_at:         timestamp("cancelled_at", { withTimezone: true }),
  cancellation_reason:  text("cancellation_reason"),
  created_at:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Payment Disputes ─────────────────────────────────────────────────────────
// Razorpay chargebacks — strict response deadline tracking

export const paymentDisputes = pgTable("payment_disputes", {
  id:                  uuid("id").primaryKey().defaultRandom(),
  payment_id:          uuid("payment_id").notNull().references(() => payments.id),
  razorpay_dispute_id: text("razorpay_dispute_id").notNull().unique(),
  amount_paise:        integer("amount_paise").notNull(),
  reason:              text("reason").notNull(),
  status:              disputeStatusEnum("status").notNull().default("open"),
  respond_by:          timestamp("respond_by", { withTimezone: true }),  // alert if < 48h
  responded_at:        timestamp("responded_at", { withTimezone: true }),
  response_note:       text("response_note"),
  resolution:          text("resolution"),
  assigned_to:         uuid("assigned_to").references(() => users.id),  // staff owner
  created_at:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
