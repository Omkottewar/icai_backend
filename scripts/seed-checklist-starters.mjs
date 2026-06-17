// Seeds the 4 curated starter checklist templates.
//
// What this gives you in the UI: when a chairman clicks "+ New template",
// they see a gallery of these 4 cards. One click clones the chosen starter
// into a fresh, editable draft owned by them. From 15+ clicks to 2.
//
// Idempotent: re-running upserts by name (deletes the existing starter row
// of the same name + its questions, then re-inserts). Safe to re-run after
// content edits — no orphan rows, no duplicates.
//
// Run with:  node scripts/seed-checklist-starters.mjs
//
// IMPORTANT: this script does NOT touch user-created templates. Only rows
// with is_starter=true that match the seeded names are replaced.

import "dotenv/config";
import postgres from "postgres";
import crypto from "node:crypto";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL must be set");
  process.exit(1);
}
const sql = postgres(url, { max: 1, prepare: false });

// ─── Question library ─────────────────────────────────────────────────────
// Re-implementing the structure from frontend/src/lib/checklistQuestions.js
// so the seed has zero frontend dependency at run time. If you change one,
// keep the other in sync (or extract a shared JSON file later).

function section(title, owner_role) {
  return { type: "section_heading", label: title, required: false, section_owner_role: owner_role || null, config: {} };
}
function q(type, label, opts = {}) {
  return {
    type,
    label,
    help_text: opts.help_text || null,
    required: opts.required !== false,
    config: opts.config || {},
  };
}

// Choice question shorthand. `options` is an array of { value, label }.
function dropdown(label, options, opts = {}) {
  return q("dropdown", label, { ...opts, config: { options } });
}
function checkbox(label, options, opts = {}) {
  return q("checkbox", label, { ...opts, config: { options } });
}

// Common section blocks reused across starters. Kept here (not as functions
// you call once) so each starter gets its OWN copy of every row — questions
// belong to one template_id and can't be shared.
function eventBasicsSection() {
  return [
    section("Event basics", "committee_chairman"),
    q("short_text", "Event title"),
    dropdown("Programme type", [
      { value: "cpe_seminar", label: "CPE Seminar" },
      { value: "study_circle", label: "Study Circle Meet" },
      { value: "workshop", label: "Workshop" },
      { value: "conference", label: "Conference" },
      { value: "revisionary", label: "One-Day Revisionary Batch" },
      { value: "other", label: "Other" },
    ]),
    q("long_text", "Brief description (80–200 words)"),
    q("date", "Event date"),
    q("time_range", "Event time", { help_text: "Start and end time" }),
  ];
}
function venueSection() {
  return [
    section("Venue & logistics", "committee_chairman"),
    dropdown("Mode", [
      { value: "physical", label: "Physical" },
      { value: "online", label: "Online" },
      { value: "hybrid", label: "Hybrid" },
    ]),
    q("short_text", "Venue or online URL"),
    q("number", "Capacity (max attendees)"),
    q("file", "Banner image", { required: false }),
  ];
}
function speakersSection() {
  return [
    section("Speakers & agenda", "branch_vice_chairman"),
    q("short_text", "Speaker name & designation"),
    q("long_text", "Speaker bio (1–2 sentences)"),
    q("file", "Speaker photo", { required: false }),
    q("long_text", "Agenda", { help_text: "One session per line" }),
    q("number", "CPE hours", { help_text: "Half-hour increments" }),
    dropdown("CPE eligibility", [
      { value: "structured", label: "Structured" },
      { value: "unstructured", label: "Unstructured" },
      { value: "na", label: "N/A" },
    ]),
  ];
}
function registrationSection() {
  return [
    section("Registration & pricing", "committee_chairman"),
    q("money", "Fee — Members"),
    q("money", "Fee — Students"),
    q("money", "Fee — Non-members", { required: false }),
    q("date", "Registration close date"),
    q("yes_no", "Spot registration allowed?"),
    q("yes_no", "Waitlist beyond capacity?"),
  ];
}
function budgetSection() {
  return [
    section("Budget & IUT", "branch_treasurer"),
    q("budget_table", "Event budget", { config: { faculty_count: 6 } }),
    q("yes_no", "Does this event involve IUT?"),
    q("long_text", "IUT details (from-account, to-account, purpose)", { required: false }),
    q("file", "Sponsor letter (if any)", { required: false }),
  ];
}
function complianceSection() {
  return [
    section("Compliance & disclaimers", "committee_chairman"),
    q("yes_no", "GST applicable on fees?"),
    q("yes_no", "Photography / video consent collected?"),
    q("yes_no", "Refund policy stated on the registration page?"),
  ];
}
function tasksSection() {
  return [
    section("Tasks to assign", "committee_chairman"),
    q("task_list", "Pre-event task list", {
      help_text: "Add one row per task. Pick the assignee and the due date.",
    }),
  ];
}

