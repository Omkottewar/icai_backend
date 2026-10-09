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
  // flows go through SabPaisa; UPI/Razorpay values exist only on
  // historical rows. See migration 0100.
  provider:             text("provider").notNull().default("sabpaisa"),
  // SabPaisa integration columns (migration 0100). `client_txn_id` is OUR
  // generated reference echoed back on every callback — correlation anchor
  // independent of SabPaisa's own id. `sabpaisa_response` stores the full
  // decrypted response for audit / dispute support.
  client_txn_id:         text("client_txn_id"),
  sabpaisa_txn_id:       text("sabpaisa_txn_id"),
  sabpaisa_status_code:  text("sabpaisa_status_code"),
  sabpaisa_payment_mode: text("sabpaisa_payment_mode"),
  sabpaisa_bank_name:    text("sabpaisa_bank_name"),
  sabpaisa_bank_txn_id:  text("sabpaisa_bank_txn_id"),
  sabpaisa_response:     jsonb("sabpaisa_response").notNull().default({}),
  return_received_at:    timestamp("return_received_at", { withTimezone: true }),
  webhook_received_at:   timestamp("webhook_received_at", { withTimezone: true }),
  last_verified_at:      timestamp("last_verified_at", { withTimezone: true }),
  // Razorpay columns kept for historical rows only. Replaced first by UPI
  // QR (migration 0084) and then by SabPaisa (migration 0100).
  razorpay_order_id:    text("razorpay_order_id").unique(),
  razorpay_payment_id:  text("razorpay_payment_id"),
  razorpay_signature:   text("razorpay_signature"),
  // UPI QR verification fields — populated only on `provider = 'upi_manual'`
  // rows (migrations 0084/0085). Admin approve/reject still works on
  // those historical rows via the pending-verification queue; new SabPaisa
  // rows never land there.
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
