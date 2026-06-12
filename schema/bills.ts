import { pgTable, uuid, text, integer, date, timestamp, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { events } from "./events";
import { committees } from "./committees";
import { files } from "./files";

// ─── Bills ────────────────────────────────────────────────────────────────────
//
// Post-event bills + standalone branch operational bills. Replaces the
// abandoned `invoices` table (dropped in migration 0015) with a workflow-
// oriented design rather than a Razorpay-receipt mirror.
//
// Workflow:
//   accountant records   → status='draft' or 'submitted'
//   treasurer approves   → status='approved'
//   treasurer pays out   → status='paid'
//   treasurer rejects    → status='rejected' (with reason in notes)
//
// `budget_paise` is the originally-budgeted amount from the event checklist;
// the variance is computed at read time so the chairman can see overruns.

export const bills = pgTable(
  "bills",
  {
    id:                uuid("id").primaryKey().defaultRandom(),
    event_id:          uuid("event_id").references(() => events.id, { onDelete: "set null" }),
    committee_id:      uuid("committee_id").references(() => committees.id, { onDelete: "set null" }),
    vendor_name:       text("vendor_name").notNull(),
    description:       text("description"),
    amount_paise:      integer("amount_paise").notNull(),
    bill_date:         date("bill_date").notNull(),
    bill_number:       text("bill_number"),
    budget_paise:      integer("budget_paise"),
    document_file_id:  uuid("document_file_id").references(() => files.id, { onDelete: "set null" }),
    status:            text("status").notNull().default("draft"),
    // draft | submitted | approved | rejected | paid
    submitted_by:      uuid("submitted_by").references(() => users.id, { onDelete: "set null" }),
    submitted_at:      timestamp("submitted_at", { withTimezone: true }),
    approved_by:       uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approved_at:       timestamp("approved_at", { withTimezone: true }),
    paid_at:           timestamp("paid_at", { withTimezone: true }),
    rejection_reason:  text("rejection_reason"),
    notes:             text("notes"),
    created_at:        timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:        timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deleted_at:        timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    // Treasurer's queue: status='submitted'
    // Accountant's queue: status='draft' AND submitted_by = me
    index("bills_status_idx").on(t.status),
    // Per-event bills view on the EventsAdminPage drawer
    index("bills_event_idx").on(t.event_id),
    // Accountant's own drafts
    index("bills_submitted_by_idx").on(t.submitted_by),
  ],
);
