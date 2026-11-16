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
  // `provider` labels which gateway/channel handled this row. New rows are
  // always 'sabpaisa'; older rows may carry earlier channel labels.
  provider:             text("provider").notNull().default("sabpaisa"),
  // Columns from the previous gateway. No code writes them any more; they
  // are kept only so historical rows keep their reference ids.
  razorpay_order_id:    text("razorpay_order_id").unique(),
  razorpay_payment_id:  text("razorpay_payment_id"),
  razorpay_signature:   text("razorpay_signature"),
  // SabPaisa integration columns (re-added in migration 0105 for dual-
  // provider support). `client_txn_id` is OUR generated reference echoed
  // back by SabPaisa on every callback/webhook so we can correlate without
  // trusting their id; `sabpaisa_txn_id` is their internal id. All nullable
  // because they're only populated once SabPaisa responds. Unique partial
  // indexes on client_txn_id + sabpaisa_txn_id are enforced in-DB.
  client_txn_id:         text("client_txn_id"),
  sabpaisa_txn_id:       text("sabpaisa_txn_id"),
  sabpaisa_status_code:  text("sabpaisa_status_code"),
  sabpaisa_payment_mode: text("sabpaisa_payment_mode"),
  sabpaisa_bank_name:    text("sabpaisa_bank_name"),
  sabpaisa_bank_txn_id:  text("sabpaisa_bank_txn_id"),
  sabpaisa_response:     jsonb("sabpaisa_response").notNull().default({}),
  return_received_at:    timestamp("return_received_at",   { withTimezone: true }),
  webhook_received_at:   timestamp("webhook_received_at",  { withTimezone: true }),
  last_verified_at:      timestamp("last_verified_at",     { withTimezone: true }),
  // UPI QR verification fields — populated only on `provider = 'upi_manual'`
  // rows (migrations 0084/0085). Admin approve/reject still works on those
  // historical rows via the pending-verification queue; new gateway rows
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
