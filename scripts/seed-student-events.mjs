// Seeds 8 realistic student-focused events (WICASA / branch programmes)
// so /events?audience=Students has meaningful content.
//
// Every event carries:
//   • audience = 'students' — appears on the student events filter.
//   • committee = WICASA (or CPE/BRANCH where student events sit under
//     a shared committee at your branch).
//   • Realistic titles, venues, capacity, and highlights.
//   • Fee kept at 0 or a token amount so students can register without
//     the payment flow blocking testing.
//   • Dates spread 5-80 days out so the events list has a healthy mix.
//
// Idempotent — ON CONFLICT (slug) DO NOTHING. Safe to re-run.
//
// Usage:
//   node scripts/seed-student-events.mjs
//   node scripts/seed-student-events.mjs --refresh   # bump dates & re-open registration

import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const REFRESH = process.argv.includes("--refresh");
const sql = postgres(url, { max: 1, prepare: false });

const daysFromNowIso = (n, hour = 10, minute = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};
const hoursLater = (iso, h) => new Date(new Date(iso).getTime() + h * 3600 * 1000).toISOString();

const EVENTS = [
  {
    slug: "student-articleship-orientation-2026",
    title: "Articleship Orientation Programme — Batch 2026",
    committee_code: "WICASA",
    audience: "students",
    mode: "in_person",
    venue: "ICAI Bhawan, Nagpur",
    daysFromNow: 6,
    hour: 9,
    duration_hours: 8,
    capacity: 120,
    fee_paise: 0,
    cpe_hours: "0",
    program_type: "orientation",
    speaker_name: "CA Rajendra Sarda, CA Meera Kulkarni",
    speaker_bio: "Senior CA Nagpur practitioners with 25+ years' articleship mentoring experience.",
    highlights: [
      "Rights, responsibilities and expectations during your articleship",
      "How to make the most of 3 years — rotation strategy across audit, tax, and advisory",
      "Real case-studies from articles who topped their CA finals",
      "Q&A with senior articles from Big-4 and boutique practices",
    ],
    description: "Mandatory orientation for students starting articleship this cycle. Covers ICAI rules, expectation-setting, and how to plan the 3-year training for both exam prep and practical mastery. Certificate issued on attendance.",
  },
  {
    slug: "student-mock-review-foundation-2026",
    title: "Foundation Mock Test — Live Review Session",
    committee_code: "WICASA",
    audience: "students",
    mode: "hybrid",
    venue: "Chitnavis Centre, Nagpur (also live on Zoom)",
    daysFromNow: 12,
    hour: 10,
    duration_hours: 4,
    capacity: 200,
    fee_paise: 0,
    cpe_hours: "0",
    program_type: "study_circle",
    speaker_name: "CA Faculty Panel",
    speaker_bio: "Nagpur branch's Foundation-level teaching panel walks through the November 2026 mock paper end-to-end.",
    highlights: [
      "Paper-by-paper answer walkthrough with common pitfalls flagged",
      "Time-management strategy — how top students allocate 3 hours",
      "Live Q&A: bring your specific question with your mock answer sheet",
      "Downloadable model answers shared post-session",
    ],
    description: "Detailed post-mock review of the Foundation mock paper. Bring your marked answer sheet — the panel picks 8-10 questions where students most commonly slip and rebuilds the solution live. Attendance strongly recommended before the actual attempt.",
  },
  {
    slug: "student-industry-visit-manufacturing-2026",
    title: "Industry Visit — Manufacturing Sector Deep Dive",
    committee_code: "WICASA",
    audience: "students",
    mode: "in_person",
    venue: "Buty Group Manufacturing, Butibori Industrial Area",
    daysFromNow: 20,
    hour: 9,
    duration_hours: 6,
    capacity: 45,
    fee_paise: 15000,
    cpe_hours: "0",
    program_type: "other",
    speaker_name: "CA Prashant Buty, Finance Head — Buty Group",
    speaker_bio: "Alumnus of Nagpur Branch, currently heading finance at a mid-size manufacturing group.",
    highlights: [
      "Shop-floor walk-through — cost accounting from raw material to finished goods",
      "Real-world MSME compliance — GST, TDS, and payroll for a 400-person unit",
      "Working capital management and vendor negotiation in a factory setup",
      "Career session: articles and CAs in industry roles vs practice",
    ],
    description: "Half-day exposure visit for students wanting to see how the accounting they study translates on the shop floor. Includes lunch, a plant tour, a session with the Finance Head, and a moderated Q&A. Transport pickup from ICAI Bhawan at 8:30 AM sharp. Limited to 45 seats.",
  },
  {
    slug: "student-cs-cma-cross-course-panel-2026",
    title: "Cross-Course Panel — CA + CS + CMA Together",
    committee_code: "WICASA",
    audience: "students",
    mode: "in_person",
    venue: "Hotel Centre Point, Nagpur",
    daysFromNow: 28,
    hour: 17,
    duration_hours: 3,
    capacity: 250,
    fee_paise: 0,
    cpe_hours: "0",
    program_type: "conference",
    speaker_name: "Panel — CA Vinod Deshmukh, CS Anjali Ranade, CMA Suraj Iyer",
    speaker_bio: "Three practitioners who have layered CS or CMA credentials on top of the CA qualification, sharing how each opens different practice areas.",
    highlights: [
      "When it makes sense to pursue CS/CMA alongside CA — signal vs noise",
      "Practice areas each qualification unlocks (secretarial audit, cost audit, compliance)",
      "Time-management strategy for students juggling multiple registrations",
      "Career paths in industry that value the CA+CS or CA+CMA combination",
    ],
    description: "Open panel discussion for students weighing whether to add a CS or CMA registration on top of their CA journey. Three practitioners each answer the same set of questions from their own qualification's perspective, followed by 45 minutes of audience Q&A.",
  },
  {
    slug: "student-personality-development-2026",
    title: "Personality & Communication Development Workshop",
    committee_code: "WICASA",
    audience: "students",
    mode: "in_person",
    venue: "ICAI Bhawan, Nagpur",
    daysFromNow: 35,
    hour: 10,
    duration_hours: 6,
    capacity: 80,
    fee_paise: 30000,
    cpe_hours: "0",
    program_type: "workshop",
    speaker_name: "Ms. Kavita Menon (Communication Coach)",
    speaker_bio: "Corporate trainer who has worked with Big-4 CA articleship cohorts and top law firms in Bengaluru and Mumbai.",
    highlights: [
      "Client-facing communication — how to introduce yourself, handle disagreement, and end a meeting",
      "Written English for professional correspondence — email tone, brief-writing, and template avoidance",
      "Presentation skills — from junior-article status meetings to article seminars",
      "Practical role-plays with instant feedback",
    ],
    description: "One-day intensive for CA articles and Final students. Practical drills — not lectures — on how to speak, write, and present in a professional context. Working lunch and printed workbook included. Limited to 80 seats to keep the role-play format tight.",
  },
  {
    slug: "student-excel-power-query-workshop-2026",
    title: "Excel Power Query & Power Pivot for Articles",
    committee_code: "WICASA",
    audience: "students",
    mode: "in_person",
    venue: "IT Lab, ICAI Bhawan, Nagpur",
    daysFromNow: 45,
    hour: 10,
    duration_hours: 6,
    capacity: 40,
    fee_paise: 25000,
    cpe_hours: "0",
    program_type: "workshop",
    speaker_name: "CA Rohan Kale (Data Practitioner)",
    speaker_bio: "Practising CA specialising in audit data analytics; runs Power Query training for firms across Vidarbha.",
    highlights: [
      "Power Query — ingesting messy client data (Tally exports, bank statements, GST reports)",
      "Building a self-refreshing 26AS reconciliation model",
      "Pivoting large transaction sets without formula-tangle",
      "Sampling techniques for audit — how top firms actually pick their samples",
    ],
    description: "Hands-on lab session — bring your laptop with Excel 365 or 2019+ installed. Every attendee walks out with three production-ready templates (26AS recon, GST 3B vs 2B recon, and TDS 26Q consolidation) they can start using at their firm the next day. Lab seats capped at 40 — one workstation per student.",
  },
  {
    slug: "student-taxation-crash-course-inter-2026",
    title: "CA Inter Taxation — 3-Day Crash Course (Nov 2026 attempt)",
    committee_code: "WICASA",
    audience: "students",
    mode: "in_person",
    venue: "Nagpur Branch Conference Hall",
    daysFromNow: 50,
    hour: 9,
    duration_hours: 8,
    capacity: 150,
    fee_paise: 100000,
    cpe_hours: "0",
    program_type: "revisionary",
    speaker_name: "CA Faculty Team",
    speaker_bio: "Six senior CAs, each with 10+ years teaching CA Inter Taxation.",
    highlights: [
      "Day 1: Income Tax basics through Salaries and House Property",
      "Day 2: PGBP, Capital Gains, and clubbing provisions with numeric drills",
      "Day 3: GST — supply, ITC, place of supply, and registration",
      "Model paper solved live on the last day",
    ],
    description: "Structured 3-day revision for students appearing in the November 2026 Inter Group 1 exam. Working lunch and printed handouts included. Attendance is tracked — students who attend all 3 days receive a completion certificate signed by the branch chairman.",
  },
  {
    slug: "student-annual-fest-wicasa-2026",
    title: "WICASA Annual Fest — Sports, Cultural & Talent Showcase",
    committee_code: "WICASA",
    audience: "students",
    mode: "in_person",
    venue: "VNIT Sports Complex, Nagpur",
    daysFromNow: 75,
    hour: 8,
    duration_hours: 12,
    capacity: 600,
    fee_paise: 20000,
    cpe_hours: "0",
    program_type: "other",
    speaker_name: "WICASA Nagpur Committee",
    speaker_bio: "The Nagpur Branch student wing brings together articles and Final students for a full-day festival.",
    highlights: [
      "Sports — cricket knockouts, chess, table tennis, and badminton (individual + firm-team)",
      "Cultural — group song, group dance, solo instrumental, and an open-mic evening",
      "Talent — quiz, extempore, and 'Article's Got Talent' auditions",
      "Prize distribution + branch chairman's address at 6 PM",
    ],
    description: "The flagship annual event for Nagpur Branch CA students. Register early — pre-registration required for team events. Fee of ₹200 covers lunch, snacks, and the fest T-shirt. Trophy and cash prizes across 15 categories.",
  },
];

