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

// ─── Event Preparation Checklist rows (three sections, matching paper) ──
// The branch's paper checklist spans 3 pages. Each page is a distinct
// section here — the "Who fills each section?" modal renders one card per
// section so a different filler / approver can be assigned to each.
//
// Row hints in the `hint` field mirror the qty / detail column on the
// paper. The paper's "Person" column is left empty at seed time — that's
// per-instance data, filled in when the checklist is used for a real event.

// Section 1 — General event setup (paper page 1).
const PREP1_ROWS = [
  { id: "s1_podium",         label: "Podium",                          kind: "data" },
  { id: "s1_reg_tables",     label: "Registration Tables with Chairs", kind: "data" },
  { id: "s1_attendance",     label: "Attendance Sheet",                kind: "data" },
  { id: "s1_press_release",  label: "Press Release",                   kind: "data" },
  { id: "s1_photographer",   label: "Photographer",                    kind: "data" },
  { id: "s1_sweet_faculty",  label: "Sweet for Faculty",               kind: "data", hint: "6 Box" },
  { id: "s1_led_screen",     label: "LED / Screen / Laptop",           kind: "data" },
  { id: "s1_sound_mikes",    label: "Sound System / Mikes",            kind: "data", hint: "2 Cordless / 1 Collar Mike" },
  { id: "s1_slide_changer",  label: "Slide Changer",                   kind: "data" },
  { id: "s1_tv_arrangement", label: "TV Arrangement",                  kind: "data" },
  { id: "s1_pickup",         label: "Pickup of Guest / Faculty",       kind: "data" },
  { id: "s1_cab",            label: "Cab",                             kind: "data" },
  { id: "s1_room_booking",   label: "Room Booking",                    kind: "data" },
  { id: "s1_travel_plan",    label: "Travel Plan",                     kind: "data" },
  { id: "s1_boarding_pass",  label: "Boarding Pass",                   kind: "data" },
];

// Section 2 — Inaugural / event-day items (paper page 2).
const PREP2_ROWS = [
  { id: "s2_backdrop",         label: "Backdrop",                    kind: "data" },
  { id: "s2_standee",          label: "Standee",                     kind: "data" },
  { id: "s2_flower",           label: "Flower Arrangement",          kind: "data", hint: "Podium bouquet, Table bouquet, Samai garland" },
  { id: "s2_pad_on_dias",      label: "Pad on Dias",                 kind: "data" },
  { id: "s2_pen_on_dias",      label: "Pen on Dias",                 kind: "data" },
  { id: "s2_circular_on_dias", label: "Circular on Dias",            kind: "data" },
  { id: "s2_program_schedule", label: "Program Schedule on Dias",    kind: "data" },
  { id: "s2_motto_sing",       label: "Motto Singing",               kind: "data" },
  { id: "s2_bio_data",         label: "Speaker Bio-Data",            kind: "data" },
  { id: "s2_samai_cotton",     label: "Samai (with Cotton)",         kind: "data" },
  { id: "s2_candle",           label: "Candle",                      kind: "data" },
  { id: "s2_match_box",        label: "Match Box",                   kind: "data" },
  { id: "s2_name_plates",      label: "Name Plates",                 kind: "data" },
  { id: "s2_saplings",         label: "Saplings",                    kind: "data", hint: "1 per felicitated guest" },
  { id: "s2_mementos",         label: "Mementos",                    kind: "data", hint: "1 per faculty / guest" },
  { id: "s2_kit_pad",          label: "Kit — Pad",                   kind: "data", hint: "50" },
  { id: "s2_kit_folder",       label: "Kit — Plastic Folder",        kind: "data", hint: "50" },
  { id: "s2_kit_pen",          label: "Kit — Pen",                   kind: "data", hint: "50" },
  { id: "s2_hall",             label: "Hall Arrangement",            kind: "data" },
  { id: "s2_sound_mike_sys",   label: "Sound & Mike System",         kind: "data" },
  { id: "s2_laptop",           label: "Laptop",                      kind: "data" },
  { id: "s2_attendance",       label: "Attendance Sheet",            kind: "data" },
  { id: "s2_catering",         label: "Catering & Menu",             kind: "data" },
];

