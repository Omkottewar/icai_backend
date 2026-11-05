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
  // `provider` labels which gateway/channel handled this row. New paid
  // flows go through Razorpay; `upi_manual` exists only on historical rows.
  provider:             text("provider").notNull().default("razorpay"),
  // Razorpay integration columns. `razorpay_order_id` is the Order we open
  // when initiating payment; `razorpay_payment_id` is Razorpay's payment id
  // (captured on the browser handler or server-to-server webhook);
  // `razorpay_signature` is the HMAC we verified on the handler payload.
  razorpay_order_id:    text("razorpay_order_id").unique(),
  razorpay_payment_id:  text("razorpay_payment_id"),
  razorpay_signature:   text("razorpay_signature"),
  // UPI QR verification fields — populated only on `provider = 'upi_manual'`
  // rows (migrations 0084/0085). Admin approve/reject still works on those
  // historical rows via the pending-verification queue; new Razorpay rows
  // never land there.
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
