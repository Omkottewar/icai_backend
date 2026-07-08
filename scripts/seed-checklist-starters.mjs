// Seeds the branch's paper-form checklist templates as excel-style
// checklist_table questions. Two starters:
//
//   1. Event Preparation Checklist — 4 columns (Item / Qty & Detail /
//      Person / Status). Rows match the branch's paper checklist across
//      the 3 pages (stage, inaugural, AV, kits, hospitality, catering).
//
//   2. Draft Budget — 2 columns (Item / Amount). Rows match the paper
//      budget sheet; TOTAL EXPENSES is a total row (auto-sums), and
//      Profit / (Loss) is a computed row (Income − TOTAL EXPENSES).
//
// Idempotent — re-runs delete any is_starter=true rows not in STARTERS,
// then delete-and-insert the two here. User-created templates are not
// touched (is_starter check).

import "dotenv/config";
import postgres from "postgres";
import crypto from "node:crypto";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}
const sql = postgres(url, { max: 1, prepare: false });

// ─── Small helpers ──────────────────────────────────────────────────────
function q(type, label, opts = {}) {
  return {
    type,
    label,
    help_text: opts.help_text || null,
    required: opts.required !== false,
    config: opts.config || {},
    section_owner_role: opts.section_owner_role || null,
  };
}

// Column definitions used by both templates.
const PREP_COLUMNS = [
  { key: "quantity", label: "Qty / Detail", type: "text" },
  { key: "person",   label: "Person",       type: "text" },
  { key: "status",   label: "Status",       type: "status" },
];
const BUDGET_COLUMNS = [
  { key: "amount", label: "Amt (Rs.)", type: "money" },
];

// ─── Event Preparation Checklist rows ───────────────────────────────────
// Rows match the branch's paper form across all 3 pages. Hints in
// parentheses reproduce the quantity / detail hints from the scan.
const PREP_ROWS = [
  { id: "podium",              label: "Podium",                       kind: "data" },
  { id: "reg_tables",          label: "Registration Tables with Chairs", kind: "data" },
  { id: "attendance_sheet",    label: "Attendance Sheet",             kind: "data" },
  { id: "press_release",       label: "Press Release",                kind: "data" },
  { id: "photographer",        label: "Photographer",                 kind: "data" },
  { id: "sweet_faculty",       label: "Sweet for Faculty",            kind: "data", hint: "6 Box" },
  { id: "led_screen",          label: "LED / Screen / Laptop",        kind: "data" },
  { id: "sound_mikes",         label: "Sound System / Mikes",         kind: "data", hint: "2 Cordless / 1 Collar Mike" },
  { id: "slide_changer",       label: "Slide Changer",                kind: "data" },
  { id: "tv_arrangement",      label: "TV Arrangement",               kind: "data" },
  { id: "pickup",              label: "Pickup of Guest / Faculty",    kind: "data" },
  { id: "cab",                 label: "Cab",                          kind: "data" },
  { id: "room_booking",        label: "Room Booking",                 kind: "data" },
  { id: "travel_plan",         label: "Travel Plan",                  kind: "data" },
  { id: "boarding_pass",       label: "Boarding Pass",                kind: "data" },
  { id: "backdrop",            label: "Backdrop",                     kind: "data" },
  { id: "standee",             label: "Standee",                      kind: "data" },
  { id: "flower_arrangement",  label: "Flower Arrangement",           kind: "data", hint: "Podium bouquet, Table bouquet, Samai garland" },
  { id: "pad_on_dias",         label: "Pad on Dias",                  kind: "data" },
  { id: "pen_on_dias",         label: "Pen on Dias",                  kind: "data" },
  { id: "circular_on_dias",    label: "Circular on Dias",             kind: "data" },
  { id: "program_schedule",    label: "Program Schedule on Dias",     kind: "data" },
  { id: "motto_sing",          label: "Motto Singing",                kind: "data" },
  { id: "bio_data",            label: "Speaker Bio-Data",             kind: "data" },
  { id: "samai_cotton",        label: "Samai (with Cotton)",          kind: "data" },
  { id: "candle",              label: "Candle",                       kind: "data" },
  { id: "match_box",           label: "Match Box",                    kind: "data" },
  { id: "name_plates",         label: "Name Plates",                  kind: "data" },
  { id: "saplings",            label: "Saplings",                     kind: "data", hint: "1 per felicitated guest" },
  { id: "mementos",            label: "Mementos",                     kind: "data", hint: "1 per faculty / guest" },
  { id: "kit_pad",             label: "Kit — Pad",                    kind: "data", hint: "50" },
  { id: "kit_folder",          label: "Kit — Plastic Folder",         kind: "data", hint: "50" },
  { id: "kit_pen",             label: "Kit — Pen",                    kind: "data", hint: "50" },
  { id: "hall_arrangement",    label: "Hall Arrangement",             kind: "data" },
  { id: "sound_mike_system",   label: "Sound & Mike System",          kind: "data" },
  { id: "laptop",              label: "Laptop",                       kind: "data" },
  { id: "catering_menu",       label: "Catering & Menu",              kind: "data" },
  { id: "car",                 label: "Car",                          kind: "data" },
  { id: "complementary_room",  label: "Complementary Room",           kind: "data" },
  { id: "hi_tea_menu",         label: "Hi-Tea Menu",                  kind: "data" },
  { id: "jain_food",           label: "Jain Food",                    kind: "data" },
];

