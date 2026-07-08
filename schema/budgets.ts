import { pgTable, uuid, text, integer, timestamp, index, unique } from "drizzle-orm/pg-core";
import { committees } from "./committees";
import { expenseCategories } from "./vendorsAndCategories";

// ─── Budgets ──────────────────────────────────────────────────────────────
//
// Per-FY, per-committee-per-category planned amounts. Actuals are computed
// on read by joining bills (status IN ('approved','paid')) with matching
// committee + category + bill_date within the FY window.
//
// The treasurer's dashboard shows a budget-vs-actuals card by joining this
// table with bills. Chairman's MIS shows overrun risk.
//
// Rationale for a single flat table (vs nested budget_lines):
//   • Every real financial line is (FY, committee, category, amount) —
//     nothing more.
//   • A join table maps cleanly to a table view / spreadsheet-import
//     workflow the treasurer already uses.
//   • Fewer FK hops on the dashboard read path.
//
// `notes` captures the "why 45k for venue rental" that spreadsheets tend
// to have as a marginalia column.

export const budgets = pgTable(
  "budgets",
  {
    id:              uuid("id").primaryKey().defaultRandom(),
    // FY start year in local convention — 2027 means "FY 2027-28"
    // (Indian FY: Apr → Mar). Kept as an integer for easy filtering.
    fy_start_year:   integer("fy_start_year").notNull(),
    committee_id:    uuid("committee_id").references(() => committees.id, { onDelete: "cascade" }),
    // Null committee_id + a category means "branch-wide budget for that
    // category" — used for utilities, staff salary, etc. that aren't
    // committee-owned.
    category_id:     uuid("category_id").notNull().references(() => expenseCategories.id, { onDelete: "restrict" }),
    planned_paise:   integer("planned_paise").notNull(),
    notes:           text("notes"),
    created_at:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One budget line per (FY, committee-or-branchwide, category). Prevents
    // duplicate rows when the treasurer re-uploads a spreadsheet mid-year.
    unique("budgets_uq").on(t.fy_start_year, t.committee_id, t.category_id),
    index("budgets_fy_idx").on(t.fy_start_year),
    index("budgets_committee_idx").on(t.committee_id),
  ],
);
