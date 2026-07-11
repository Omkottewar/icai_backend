// Adds extra student-suggestion topics on top of the 5 defaults seeded by
// migration 0059 (curriculum / events / facilities / mentorship / other).
//
// Idempotent — ON CONFLICT (branch_id, code) DO NOTHING per the unique
// constraint from migration 0059. Re-running never dupes; codes that
// already exist keep their existing name/description/sort_order.
//
// Usage:  node scripts/seed-more-suggestion-topics.mjs

import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

// sort_order slots the new topics between the seeded ones. Existing seed
// uses 10/20/30/40/90 (curriculum, events, facilities, mentorship, other),
// so we pick values that keep a sensible reading order in the dropdown.
const TOPICS = [
  {
    code: "articleship",
    name: "Articleship Experience",
    description: "Firm rotation, working hours, stipend, mentorship inside firms",
    sort_order: 35,
  },
  {
    code: "placements",
    name: "Placements & Careers",
    description: "Campus placements, job openings, career guidance post-qualification",
    sort_order: 45,
  },
  {
    code: "mock_tests",
    name: "Mock Tests & Study Material",
    description: "Practice papers, revision resources, past-year question banks",
    sort_order: 15,
  },
  {
    code: "study_groups",
    name: "Study Groups & Peer Learning",
    description: "Peer study circles, group revisions, collaborative preparation",
    sort_order: 25,
  },
  {
    code: "wellness",
    name: "Wellness & Mental Health",
    description: "Stress management, counselling, work-study balance",
    sort_order: 55,
  },
  {
    code: "soft_skills",
    name: "Soft Skills & Communication",
    description: "English fluency, presentation skills, interview preparation",
    sort_order: 60,
  },
  {
    code: "tech_tools",
    name: "Tech & Digital Tools",
    description: "Excel, ERP, tally, e-filing utilities, IT training",
    sort_order: 65,
  },
  {
    code: "scholarships",
    name: "Scholarships & Financial Aid",
    description: "CABF, ICAI scholarships, fee concessions, income-based support",
    sort_order: 70,
  },
  {
    code: "sports_cultural",
    name: "Sports & Cultural",
    description: "WICASA sports meet, cultural events, extracurricular activities",
    sort_order: 75,
  },
  {
    code: "alumni",
    name: "Alumni Interaction",
    description: "Seniors and alumni networking, career journey talks",
    sort_order: 80,
  },
];

try {
  // Look up the NGP branch (matches migration 0059's seed guard).
  const branchRows = await sql`SELECT id FROM branches WHERE code = 'NGP' LIMIT 1`;
  if (branchRows.length === 0) {
    console.error("✗ Branch NGP not found. Create the branch first.");
    process.exit(1);
  }
  const branchId = branchRows[0].id;

  let inserted = 0;
  let skipped = 0;
  for (const t of TOPICS) {
    const rows = await sql`
      INSERT INTO student_suggestion_topics (branch_id, code, name, description, sort_order)
      VALUES (${branchId}, ${t.code}, ${t.name}, ${t.description}, ${t.sort_order})
      ON CONFLICT (branch_id, code) DO NOTHING
      RETURNING id
    `;
    if (rows.length > 0) {
      console.log(`✓ ${t.code.padEnd(18)} — ${t.name}`);
      inserted++;
    } else {
      console.log(`= ${t.code.padEnd(18)} — already exists, skipped`);
      skipped++;
    }
  }

  console.log(`\nDone. ${inserted} topic${inserted === 1 ? "" : "s"} inserted, ${skipped} already present.`);
} catch (err) {
  console.error("✗ Failed:", err.message);
  if (err.detail) console.error("  detail:", err.detail);
  process.exitCode = 1;
} finally {
  await sql.end();
}