// ─── Draft Budget rows ──────────────────────────────────────────────────
// Rows match the paper Draft Budget sheet exactly. TOTAL EXPENSES is a
// total row (auto-sums the amount column of all data rows above it).
// Profit / (Loss) is a computed row (income_fee - total_expenses).
const BUDGET_ROWS = [
  { id: "food",             label: "Food Expenses (Tea, snacks, Drinking water, Lunch)", kind: "data" },
  { id: "hall_charges",     label: "Hall Charges",                             kind: "data" },
  { id: "photography",      label: "Photography Expenses",                     kind: "data" },
  { id: "banner",           label: "Banner / Backdrop Expenses",               kind: "data" },
  { id: "flowers",          label: "Cost of Flowers / Bouquets",               kind: "data" },
  { id: "mementos",         label: "Cost of Mementos for Faculty",             kind: "data" },
  { id: "travel_faculty",   label: "Travel cost of Faculty",                   kind: "data" },
  { id: "cab_charges",      label: "Cab Charges for Faculty & Guests",         kind: "data" },
  { id: "kits",             label: "Cost of Kits",                             kind: "data" },
  { id: "misc",             label: "Misc. Expenses, if any (Specify)",         kind: "data" },
  { id: "mass_sms",         label: "Mass SMS Charges",                         kind: "data" },
  { id: "total_expenses",   label: "TOTAL EXPENSES",                           kind: "total",    total_of: "amount" },
  { id: "income_fee",       label: "Income from Fee",                          kind: "data" },
  { id: "profit_loss",      label: "Profit / (Loss)",                          kind: "computed", total_of: "amount", formula: "income_fee - total_expenses" },
];

// ─── Starter definitions ────────────────────────────────────────────────
const STARTERS = [
  {
    name: "Event Preparation Checklist",
    description: "Branch's paper event-day checklist as an excel-style table. One row per item with Qty / Person / Status columns. Covers stage, inaugural session, AV, kits, hospitality, catering.",
    category: "Event day",
    fill_role: "committee_chairman",
    review_role: "branch_chairman",
    questions: [
      q("checklist_table", "Event Preparation Checklist", {
        help_text: "Fill Qty / Detail, assign the responsible person, and mark status for each item. Leave 'Status' as N/A for items that don't apply.",
        config: { columns: PREP_COLUMNS, rows: PREP_ROWS },
      }),
    ],
  },
  {
    name: "Draft Budget",
    description: "Branch's paper Draft Budget sheet as an excel-style table. TOTAL EXPENSES auto-sums the amount column; Profit / (Loss) is auto-computed as Income − Total Expenses.",
    category: "Event approval",
    fill_role: "committee_chairman",
    review_role: "branch_treasurer",
    questions: [
      q("checklist_table", "Draft Budget", {
        help_text: "Enter expense line-items and income from fee. Total and profit/loss compute automatically.",
        config: { columns: BUDGET_COLUMNS, rows: BUDGET_ROWS },
      }),
    ],
  },
];

// ─── Run ────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Seeding ${STARTERS.length} starter template(s)...`);

  // Sweep any starter rows whose names are no longer in STARTERS.
  const keepNames = STARTERS.map((s) => s.name);
  const orphaned = await sql`
    SELECT id, name FROM checklist_templates
    WHERE is_starter = true
      AND deleted_at IS NULL
      AND name <> ALL(${keepNames})
  `;
  for (const row of orphaned) {
    await sql`DELETE FROM checklist_templates WHERE id = ${row.id}`;
    console.log(`  ✗ removed retired starter: ${row.name}`);
  }

  for (const s of STARTERS) {
    await sql.begin(async (tx) => {
      const existing = await tx`
        SELECT id FROM checklist_templates
        WHERE name = ${s.name} AND is_starter = true AND deleted_at IS NULL
      `;
      for (const row of existing) {
        await tx`DELETE FROM checklist_templates WHERE id = ${row.id}`;
      }

      const family_id = crypto.randomUUID();
      const [tpl] = await tx`
        INSERT INTO checklist_templates
          (family_id, version, name, description, category, fill_role, review_role,
           is_published, is_starter)
        VALUES
          (${family_id}, 1, ${s.name}, ${s.description}, ${s.category},
           ${s.fill_role}, ${s.review_role},
           false, true)
        RETURNING id
      `;

      for (let i = 0; i < s.questions.length; i++) {
        const qn = s.questions[i];
        await tx`
          INSERT INTO checklist_template_questions
            (template_id, sort_order, type, label, help_text, required, config, section_owner_role)
          VALUES
            (${tpl.id}, ${i}, ${qn.type}, ${qn.label}, ${qn.help_text ?? null},
             ${qn.required !== false}, ${sql.json(qn.config || {})},
             ${qn.section_owner_role ?? null})
        `;
      }

      await tx`
        UPDATE checklist_templates
        SET is_published = true, published_at = now()
        WHERE id = ${tpl.id}
      `;
      console.log(`  ✓ ${s.name}  (${s.questions.length} question, ${s.questions[0].config.rows.length} rows)`);
    });
  }

  console.log("\n✓ Starter templates seeded.");
}

try {
  await main();
} catch (err) {
  console.error("Seed failed:", err);
  process.exitCode = 1;
} finally {
  await sql.end();
}
