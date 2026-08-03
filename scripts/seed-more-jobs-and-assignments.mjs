// Adds a fresh batch of job vacancies and short-term assignment openings
// to /job-vacancies so the board never looks empty during demos.
//
// Idempotent — every posting title carries a `[BATCH-3]` marker; the script
// bails if any [BATCH-3] posting already exists. Firms use registration_no
// beginning with `DEMO3-FRN-` so re-runs never collide with the earlier
// seed scripts (`DEMO-FRN-` in seed-demo-jobs.mjs, `DEMO2-FRN-` in
// seed-more-articleships.mjs).
//
// Usage:  node scripts/seed-more-jobs-and-assignments.mjs

import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

const FIRMS = [
  {
    registration_no: "DEMO3-FRN-170912W",
    name: "Zawar Kothari & Co.",
    email: "hr@zawarkothari-demo.in",
    phone: "+91 712 228 4411",
    website: "https://zawarkothari-demo.in",
    address: "2nd Floor, Laxmi Bhavan, Central Avenue",
    city: "Nagpur",
    pincode: "440002",
    partners_count: 5,
    areas_of_expertise: ["Statutory Audit", "Corporate Tax", "FEMA Advisory"],
  },
  {
    registration_no: "DEMO3-FRN-174455W",
    name: "Purohit Chandak LLP",
    email: "careers@purohitchandak-demo.in",
    phone: "+91 712 246 9900",
    website: "https://purohitchandak-demo.in",
    address: "Ground Floor, Trimurti Nagar Ring Road",
    city: "Nagpur",
    pincode: "440022",
    partners_count: 8,
    areas_of_expertise: ["Ind AS", "IFC Testing", "Group Reporting", "Statutory Audit"],
  },
  {
    registration_no: "DEMO3-FRN-179082W",
    name: "Loya Mundhada & Associates",
    email: "office@loyamundhada-demo.in",
    phone: "+91 712 259 7733",
    address: "First Floor, Byramji Town Main Road",
    city: "Nagpur",
    pincode: "440013",
    partners_count: 4,
    areas_of_expertise: ["MSME Compliance", "Direct Tax", "Trust Audit"],
  },
  {
    registration_no: "DEMO3-FRN-182117W",
    name: "Somani Mantri & Co.",
    email: "recruit@somanimantri-demo.in",
    phone: "+91 712 267 1225",
    website: "https://somanimantri-demo.in",
    address: "Above Axis Bank, Manish Nagar",
    city: "Nagpur",
    pincode: "440015",
    partners_count: 6,
    areas_of_expertise: ["Concurrent Audit", "GST", "Payroll Advisory"],
  },
  {
    registration_no: "DEMO3-FRN-186540W",
    name: "Karwa Bhutada & Partners",
    email: "hire@karwabhutada-demo.in",
    phone: "+91 712 273 5588",
    address: "5th Floor, Landmark Tower, Ramdaspeth",
    city: "Nagpur",
    pincode: "440010",
    partners_count: 7,
    areas_of_expertise: ["Transfer Pricing", "International Tax", "M&A Advisory"],
  },
];

