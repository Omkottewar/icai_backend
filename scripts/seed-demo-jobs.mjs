// Seeds realistic Nagpur-based job vacancies, articleship openings, and
// short-term assignment postings so /job-vacancies has real-looking demo
// content instead of the "check back soon" empty state.
//
// Idempotent — checks for an existing '[DEMO]' posting and skips if any
// are present. Firms use registration_no beginning with "DEMO-FRN-" so
// re-runs never violate the unique constraint.
//
// Usage:  node scripts/seed-demo-jobs.mjs

import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

// Demo firms — real-sounding CA firms in Nagpur. registration_no is unique
// per the schema, so we tag them with a DEMO- prefix to keep re-runs safe.
const FIRMS = [
  {
    registration_no: "DEMO-FRN-108765W",
    name: "Kabra Bagdi & Associates",
    email: "hr@kabrabagdi-demo.in",
    phone: "+91 712 245 6712",
    website: "https://kabrabagdi-demo.in",
    address: "Plot 4, Ramdaspeth, Wardha Road",
    city: "Nagpur",
    pincode: "440010",
    partners_count: 6,
    areas_of_expertise: ["Statutory Audit", "Direct Tax", "GST", "Transfer Pricing"],
  },
  {
    registration_no: "DEMO-FRN-114322W",
    name: "Rathi Deshmukh & Co.",
    email: "careers@rathideshmukh-demo.in",
    phone: "+91 712 663 1201",
    website: "https://rathideshmukh-demo.in",
    address: "2nd Floor, Empress Mall, Empress City",
    city: "Nagpur",
    pincode: "440018",
    partners_count: 4,
    areas_of_expertise: ["Bank Audit", "Internal Audit", "GST Litigation"],
  },
  {
    registration_no: "DEMO-FRN-121904W",
    name: "V. R. Chandak & Associates",
    email: "office@vrchandak-demo.in",
    phone: "+91 712 254 8890",
    address: "First Floor, Dharampeth Extension",
    city: "Nagpur",
    pincode: "440010",
    partners_count: 3,
    areas_of_expertise: ["Concurrent Audit", "MSME Compliance", "Direct Tax"],
  },
  {
    registration_no: "DEMO-FRN-133508W",
    name: "Sarda Jhawar & Co.",
    email: "recruit@sardajhawar-demo.in",
    phone: "+91 712 671 4455",
    website: "https://sardajhawar-demo.in",
    address: "Sadar, Kingsway",
    city: "Nagpur",
    pincode: "440001",
    partners_count: 8,
    areas_of_expertise: ["Forensic Audit", "M&A Advisory", "Ind AS", "IFC Testing"],
  },
];

