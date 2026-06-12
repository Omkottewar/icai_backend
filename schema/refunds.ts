import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { payments } from "./payments";

// ─── Payment Refunds ──────────────────────────────────────────────────────────
//
// Tracks refund requests against successful `payments` rows. The original
// payment_refunds table was dropped in migration 0015 (it had no live writers
// when the v0 design proved too thin). This is the v2 — every column has a
// concrete caller in the new treasurer workflow.
//
// Lifecycle:
//   requested → approved → processed   (happy path)
//   requested → rejected               (treasurer denies)
//
// Razorpay's refund id is stored once we actually call the gateway; until
// then we keep the row in `approved` so the treasurer dashboard can show
// "approved but not yet wired through gateway" as a queue.

export const paymentRefunds = pgTable(
  "payment_refunds",
  {
    id:                 uuid("id").primaryKey().defaultRandom(),
    payment_id:         uuid("payment_id").notNull().references(() => payments.id, { onDelete: "restrict" }),
    amount_paise:       integer("amount_paise").notNull(),
    reason:             text("reason").notNull(),
    status:             text("status").notNull().default("requested"),
    // requested | approved | rejected | processed
    requested_by:       uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    requested_at:       timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    approved_by:        uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approved_at:        timestamp("approved_at", { withTimezone: true }),
    razorpay_refund_id: text("razorpay_refund_id"),
    processed_at:       timestamp("processed_at", { withTimezone: true }),
    notes:              text("notes"),
    created_at:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Treasurer's "refunds awaiting my approval" query — filtered on status
    index("payment_refunds_status_idx").on(t.status),
    // Looking up refunds for a given payment (reconciliation).
    index("payment_refunds_payment_idx").on(t.payment_id),
  ],
);
