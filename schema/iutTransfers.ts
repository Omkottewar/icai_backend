import { pgTable, uuid, text, integer, date, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { files } from "./files";

// ─── IUT Transfers ────────────────────────────────────────────────────────────
//
// Inter-Unit Transfers — internal movements of money between branch accounts
// or between the branch and ICAI HO / WIRC. Distinct from `payments` (which
// covers customer-facing Razorpay transactions) and `bills` (which covers
// vendor outflows).
//
// Most-common use cases identified with the client:
//   - Monthly remittance of CABF receipts to ICAI HO
//   - Inter-committee budget reallocations
//   - Reimbursement of speaker fees paid personally by an MC member
//
// `from_account` / `to_account` are deliberately free-text strings — the
// chart of accounts isn't stable enough to lock into an enum at this stage.
// We can normalise later if a small fixed set emerges.

export const iutTransfers = pgTable(
  "iut_transfers",
  {
    id:                 uuid("id").primaryKey().defaultRandom(),
    amount_paise:       integer("amount_paise").notNull(),
    transfer_date:      date("transfer_date").notNull(),
    from_account:       text("from_account").notNull(),
    to_account:         text("to_account").notNull(),
    purpose:            text("purpose").notNull(),
    reference_number:   text("reference_number"),
    document_file_id:   uuid("document_file_id").references(() => files.id, { onDelete: "set null" }),
    status:             text("status").notNull().default("requested"),
    // requested | approved | rejected | executed
    requested_by:       uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
    requested_at:       timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    approved_by:        uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approved_at:        timestamp("approved_at", { withTimezone: true }),
    executed_at:        timestamp("executed_at", { withTimezone: true }),
    rejection_reason:   text("rejection_reason"),
    notes:              text("notes"),
    created_at:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:         timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Treasurer's queue: status='requested'
    index("iut_transfers_status_idx").on(t.status),
    // Audit lookup by date range
    index("iut_transfers_date_idx").on(t.transfer_date),
  ],
);