// One entry per posting. `firm_registration` links to the FIRMS array above.
// status='active' + no expiry -> shows up on /job-vacancies immediately.
const POSTINGS = [
  // ─── Job vacancies (qualified CAs) ────────────────────────────────────
  {
    type: "job",
    firm_registration: "DEMO-FRN-108765W",
    title: "[DEMO] Manager — Direct Tax & Transfer Pricing",
    experience_required: "3-5 years post-qualification",
    location: "Nagpur",
    seat_count: 2,
    description: [
      "Lead engagements for corporate direct-tax compliance, TP documentation, and litigation support.",
      "",
      "Responsibilities:",
      "• Review of ITR, tax audit reports (3CA/3CD) for corporates and firms",
      "• TP study reports, benchmarking, and Form 3CEB filings",
      "• Represent clients before AO / DRP / ITAT (drafting + assistance)",
      "• Mentor a team of 3-4 article assistants",
      "",
      "Requirements:",
      "• CA qualified with 3+ years in a mid-to-large firm",
      "• Working knowledge of TP software (Onesource / TPGenie a plus)",
      "• Comfortable with Income Tax Act, DTAA, BEPS",
    ].join("\n"),
    daysToExpire: 45,
  },
  {
    type: "job",
    firm_registration: "DEMO-FRN-133508W",
    title: "[DEMO] Senior Executive — Statutory & Ind AS Audit",
    experience_required: "2-4 years post-qualification",
    location: "Nagpur (Sadar)",
    seat_count: 3,
    description: [
      "Statutory audit of listed and mid-market clients with a strong Ind AS focus.",
      "",
      "You will:",
      "• Plan and execute audit engagements end-to-end under partner review",
      "• Perform IFC / ICFR testing and prepare audit walkthroughs",
      "• Coordinate with clients' finance teams during quarterly limited reviews",
      "• Assist in disclosures for Companies Act, SEBI LODR",
      "",
      "Ideal candidate has completed articleship with a Big-4 or top-20 firm and is comfortable with SA 700 series and CARO 2020.",
    ].join("\n"),
    daysToExpire: 30,
  },
  {
    type: "job",
    firm_registration: null, // Direct branch posting (no firm)
    title: "[DEMO] Finance Manager — Manufacturing Company (MIDC Butibori)",
    experience_required: "5+ years",
    location: "Butibori, Nagpur",
    seat_count: 1,
    description: [
      "A leading auto-ancillary manufacturer at Butibori MIDC is looking for a qualified CA to head their finance function.",
      "",
      "Scope:",
      "• Monthly MIS, budgeting, and variance analysis",
      "• Statutory + tax compliance (GST, TDS, PT, PF, ESI)",
      "• Working-capital management, banker interface, LC / BG facilitation",
      "• Costing, product profitability, and capex evaluation",
      "",
      "Compensation: ₹15-22 LPA depending on experience. Company car + medical cover.",
      "",
      "Interested members may write directly to the branch — nagpur@icai.org — with subject 'Butibori Finance Manager'.",
    ].join("\n"),
    daysToExpire: 60,
  },
  {
    type: "job",
    firm_registration: "DEMO-FRN-114322W",
    title: "[DEMO] Assistant Manager — GST Litigation & Advisory",
    experience_required: "1-3 years post-qualification",
    location: "Nagpur",
    seat_count: 2,
    description: [
      "Handle end-to-end GST advisory and litigation work for a growing portfolio of manufacturing and service clients.",
      "",
      "Responsibilities:",
      "• Reply drafting for SCNs, DRC-01, ASMT-10 notices",
      "• Represent clients before Superintendent / Assistant Commissioner / Commissioner (Appeals)",
      "• GST audits, annual return preparation, and departmental audits",
      "• Advisory on classification, ITC, cross-border transactions",
      "",
      "Prior GST litigation exposure is highly preferred. Fluency in Marathi / Hindi essential for departmental interactions.",
    ].join("\n"),
    daysToExpire: 45,
  },
  {
    type: "job",
    firm_registration: "DEMO-FRN-121904W",
    title: "[DEMO] Chartered Accountant — Concurrent & Internal Audit",
    experience_required: "0-2 years post-qualification",
    location: "Nagpur",
    seat_count: 2,
    description: [
      "Ideal opening for a freshly qualified CA looking to build a strong audit foundation across banking and mid-market clients.",
      "",
      "Work profile:",
      "• Concurrent audit of nationalised bank branches (assigned monthly)",
      "• Internal audit engagements for MSME clients in the region",
      "• Field visits, LFAR preparation, and preparation of audit reports",
      "",
      "Travel within Nagpur / Vidarbha region is part of the role — TA / DA reimbursed as per policy.",
    ].join("\n"),
    daysToExpire: 30,
  },

  // ─── Articleship vacancies (CA students) ──────────────────────────────
  {
    type: "articleship",
    firm_registration: "DEMO-FRN-108765W",
    title: "[DEMO] Articleship — Direct Tax & Statutory Audit Rotation",
    experience_required: "CA Intermediate — both groups cleared",
    location: "Nagpur (Ramdaspeth)",
    seat_count: 4,
    description: [
      "Structured 3-year articleship with a defined rotation across:",
      "",
      "• Year 1 — Statutory audit (listed + private companies)",
      "• Year 2 — Direct tax (assessments, appeals, TP documentation)",
      "• Year 3 — Choice of GST litigation or M&A due-diligence",
      "",
      "What we offer:",
      "• Stipend: ₹15,000 / ₹18,000 / ₹22,000 across the three years (above ICAI minimum)",
      "• Regular ISCA / GMCS mock exams and monthly Saturday learning sessions",
      "• Direct client exposure from month 2 onwards",
      "",
      "Selection: written test (accounting + audit basics) + partner interview.",
    ].join("\n"),
    daysToExpire: 60,
  },
  {
    type: "articleship",
    firm_registration: "DEMO-FRN-114322W",
    title: "[DEMO] Articleship — Bank Audit & GST Practice",
    experience_required: "CA Intermediate — Group I minimum",
    location: "Nagpur (Empress City)",
    seat_count: 3,
    description: [
      "Boutique firm with a focused practice in bank concurrent / statutory audits and GST advisory.",
      "",
      "Learning exposure:",
      "• Statutory bank audits during Q4 (rotational)",
      "• Concurrent audits — a branch is assigned to each article",
      "• GST return filing, audit, and notice-reply drafting",
      "• End-of-articleship placement guidance",
      "",
      "Stipend: ICAI minimum + performance bonus.",
    ].join("\n"),
    daysToExpire: 60,
  },
  {
    type: "articleship",
    firm_registration: "DEMO-FRN-133508W",
    title: "[DEMO] Articleship — Forensic Audit & Litigation Support",
    experience_required: "CA Intermediate — both groups cleared",
    location: "Nagpur (Sadar)",
    seat_count: 2,
    description: [
      "Niche articleship opening for students interested in forensic accounting, fraud investigation, and litigation support work.",
      "",
      "You will work on:",
      "• Forensic reviews for banking / corporate frauds",
      "• Expert witness assignments and report drafting",
      "• Data-analytics-based transaction review (Excel, Power Query, ACL)",
      "",
      "Stipend: ₹18,000 - ₹25,000 across three years. Priority to students with a demonstrated interest in investigations.",
    ].join("\n"),
    daysToExpire: 60,
  },
  {
    type: "articleship",
    firm_registration: "DEMO-FRN-121904W",
    title: "[DEMO] Articleship — General Practice (Small Firm Exposure)",
    experience_required: "CA Foundation cleared, CA Inter appearing",
    location: "Nagpur (Dharampeth)",
    seat_count: 3,
    description: [
      "Traditional small-firm articleship — best for students who want breadth of exposure across audit, tax, and compliance rather than deep specialisation.",
      "",
      "Typical assignments:",
      "• Tax audit (3CA/3CD), income-tax return preparation",
      "• GST returns, TDS returns, ROC filings",
      "• Concurrent audits, stock audits",
      "• Assistance in partner-led assessments and appeals",
      "",
      "Stipend as per ICAI schedule. Flexible attendance during exam months.",
    ].join("\n"),
    daysToExpire: 60,
  },

  // ─── Assignment openings (short-term / freelance for members) ─────────
  {
    type: "assignment",
    firm_registration: "DEMO-FRN-133508W",
    title: "[DEMO] Assignment — Q3 Limited Review Support (Listed Client)",
    experience_required: "CA with 2+ years audit exposure",
    location: "Nagpur (on-site + WFH mix)",
    seat_count: 2,
    description: [
      "Short-term engagement (3 weeks, mid-January to first week of February) supporting Q3 limited review of a listed manufacturing client.",
      "",
      "Scope:",
      "• Substantive testing of revenue, inventory, and receivables",
      "• Ind AS disclosure checks",
      "• Preparation of limited-review report working papers",
      "",
      "Compensation: ₹75,000 fixed for the full engagement + travel reimbursement.",
    ].join("\n"),
    daysToExpire: 20,
  },
  {
    type: "assignment",
    firm_registration: null,
    title: "[DEMO] Assignment — Startup Due-Diligence (Fintech, 4-week engagement)",
    experience_required: "CA with M&A / due-diligence exposure",
    location: "Remote + 2 site visits (Pune)",
    seat_count: 1,
    description: [
      "A Nagpur-based angel-investor group is looking for a member to run a financial + tax due-diligence on a Series-A fintech target.",
      "",
      "Deliverables:",
      "• 20-page DD report — accounting quality, working-capital normalisation, tax exposures",
      "• Data-room review checklist and follow-up query log",
      "• One partner-review call before final submission",
      "",
      "Timeline: 4 weeks. Compensation ₹1.25 - ₹1.75 lakh depending on turnaround.",
      "",
      "Interested members should express interest with a short note on prior DD engagements.",
    ].join("\n"),
    daysToExpire: 15,
  },
  {
    type: "assignment",
    firm_registration: "DEMO-FRN-108765W",
    title: "[DEMO] Assignment — GST Departmental Audit (2 clients, February)",
    experience_required: "CA with GST audit experience",
    location: "Nagpur",
    seat_count: 2,
    description: [
      "Support two mid-market clients through GSTAM-based departmental audits scheduled for February.",
      "",
      "Work involves:",
      "• Response to pre-audit information requisitions",
      "• Preparation of reconciliation between books, GSTR-3B, GSTR-1, and GSTR-9",
      "• On-site representation during audit visits (2-3 days per client)",
      "",
      "Fees: ₹35,000 per client. Payment on completion of audit and closure letter.",
    ].join("\n"),
    daysToExpire: 25,
  },
  {
    type: "assignment",
    firm_registration: "DEMO-FRN-114322W",
    title: "[DEMO] Assignment — Bank Concurrent Audit (Kamptee Branch, 6 months)",
    experience_required: "CA / CA-in-practice preferred",
    location: "Kamptee (near Nagpur)",
    seat_count: 1,
    description: [
      "Concurrent audit assignment for a nationalised bank branch at Kamptee — 6-month engagement, extendable subject to satisfactory performance.",
      "",
      "Scope covers:",
      "• Daily voucher verification (advances, deposits, foreign exchange)",
      "• KYC / AML compliance testing",
      "• Monthly LFAR-style reports to the branch",
      "",
      "Fees: ₹18,000 per month (bank standard). Reimbursement of travel within Kamptee.",
    ].join("\n"),
    daysToExpire: 30,
  },
];

function isoDaysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

try {
  // ── 1. Bail if the seed has already run ──────────────────────────────
  const existing = await sql`
    SELECT count(*)::int AS n FROM job_postings
    WHERE title LIKE '[DEMO]%' AND deleted_at IS NULL
  `;
  if (existing[0].n > 0) {
    console.log(`= ${existing[0].n} [DEMO] postings already exist — skipping insert.`);
    console.log(`  (Delete them manually and re-run to refresh.)`);
    process.exit(0);
  }

  // ── 2. Pick a poster user — any admin/chairman will do ───────────────
  const posterRows = await sql`
    SELECT id, name, email
    FROM users
    WHERE deleted_at IS NULL AND status = 'active'
      AND primary_role IN ('admin', 'chairman')
    ORDER BY created_at ASC
    LIMIT 1
  `;
  if (posterRows.length === 0) {
    console.error("✗ No active admin/chairman user found. Postings need a poster_user_id.");
    console.error("  Create an admin via scripts/promote-admin.mjs first.");
    process.exit(1);
  }
  const poster = posterRows[0];
  console.log(`→ Using poster: ${poster.name} <${poster.email}>`);

  // ── 3. Insert firms (idempotent via UNIQUE registration_no) ──────────
  const firmIdByRegNo = new Map();
  for (const f of FIRMS) {
    const [row] = await sql`
      INSERT INTO firms (
        name, registration_no, email, phone, website, address, city, pincode,
        partners_count, areas_of_expertise, verified
      ) VALUES (
        ${f.name}, ${f.registration_no}, ${f.email}, ${f.phone},
        ${f.website ?? null}, ${f.address}, ${f.city}, ${f.pincode},
        ${f.partners_count}, ${f.areas_of_expertise}, true
      )
      ON CONFLICT (registration_no) DO UPDATE SET updated_at = now()
      RETURNING id
    `;
    firmIdByRegNo.set(f.registration_no, row.id);
  }
  console.log(`✓ ${FIRMS.length} demo firms in place.`);

  // ── 4. Insert postings ───────────────────────────────────────────────
  let inserted = 0;
  for (const p of POSTINGS) {
    const firmId = p.firm_registration ? firmIdByRegNo.get(p.firm_registration) : null;
    const expiresAt = isoDaysFromNow(p.daysToExpire);
    const [row] = await sql`
      INSERT INTO job_postings (
        type, title, description, poster_user_id, firm_id,
        seat_count, experience_required, location, fee_paise, status, expires_at
      ) VALUES (
        ${p.type}, ${p.title}, ${p.description},
        ${poster.id}, ${firmId},
        ${p.seat_count}, ${p.experience_required},
        ${p.location}, 0, 'active', ${expiresAt}
      )
      RETURNING id
    `;
    if (row) {
      console.log(`✓ ${p.type.padEnd(11)} — ${p.title}`);
      inserted++;
    }
  }

  const summary = { job: 0, articleship: 0, assignment: 0 };
  for (const p of POSTINGS) summary[p.type]++;
  console.log(`\nDone. ${inserted} posting${inserted === 1 ? "" : "s"} inserted:`);
  console.log(`  • ${summary.job} job vacancies`);
  console.log(`  • ${summary.articleship} articleship openings`);
  console.log(`  • ${summary.assignment} assignment engagements`);
} catch (err) {
  console.error("✗ Failed:", err.message);
  if (err.detail) console.error("  detail:", err.detail);
  process.exitCode = 1;
} finally {
  await sql.end();
}