try {
  // Committee lookup — every event needs a valid committee_id.
  const committeeRows = await sql`SELECT id, code FROM committees`;
  const committeeIdByCode = new Map(committeeRows.map((r) => [r.code, r.id]));

  const missing = EVENTS.filter((e) => !committeeIdByCode.has(e.committee_code));
  if (missing.length) {
    console.error(
      `✗ Missing committees in DB: ${[...new Set(missing.map((e) => e.committee_code))].join(", ")}.`,
      "Run scripts/seed-committees.mjs first."
    );
    process.exit(1);
  }

  // Resolve branch_id (fallback to any active branch).
  let [branch] = await sql`SELECT id FROM branches WHERE code = 'NGP' LIMIT 1`;
  if (!branch) [branch] = await sql`SELECT id FROM branches WHERE active = true LIMIT 1`;

  let inserted = 0, refreshed = 0;

  for (const e of EVENTS) {
    const startsAt = daysFromNowIso(e.daysFromNow, e.hour ?? 10);
    const endsAt   = hoursLater(startsAt, e.duration_hours ?? 2);
    const committeeId = committeeIdByCode.get(e.committee_code);
    const highlights = e.highlights ?? [];

    const [existing] = await sql`SELECT id FROM events WHERE slug = ${e.slug} LIMIT 1`;

    if (existing) {
      if (!REFRESH) {
        console.log(`= ${e.slug} — exists (pass --refresh to bump dates)`);
        continue;
      }
      await sql`
        UPDATE events SET
          title           = ${e.title},
          description     = ${e.description},
          committee_id    = ${committeeId},
          branch_id       = ${branch?.id ?? null},
          audience        = ${e.audience},
          mode            = ${e.mode},
          venue           = ${e.venue},
          starts_at       = ${startsAt},
          ends_at         = ${endsAt},
          cpe_hours       = ${e.cpe_hours},
          fee_paise       = ${e.fee_paise},
          capacity        = ${e.capacity},
          status          = 'published',
          program_type    = ${e.program_type},
          speaker_name    = ${e.speaker_name},
          speaker_bio     = ${e.speaker_bio},
          highlights      = ${highlights},
          updated_at      = now()
        WHERE id = ${existing.id}
      `;
      console.log(`↺ refreshed: ${e.title}`);
      refreshed++;
    } else {
      await sql`
        INSERT INTO events (
          slug, title, description, committee_id, branch_id, audience, mode, venue,
          starts_at, ends_at, cpe_hours, fee_paise, capacity, status,
          program_type, speaker_name, speaker_bio, highlights
        ) VALUES (
          ${e.slug}, ${e.title}, ${e.description}, ${committeeId}, ${branch?.id ?? null},
          ${e.audience}, ${e.mode}, ${e.venue}, ${startsAt}, ${endsAt},
          ${e.cpe_hours}, ${e.fee_paise}, ${e.capacity}, 'published',
          ${e.program_type}, ${e.speaker_name}, ${e.speaker_bio}, ${highlights}
        )
      `;
      console.log(`+ ${e.title}`);
      inserted++;
    }
  }

  console.log("\n───────────────────────────────────────────────");
  console.log(`✓ Student events — ${inserted} created, ${refreshed} refreshed`);
  console.log("───────────────────────────────────────────────\n");
} catch (err) {
  console.error("✗ Failed:", err.message);
  if (err.detail) console.error("  detail:", err.detail);
  process.exitCode = 1;
} finally {
  await sql.end();
}