// ─── Starter definitions ─────────────────────────────────────────────────

const STARTERS = [
  {
    name: "CPE Seminar",
    description: "Standard CPE event — speakers, CPE hours, venue, registration, budget. The everyday workhorse for branch programmes.",
    category: "Event approval",
    fill_role: "committee_chairman",
    review_role: "branch_chairman",
    questions: [
      ...eventBasicsSection(),
      ...venueSection(),
      ...speakersSection(),
      ...registrationSection(),
      ...budgetSection(),
    ],
  },
  {
    name: "Workshop / Training",
    description: "Multi-day workshop or training programme — adds compliance disclaimers and a pre-event task list on top of the CPE Seminar checklist.",
    category: "Event approval",
    fill_role: "committee_chairman",
    review_role: "branch_chairman",
    questions: [
      ...eventBasicsSection(),
      ...venueSection(),
      ...speakersSection(),
      ...registrationSection(),
      ...budgetSection(),
      ...complianceSection(),
      ...tasksSection(),
    ],
  },
  {
    name: "Study Circle Meeting",
    description: "Lightweight recurring study circle — no fee, no budget table. Just date/time, speaker, agenda, CPE.",
    category: "Event approval",
    fill_role: "committee_chairman",
    review_role: "branch_chairman",
    questions: [
      ...eventBasicsSection(),
      section("Venue", "committee_chairman"),
      dropdown("Mode", [
        { value: "physical", label: "Physical" },
        { value: "online", label: "Online" },
      ]),
      q("short_text", "Venue or online URL"),
      q("number", "Expected attendance", { required: false }),
      ...speakersSection(),
    ],
  },
  {
    name: "Post-Event Bills & Closure",
    description: "Run AFTER an event — bills approval, vendor payments, IUT settlement, completion certificate. Treasurer & accountant flow.",
    category: "Post-event bills",
    fill_role: "branch_treasurer",
    review_role: "branch_chairman",
    questions: [
      section("Event reference", "committee_chairman"),
      q("short_text", "Event title"),
      q("date", "Event date"),
      q("number", "Actual attendance"),
      q("long_text", "Brief post-event note (3–5 lines)", { required: false }),

      section("Bills & vendor payments", "branch_treasurer"),
      q("task_list", "Vendor bills received", {
        help_text: "One task per vendor — assignee handles verification + payment.",
      }),
      q("money", "Total expenses (actual)"),
      q("money", "Total revenue (actual)"),
      q("file", "Bills bundle (scanned PDF)"),

      section("IUT settlement", "branch_treasurer"),
      q("yes_no", "Was IUT involved?"),
      q("long_text", "IUT settlement summary", { required: false, help_text: "From-account / to-account / amount / status" }),
      q("file", "IUT proof of transfer", { required: false }),

      section("Closure", "branch_chairman"),
      q("yes_no", "CPE hours uploaded to ICAI portal?"),
      q("yes_no", "Completion certificate issued to participants?"),
      q("long_text", "Lessons learned / things to repeat", { required: false }),
    ],
  },
];

// ─── Run ─────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Seeding ${STARTERS.length} starter template(s)...`);

  for (const s of STARTERS) {
    await sql.begin(async (tx) => {
      // Remove any existing starter row with this name so re-runs upsert.
      // We DON'T touch user-created rows (is_starter check), even if the
      // name collides.
      const existing = await tx`
        SELECT id FROM checklist_templates
        WHERE name = ${s.name} AND is_starter = true AND deleted_at IS NULL
      `;
      for (const row of existing) {
        // Cascade FK on template_id removes the question rows.
        await tx`DELETE FROM checklist_templates WHERE id = ${row.id}`;
      }

      // Insert the template as DRAFT first — the DB trigger
      // lock_published_template_questions() blocks question inserts when
      // is_published=true. We publish in a second UPDATE after the rows
      // land.
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

      // Bulk-insert the question rows in declared order.
      for (let i = 0; i < s.questions.length; i++) {
        const q = s.questions[i];
        await tx`
          INSERT INTO checklist_template_questions
            (template_id, sort_order, type, label, help_text, required, config, section_owner_role)
          VALUES
            (${tpl.id}, ${i}, ${q.type}, ${q.label}, ${q.help_text ?? null},
             ${q.required !== false}, ${sql.json(q.config || {})},
             ${q.section_owner_role ?? null})
        `;
      }

      // Now flip to published so the row is treated as final.
      await tx`
        UPDATE checklist_templates
        SET is_published = true, published_at = now()
        WHERE id = ${tpl.id}
      `;
      console.log(`  ✓ ${s.name}  (${s.questions.length} items)`);
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