// Section 3 — Faculty & hospitality (paper page 3).
const PREP3_ROWS = [
  { id: "s3_photographer",     label: "Photographer",             kind: "data" },
  { id: "s3_travel_plan",      label: "Travel Plan",              kind: "data" },
  { id: "s3_boarding_pass",    label: "Boarding Pass",            kind: "data" },
  { id: "s3_car",              label: "Car",                      kind: "data" },
  { id: "s3_room_booking",     label: "Room Booking",             kind: "data", hint: "NA if not required" },
  { id: "s3_pickup",           label: "Pickup of Guest / Faculty", kind: "data", hint: "NA if not required" },
  { id: "s3_sweet_faculty",    label: "Sweet for Faculty",        kind: "data", hint: "NA if not required" },
  { id: "s3_press_release",    label: "Press Release",            kind: "data" },
  { id: "s3_complementary",    label: "Complementary Room",       kind: "data", hint: "NA if not required" },
  { id: "s3_hi_tea",           label: "Hi-Tea Menu",              kind: "data" },
  { id: "s3_jain_food",        label: "Jain Food",                kind: "data" },
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

// ─── IUT (Inter-Unit Transfer) rows ─────────────────────────────────────
// Captures the money owed to / by another ICAI unit after a joint event.
const IUT_COLUMNS = [
  { key: "counterparty", label: "Counterparty (branch / regional / HQ)", type: "text" },
  { key: "direction",    label: "Direction",                              type: "text",   help: "IN (money coming to Nagpur) or OUT (money leaving Nagpur)" },
  { key: "amount",       label: "Amt (Rs.)",                              type: "money" },
  { key: "reference",    label: "Reference / voucher #",                  type: "text" },
];
const IUT_ROWS = [
  { id: "faculty_share",   label: "Faculty share owed to home branch",         kind: "data" },
  { id: "shared_expenses", label: "Shared expenses (venue, catering split)",   kind: "data" },
  { id: "sponsorship",     label: "Sponsorship received from another unit",    kind: "data" },
  { id: "reimbursement",   label: "Reimbursement to be received",              kind: "data" },
  { id: "other_iut",       label: "Other (specify in Reference column)",       kind: "data" },
  { id: "total_iut",       label: "TOTAL IUT",                                 kind: "total", total_of: "amount" },
];

// ─── Starter definitions ────────────────────────────────────────────────
// Each starter is a single template with ONE section_heading question at
// the top followed by the actual table. The section_heading is what the
// event-checklist creation modal picks up to show the "who fills / who
// approves" pickers per section — without it, the template has no
// pickable section and the admin can't route it.
const STARTERS = [
  {
    name: "Event Preparation Checklist",
    description: "Branch's paper event-day checklist in three sections matching the paper pages: General Setup, Inaugural Session, and Faculty & Hospitality. Each section can be assigned its own filler and approver.",
    category: "Event day",
    fill_role: "committee_chairman",
    review_role: "branch_chairman",
    questions: [
      q("section_heading", "General Event Setup", {
        help_text: "Podium, registration, AV, transport, room bookings — everything for the branch team.",
        required: false,
        section_owner_role: "committee_chairman",
      }),
      q("checklist_table", "General Setup Items", {
        help_text: "Fill Qty / Detail, assign the responsible person, and mark status. Use N/A for items that don't apply.",
        config: { columns: PREP_COLUMNS, rows: PREP1_ROWS },
      }),
      q("section_heading", "Inaugural Session", {
        help_text: "Backdrop, dais items, flowers, kits, catering — everything for the ceremony.",
        required: false,
        section_owner_role: "committee_chairman",
      }),
      q("checklist_table", "Inaugural Session Items", {
        help_text: "Fill Qty / Detail, assign the responsible person, and mark status. Use N/A for items that don't apply.",
        config: { columns: PREP_COLUMNS, rows: PREP2_ROWS },
      }),
      q("section_heading", "Faculty & Hospitality", {
        help_text: "Speaker travel, stay, meals — everything the guest faculty needs.",
        required: false,
        section_owner_role: "committee_chairman",
      }),
      q("checklist_table", "Faculty & Hospitality Items", {
        help_text: "Fill Qty / Detail, assign the responsible person, and mark status. Use N/A for items that don't apply.",
        config: { columns: PREP_COLUMNS, rows: PREP3_ROWS },
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
      q("section_heading", "Budget", {
        help_text: "Draft budget for the event. Auto-sums total expenses and computes profit / loss.",
        required: false,
        section_owner_role: "branch_treasurer",
      }),
      q("checklist_table", "Draft Budget", {
        help_text: "Enter expense line-items and income from fee. Total and profit/loss compute automatically.",
        config: { columns: BUDGET_COLUMNS, rows: BUDGET_ROWS },
      }),
    ],
  },
  {
    name: "Inter-Unit Transfer (IUT)",
    description: "Money owed to / by other ICAI units after a joint or shared event. One row per counterparty; TOTAL IUT auto-sums the amount column.",
    category: "Event approval",
    fill_role: "committee_chairman",
    review_role: "branch_treasurer",
    questions: [
      q("section_heading", "IUT", {
        help_text: "Inter-Unit Transfer — money to send to or receive from another ICAI unit.",
        required: false,
        section_owner_role: "branch_treasurer",
      }),
      q("checklist_table", "Inter-Unit Transfers", {
        help_text: "One row per counterparty. Mark direction as IN (money coming in) or OUT (money going out).",
        config: { columns: IUT_COLUMNS, rows: IUT_ROWS },
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
      // Sum rows across every table in the template — a template with
      // multiple sections has one table per section.
      const rowCount = s.questions.reduce(
        (n, qn) => n + (Array.isArray(qn?.config?.rows) ? qn.config.rows.length : 0),
        0,
      );
      const sectionCount = s.questions.filter((qn) => qn.type === "section_heading").length;
      console.log(`  ✓ ${s.name}  (${s.questions.length} questions, ${sectionCount} section${sectionCount === 1 ? '' : 's'}, ${rowCount} total rows)`);
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
