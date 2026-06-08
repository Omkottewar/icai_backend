import {
  pgTable, uuid, text, integer, timestamp, jsonb,
} from "drizzle-orm/pg-core";
import { paymentStatusEnum, paymentPurposeEnum } from "./enums";
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

// payment_refunds, invoices, payment_disputes were dropped in migration 0015.
// They were scaffolding for unbuilt features. If reintroduced, design fresh.
