import { pgTable, uuid, text, timestamp, boolean, integer, index, unique } from "drizzle-orm/pg-core";

// ─── Expense categories ───────────────────────────────────────────────────
// A small controlled vocabulary for what a bill is for — venue rental,
// speaker honorarium, printing, refreshments, etc. Keeping this in a table
// (rather than a text field) lets the treasurer dashboard show meaningful
// per-category charts and export MIS breakdowns.
export const expenseCategories = pgTable(
  "expense_categories",
  {
    id:         uuid("id").primaryKey().defaultRandom(),
    code:       text("code").notNull(),           // short slug — 'venue', 'catering'
    label:      text("label").notNull(),          // human name — 'Venue rental'
    description: text("description"),
    // 'income' or 'expense' — most rows are expense but keeping room for
    // income categories (event fees, sponsorships) lets the dashboard show
    // a symmetric revenue-by-category chart later.
    kind:       text("kind").notNull().default("expense"),
    sort_order: integer("sort_order").notNull().default(0),
    active:     boolean("active").notNull().default(true),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("expense_categories_code_uq").on(t.code),
    index("expense_categories_active_idx").on(t.active, t.sort_order),
  ],
);

// ─── Vendor directory ─────────────────────────────────────────────────────
// Frequent vendors the branch pays: caterers, print shops, AV rental,
// hotels for chairman visits, etc. Linked from bills.vendor_id so the
// dashboard can show "top vendors YTD" and bill-entry autofills GSTIN /
// PAN when a treasurer types a familiar name.
export const vendors = pgTable(
  "vendors",
  {
    id:               uuid("id").primaryKey().defaultRandom(),
    name:             text("name").notNull(),
    contact_person:   text("contact_person"),
    contact_phone:    text("contact_phone"),
    contact_email:    text("contact_email"),
    address:          text("address"),
    gstin:            text("gstin"),
    pan:              text("pan"),
    default_category_id: uuid("default_category_id").references(() => expenseCategories.id, { onDelete: "set null" }),
    notes:            text("notes"),
    active:           boolean("active").notNull().default(true),
    created_at:       timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:       timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deleted_at:       timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("vendors_active_idx").on(t.active),
    // Case-insensitive name-uniqueness would be nice but the CI collation
    // isn't universally supported — leave the app layer to dedupe on the
    // create form via a live search.
  ],
);
