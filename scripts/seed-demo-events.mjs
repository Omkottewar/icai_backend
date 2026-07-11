// Seeds a handful of upcoming free events so the Events page has something
// to register for (and the WhatsApp-style event chat has somewhere to land).
//
// Idempotent — uses ON CONFLICT (slug) DO NOTHING. Safe to re-run.
// Dates are relative to "now" so the events always show up no matter when
// you run this.
//
// Usage:  node scripts/seed-demo-events.mjs

import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

// Each event uses the committee code (see scripts/seed-committees.mjs).
// daysFromNow is the offset for starts_at — ends_at is always +2 hours.
const EVENTS = [
  {
    slug: "demo-gst-annual-return-2026",
    title: "GST Annual Return Filing — Practical Workshop",
    committee_code: "GST",
    audience: "members",
    mode: "in_person",
    venue: "Hotel Centre Point, Nagpur",
    daysFromNow: 3,

    capacity: 120,
    highlights: [
      "Step-by-step GSTR-9 and GSTR-9C preparation",
      "Reconciliation of books with returns filed",
      "Common errors that trigger departmental notices",
    ],
  },
  {
    slug: "demo-forensic-audit-masterclass-2026",
    title: "Forensic Audit Masterclass with Live Case Studies",
    committee_code: "AUDIT",
    audience: "members",
    mode: "in_person",
    venue: "ICAI Bhawan, Nagpur",
    daysFromNow: 5,

    capacity: 80,
    highlights: [
      "Investigating financial irregularities",
      "Documentation that holds up in litigation",
      "Live case study walkthroughs",
    ],
  },
  {
    slug: "demo-ai-tools-for-cas-2026",
    title: "AI & Automation in CA Practice",
    committee_code: "IT",
    audience: "members",
    mode: "online",
    venue: "Online (Zoom)",
    daysFromNow: 7,

    capacity: 200,
    highlights: [
      "Practical AI tools for audit, tax and advisory work",
      "Automating routine documentation and research",
      "Data privacy and professional caution",
    ],
  },
  {
    slug: "demo-itr-walkthrough-ay-26-27",
    title: "Income Tax Return — AY 26-27 Walkthrough",
    committee_code: "DIRECT_TAX",
    audience: "members",
    mode: "in_person",
    venue: "Chitnavis Centre, Nagpur",
    daysFromNow: 12,

    capacity: 150,
    highlights: [
      "Schema changes for AY 26-27",
      "Common return-filing errors and how to avoid them",
      "Live walkthrough of complex schedules",
    ],
  },
  {
    slug: "demo-wicasa-mock-test-foundation-2026",
    title: "WICASA Mock Test Series — Foundation",
    committee_code: "WICASA",
    audience: "students",
    mode: "in_person",
    venue: "Branch Premises, Nagpur",
    daysFromNow: 9,

    capacity: 100,
    highlights: [
      "Full-syllabus mocks under exam conditions",
      "Detailed answer-key discussion and evaluation",
      "Time-management and answer-presentation tips",
    ],
  },
  {
    slug: "demo-annual-regional-conference-2026",
    title: "Annual Regional Conference 2026",
    committee_code: "CPE",
    audience: "all",
    mode: "in_person",
    venue: "Hotel Tuli Imperial, Nagpur",
    daysFromNow: 21,

    capacity: 400,
    highlights: [
      "Two days of technical sessions across domains",
      "National-level faculty and panel discussions",
      "Networking with peers from across the region",
    ],
  },
];

function daysFromNowIso(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(10, 0, 0, 0);
  return d.toISOString();
}

try {
  // Load committee id-by-code map once.
  const committeeRows = await sql`SELECT id, code FROM committees`;
  const committeeIdByCode = new Map(committeeRows.map((r) => [r.code, r.id]));

  const missing = EVENTS.filter((e) => !committeeIdByCode.has(e.committee_code));
  if (missing.length) {
    console.error(
      `✗ Missing committees in DB: ${missing.map((e) => e.committee_code).join(", ")}.`,
      `Run \`node scripts/seed-committees.mjs\` first.`,
    );
    process.exit(1);
  }

  let inserted = 0;
  for (const e of EVENTS) {
    const startsAt = daysFromNowIso(e.daysFromNow);
    const endsAt   = new Date(new Date(startsAt).getTime() + 2 * 3600 * 1000).toISOString();

    const result = await sql`
      INSERT INTO events (
        slug, title, committee_id, audience, mode, venue,
        starts_at, ends_at, fee_paise, capacity, status, highlights
      ) VALUES (
        ${e.slug}, ${e.title}, ${committeeIdByCode.get(e.committee_code)},
        ${e.audience}, ${e.mode}, ${e.venue},
        ${startsAt}, ${endsAt},
        0, ${e.capacity}, 'published',
        ${e.highlights}
      )
      ON CONFLICT (slug) DO NOTHING
      RETURNING id
    `;
    if (result.length > 0) {
      console.log(`✓ Inserted ${e.slug} — ${e.title}`);
      inserted++;
    } else {
      console.log(`= ${e.slug} already exists`);
    }
  }
  console.log(`\nDone. ${inserted} event${inserted === 1 ? "" : "s"} inserted.`);
} catch (err) {
  console.error("✗ Failed:", err.message);
  if (err.detail) console.error("  detail:", err.detail);
  process.exitCode = 1;
} finally {
  await sql.end();
}