const POSTINGS = [
  // ─── Job vacancies (qualified CAs) ──────────────────────────────────────
  {
    type: "job",
    firm_registration: "DEMO3-FRN-170912W",
    title: "[BATCH-3] Senior Manager — Corporate Tax & FEMA Advisory",
    experience_required: "4-6 years post-qualification",
    location: "Nagpur (Central Avenue)",
    seat_count: 1,
    description: [
      "Lead the corporate tax and FEMA advisory desk for a portfolio of mid-market and multinational clients.",
      "",
      "Responsibilities:",
      "• Advisory on inbound / outbound structuring, ODI, FDI, ECB compliance",
      "• RBI compliance filings (FLA, APR, FC-GPR, FC-TRS) end-to-end",
      "• Corporate tax assessments, appeals, and DRP representations",
      "• Team leadership — 4 seniors + 6 articles reporting in",
      "",
      "Ideal candidate has worked in a Big-4 or Grade-A firm with strong drafting and client-management skills. Compensation ₹18-24 LPA.",
    ].join("\n"),
    daysToExpire: 60,
  },
  {
    type: "job",
    firm_registration: "DEMO3-FRN-174455W",
    title: "[BATCH-3] Manager — Ind AS Group Reporting",
    experience_required: "3-5 years post-qualification",
    location: "Nagpur (Trimurti Nagar)",
    seat_count: 2,
    description: [
      "Own the Ind AS group-reporting engagement for two listed manufacturing clients — quarterly consolidation, disclosures, and auditor coordination.",
      "",
      "You will:",
      "• Drive quarterly consol packs across 6-8 subsidiaries",
      "• Prepare Ind AS 115 / 116 / 109 / 36 impact memos",
      "• Coordinate with statutory & tax auditors during limited reviews",
      "• Present the consol pack to the client audit committee",
      "",
      "Requirements: strong Ind AS working knowledge, prior Big-4 or listed-industry exposure, and comfort presenting to CFO-level stakeholders.",
    ].join("\n"),
    daysToExpire: 45,
  },
  {
    type: "job",
    firm_registration: null,
    title: "[BATCH-3] Head — Finance & Accounts (Textile Group, Hingna MIDC)",
    experience_required: "8+ years",
    location: "Hingna MIDC, Nagpur",
    seat_count: 1,
    description: [
      "A well-established Nagpur textile group (turnover ₹300 Cr+) is seeking a Head of Finance & Accounts to lead a team of 12 across two plants.",
      "",
      "Scope:",
      "• Monthly closing, MIS, budgeting, and variance commentary",
      "• Direct + indirect tax compliance, assessments, and litigation oversight",
      "• Banking, working-capital, and CC-limit renewals with lead banker",
      "• Ind AS reporting, statutory audit, and cost audit coordination",
      "• Costing and product-mix profitability studies for the management",
      "",
      "Compensation: ₹22-30 LPA + performance bonus + company car. Interested members may write to nagpur@icai.org with subject 'Hingna Head-Finance'.",
    ].join("\n"),
    daysToExpire: 60,
  },
  {
    type: "job",
    firm_registration: "DEMO3-FRN-182117W",
    title: "[BATCH-3] Executive — GST Compliance & Payroll Advisory",
    experience_required: "1-2 years post-qualification",
    location: "Nagpur (Manish Nagar)",
    seat_count: 3,
    description: [
      "Growing practice looking for junior CAs to run the GST-compliance and payroll-advisory desks for SME and mid-market clients.",
      "",
      "Work profile:",
      "• Monthly GSTR-1 / 3B / 9 / 9C preparation and review",
      "• Payroll processing, PF / ESI / PT compliance, salary structuring",
      "• Advisory on ITC eligibility, RCM, and departmental notices",
      "• Client interaction — most clients are within Nagpur",
      "",
      "Compensation ₹7-9 LPA. Cross-training between the two desks is offered in the first 6 months.",
    ].join("\n"),
    daysToExpire: 45,
  },
  {
    type: "job",
    firm_registration: "DEMO3-FRN-186540W",
    title: "[BATCH-3] Assistant Manager — Transfer Pricing & International Tax",
    experience_required: "2-4 years post-qualification",
    location: "Nagpur (Ramdaspeth)",
    seat_count: 2,
    description: [
      "TP-focused role in a boutique firm with a strong central-India MNC clientele.",
      "",
      "Responsibilities:",
      "• Preparation and review of Form 3CEB and TP study reports",
      "• Benchmarking on Prowess / Capitaline / TP Catalyst",
      "• BEPS Master File and CbCR filings (Form 3CEAA / 3CEAC)",
      "• Assist partner in DRP and ITAT appeals for TP additions",
      "",
      "Fluent English writing is essential — reports go directly to the client's global tax head. Compensation ₹12-16 LPA.",
    ].join("\n"),
    daysToExpire: 45,
  },
  {
    type: "job",
    firm_registration: null,
    title: "[BATCH-3] Internal Auditor — Hospital Chain (Nagpur + Amravati)",
    experience_required: "3+ years (industry or firm)",
    location: "Nagpur / Amravati (rotational)",
    seat_count: 1,
    description: [
      "A regional multi-specialty hospital chain is hiring an internal auditor to be based at their Nagpur HQ with monthly visits to the Amravati unit.",
      "",
      "Coverage:",
      "• Revenue-cycle audit — patient billing, insurance TPA, discount policy",
      "• Purchase and inventory audit — pharma, consumables, capex",
      "• Statutory compliance calendar (NABH, PC-PNDT, BMW, Fire NOC)",
      "• Quarterly audit committee reporting",
      "",
      "Compensation: ₹10-14 LPA + medical benefits for family. Members with prior healthcare-industry experience preferred but not mandatory.",
    ].join("\n"),
    daysToExpire: 60,
  },

  // ─── Assignment openings (short-term / freelance for members) ───────────
  {
    type: "assignment",
    firm_registration: "DEMO3-FRN-170912W",
    title: "[BATCH-3] Assignment — Standalone Statutory Audit (Trading Co., FY completion)",
    experience_required: "CA in practice, 2+ years audit exposure",
    location: "Nagpur",
    seat_count: 2,
    description: [
      "One-off statutory audit engagement for a mid-sized trading company (turnover ~₹120 Cr) whose regular auditor stepped down mid-year.",
      "",
      "Scope:",
      "• Full-year statutory audit including CARO 2020 reporting",
      "• Tax audit under Section 44AB and Form 3CD",
      "• Ind AS applicability assessment (client currently on AS)",
      "",
      "Timeline: 6 weeks. Fees: ₹2.5 lakh consolidated + out-of-pocket. Working papers to be handed over on completion.",
    ].join("\n"),
    daysToExpire: 25,
  },
  {
    type: "assignment",
    firm_registration: "DEMO3-FRN-174455W",
    title: "[BATCH-3] Assignment — IFC Documentation & Walkthroughs (3-week burst)",
    experience_required: "CA with IFC / SOX exposure",
    location: "Nagpur (on-site)",
    seat_count: 3,
    description: [
      "Support the IFC re-documentation cycle for a listed auto-ancillary client — the RACM and walkthroughs need refresh ahead of the March statutory audit.",
      "",
      "Deliverables:",
      "• Updated process flowcharts for P2P, O2C, R2R, Payroll",
      "• Refreshed Risk & Control Matrix with control-owner sign-offs",
      "• 15 walkthrough test-of-design memos",
      "",
      "Duration: 3 weeks. Fees: ₹65,000 per resource + travel reimbursement if from outside Nagpur.",
    ].join("\n"),
    daysToExpire: 20,
  },
  {
    type: "assignment",
    firm_registration: null,
    title: "[BATCH-3] Assignment — Transaction Advisory (Family Business Restructuring)",
    experience_required: "CA with structuring / M&A background",
    location: "Nagpur + Mumbai (2-3 visits)",
    seat_count: 1,
    description: [
      "A Nagpur family business is restructuring across four operating entities ahead of a next-gen succession plan. They need a member to lead the tax + regulatory structuring.",
      "",
      "Scope:",
      "• Slump-sale vs. demerger vs. share-swap comparison memo",
      "• Direct-tax and stamp-duty implications across state jurisdictions",
      "• Coordination with SEBI / legal counsel for the listed leg",
      "• Board and family-council presentation of recommended structure",
      "",
      "Duration: 8-10 weeks. Compensation ₹3-4 lakh depending on final structure implemented. Non-competition NDA required.",
    ].join("\n"),
    daysToExpire: 30,
  },
  {
    type: "assignment",
    firm_registration: "DEMO3-FRN-179082W",
    title: "[BATCH-3] Assignment — Trust Audits & 10(23C) Filings (batch of 6 trusts)",
    experience_required: "CA in practice",
    location: "Nagpur",
    seat_count: 2,
    description: [
      "Batch assignment covering 6 charitable trusts and one educational society — statutory audit + 10B/10BB filing + FCRA reconciliation.",
      "",
      "Deliverables per trust:",
      "• Audit report and Form 10B / 10BB",
      "• Section 12A / 10(23C) compliance checklist",
      "• FCRA quarterly reconciliation (2 trusts only)",
      "• Consolidated management letter",
      "",
      "Fees: ₹18,000 per trust flat. Timeline: 5 weeks. Ideal for a practising member looking to plug a Q4 gap.",
    ].join("\n"),
    daysToExpire: 25,
  },
  {
    type: "assignment",
    firm_registration: "DEMO3-FRN-186540W",
    title: "[BATCH-3] Assignment — TP Study & 3CEB (2 subsidiaries of listed group)",
    experience_required: "CA with TP documentation exposure",
    location: "Nagpur + Remote",
    seat_count: 1,
    description: [
      "Prepare the transfer-pricing study reports and Form 3CEB filings for two Indian subsidiaries of a listed European auto group.",
      "",
      "Scope:",
      "• Functional and economic analysis of intra-group transactions",
      "• Benchmarking studies (Prowess + subscription DBs — access provided)",
      "• Master File extract alignment with global TP policy",
      "• 3CEB filing on the ITBA portal",
      "",
      "Duration: 6 weeks. Fees: ₹1.4 lakh per entity + reimbursements. Prior 3CEB filing experience is a must.",
    ].join("\n"),
    daysToExpire: 30,
  },
  {
    type: "assignment",
    firm_registration: null,
    title: "[BATCH-3] Assignment — Stock Audit (5 bank branches, Vidarbha region)",
    experience_required: "CA / CA firm with bank-audit empanelment",
    location: "Nagpur, Amravati, Wardha, Chandrapur, Yavatmal",
    seat_count: 2,
    description: [
      "Stock audit allocation from a nationalised bank — 5 borrower units spread across the Vidarbha region.",
      "",
      "Scope per unit:",
      "• Physical stock verification and reconciliation with stock statements",
      "• Debtors ageing check and cross-tally with sales register",
      "• Working-capital margin review and DP recommendation",
      "• On-site visit and detailed report within 10 days of allocation",
      "",
      "Fees: ₹22,000 per unit + travel and lodging reimbursed on actuals. Assignment cycle repeats quarterly for members who complete on time.",
    ].join("\n"),
    daysToExpire: 20,
  },
];

function isoDaysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

try {
  const existing = await sql`
    SELECT count(*)::int AS n FROM job_postings
    WHERE title LIKE '[BATCH-3]%' AND deleted_at IS NULL
  `;
  if (existing[0].n > 0) {
    console.log(`= ${existing[0].n} [BATCH-3] postings already exist — skipping insert.`);
    console.log(`  (Delete them manually and re-run to refresh.)`);
    process.exit(0);
  }

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
  console.log(`✓ ${FIRMS.length} firms in place.`);

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

  const summary = { job: 0, assignment: 0 };
  for (const p of POSTINGS) summary[p.type]++;
  console.log(`\nDone. ${inserted} posting${inserted === 1 ? "" : "s"} inserted:`);
  console.log(`  • ${summary.job} job vacancies`);
  console.log(`  • ${summary.assignment} assignment engagements`);
} catch (err) {
  console.error("✗ Failed:", err.message);
  if (err.detail) console.error("  detail:", err.detail);
  process.exitCode = 1;
} finally {
  await sql.end();
}
