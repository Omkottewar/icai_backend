// High-level stress-test seed.  Populates ~every table in the schema with
// realistic-looking mock data so dashboards, lists, search and pagination
// can be exercised against a "lived-in" branch.
//
// Every mock row carries a recognisable tag so `clean-mock-data.mjs` can
// undo this script without touching real data:
//   • users.email           starts with  "mock+...@icai-nagpur.local"
//   • events.slug           starts with  "mock-"
//   • firms.registration_no starts with  "MOCK-FRN-"
//   • employers.gstin       starts with  "07MOCK"
//   • job_postings.title    starts with  "[MOCK]"
//   • bills.vendor_name     starts with  "[MOCK]"
//   • iut_transfers.reference_number starts with "MOCK-IUT-"
//   • mock_tests.title      starts with  "[MOCK]"
//   • grievances.ticket_no  starts with  "MOCK-"
//   • announcements.title   starts with  "[MOCK]"
//   • forum_threads.title   starts with  "[MOCK]"
//   • paper_presentations.slug starts with "mock-"
//   • ejournal_issues.slug  starts with  "mock-"
//   • gallery_albums.title  starts with  "[MOCK]"
//   • branch_newsletters.title starts with "[MOCK]"
//   • annual_reports.fy_label starts with "MOCK-FY"
//   • office_bearers.term_label starts with "MOCK-"
//   • rooms.name            starts with  "[MOCK]"
//   • notifications.title   starts with  "[MOCK]"
//   • payments.metadata     contains     { "mock_seed": true }
//   • files.storage_path    starts with  "mock/"
//   • icai_link_cards.title starts with  "[MOCK]"
//   • paper_presentations / ejournal slugs prefixed "mock-"
//
// Idempotent.  Deterministic (PRNG seeded with 42), so re-runs match.
//
// Prereqs:
//   - DATABASE_URL (or SUPABASE_URL) in .env
//   - At least one branch (preferably code='NGP')
//   - committees populated (seed-committees-nagpur.mjs)
//
// Usage:
//   node scripts/seed-mock-data.mjs                    # stress defaults
//   node scripts/seed-mock-data.mjs --scale=0.2        # 20% of defaults (fast smoke)
//   node scripts/seed-mock-data.mjs --only=members,events   # only specific sections
//   node scripts/seed-mock-data.mjs --skip=notifications

import "dotenv/config";
import postgres from "postgres";
import { randomUUID } from "node:crypto";

// ─── CLI args ───────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? "true"];
    }),
);
const SCALE = Number(args.scale ?? 1);
const ONLY = args.only ? new Set(args.only.split(",").map((s) => s.trim())) : null;
const SKIP = args.skip ? new Set(args.skip.split(",").map((s) => s.trim())) : new Set();

function shouldRun(section) {
  if (SKIP.has(section)) return false;
  if (ONLY && !ONLY.has(section)) return false;
  return true;
}

const scaled = (n) => Math.max(1, Math.round(n * SCALE));

// ─── Stress-test volume defaults ────────────────────────────────────────────

const CFG = {
  files:                scaled(40),
  resource_topics:      14,                  // fixed taxonomy
  firms:                scaled(120),
  employers:            scaled(60),
  members:              scaled(1500),
  students:             scaled(700),
  office_bearers:       scaled(28),
  rooms:                scaled(6),
  events:               scaled(200),
  events_past_ratio:    0.6,
  registrations_per_event: { min: 25, max: 110 },
  room_bookings:        scaled(280),
  consultations:        scaled(200),
  cabf_requests:        scaled(90),
  mentorship_requests:  scaled(140),
  articleship_matches:  scaled(220),
  mock_tests:           scaled(70),
  mock_test_questions_per_test: { min: 10, max: 25 },
  mock_test_regs_per_test: { min: 8, max: 40 },
  job_postings:         scaled(220),
  bills:                scaled(450),
  iut_transfers:        scaled(180),
  payment_refunds:      scaled(40),
  announcements:        scaled(35),
  forum_threads:        scaled(320),
  forum_posts_per_thread: { min: 2, max: 14 },
  paper_presentations:  scaled(110),
  ejournal_issues:      scaled(28),
  resource_bookmarks:   scaled(900),
  resource_topic_subs:  scaled(600),
  resource_comments:    scaled(550),
  resource_quizzes:     scaled(45),
  resource_quiz_attempts_per_quiz: { min: 5, max: 35 },
  icai_link_cards:      scaled(14),
  gallery_albums:       scaled(45),
  gallery_photos_per_album: { min: 6, max: 22 },
  branch_newsletters:   scaled(24),
  annual_reports:       scaled(8),
  grievances:           scaled(280),
  notifications:        scaled(3000),
  user_role_assignments: scaled(80),
};

const MOCK_EMAIL_DOMAIN = "icai-nagpur.local";

// ─── DB ─────────────────────────────────────────────────────────────────────

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}
const sql = postgres(url, { max: 1, prepare: false });

// ─── PRNG + helpers ─────────────────────────────────────────────────────────

function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(42);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const pickN = (arr, n) => {
  const out = new Set();
  while (out.size < Math.min(n, arr.length)) out.add(pick(arr));
  return [...out];
};
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const chance = (p) => rand() < p;
const between = (range) => randInt(range.min, range.max);

function isoNDaysFromNow(days, hour = 10, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}
function dateNDaysFromNow(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}
function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
function mockEmail(prefix, n) {
  return `mock+${prefix}${String(n).padStart(5, "0")}@${MOCK_EMAIL_DOMAIN}`;
}
function genIndianPhone() {
  const first = pick(["6", "7", "8", "9"]);
  let rest = "";
  for (let i = 0; i < 9; i++) rest += randInt(0, 9);
  return `+91${first}${rest}`;
}
function genGSTIN(seq) {
  // 07 = Delhi state code (just a stable mock prefix), MOCK marker, then 8 hex.
  return `07MOCK${seq.toString(36).toUpperCase().padStart(8, "0")}Z`;
}
function genPAN(seq) {
  return `MOCK${String.fromCharCode(65 + (seq % 26))}${String(seq).padStart(4, "0")}M`;
}
function indianRupeesPaise(min, max) {
  return randInt(min, max) * 100; // store as paise
}

// ─── Curated data ───────────────────────────────────────────────────────────

const FIRST_NAMES_M = [
  "Aarav","Aditya","Akshay","Amit","Aniket","Anirudh","Anubhav","Arjun","Arun",
  "Atul","Ayush","Bharat","Chirag","Darshan","Deepak","Devansh","Dhruv","Gaurav",
  "Harsh","Hemant","Hitesh","Ishaan","Jatin","Karan","Kartik","Kunal","Lakshya",
  "Madhav","Mahesh","Manish","Manoj","Mihir","Mukesh","Naman","Nikhil","Nitin",
  "Omkar","Parth","Piyush","Prakash","Pranav","Prashant","Pratik","Pravin",
  "Rahul","Rajesh","Rakesh","Rohan","Sachin","Sahil","Sameer","Sandeep","Sanjay",
  "Saurabh","Shantanu","Shivam","Shrikant","Siddharth","Sumit","Suraj","Tushar",
  "Umesh","Varun","Vedant","Vikas","Vikram","Vinod","Vishal","Yash","Yogesh",
];
const FIRST_NAMES_F = [
  "Aaradhya","Aishwarya","Akshara","Ananya","Anjali","Anuradha","Aparna","Arti",
  "Asha","Bhavna","Chitra","Deepali","Devika","Diksha","Divya","Gauri","Hema",
  "Ishita","Jyoti","Kalpana","Kavita","Komal","Kriti","Lata","Madhuri","Manisha",
  "Meera","Mohini","Namrata","Nandini","Neha","Nikita","Nisha","Pallavi","Pooja",
  "Prachi","Pratiksha","Priya","Priyanka","Radhika","Rashmi","Rekha","Renuka",
  "Riya","Ruchi","Rupali","Sakshi","Sanjana","Saroj","Shalini","Shilpa","Shivani",
  "Shreya","Shruti","Smita","Snehal","Sonali","Sucharita","Sushma","Swati",
  "Tanvi","Trupti","Urmila","Vaishali","Vandana","Varsha","Vidya","Yamini",
];
const SURNAMES = [
  "Agarwal","Agrawal","Ahuja","Bagde","Bajaj","Bansal","Bhandari","Bhansali",
  "Bhattacharya","Chandak","Chaturvedi","Chopra","Daga","Deshmukh","Deshpande",
  "Dhoot","Dixit","Fadnavis","Gandhi","Garg","Goenka","Gupta","Iyer","Jain",
  "Joshi","Kabra","Kale","Kapoor","Karnik","Kelkar","Khandelwal","Khurana",
  "Kothari","Kulkarni","Lahoti","Lodha","Maheshwari","Malhotra","Mehta","Mishra",
  "Mukherjee","Mundhra","Munot","Nagpal","Nair","Nathani","Pandey","Patel",
  "Patil","Pednekar","Phadke","Pillai","Poddar","Rao","Rathi","Saraf","Saraogi",
  "Sarda","Sethi","Shah","Sharma","Shrivastava","Singhania","Sinha","Somani",
  "Soni","Surana","Tibrewal","Tiwari","Tripathi","Vaidya","Verma","Wadhwa",
  "Walia","Zawar",
];

const NAGPUR_AREAS = [
  "Dharampeth","Sadar","Civil Lines","Sitabuldi","Ramdaspeth","Mahal","Itwari",
  "Gandhibagh","Hingna","Wardhaman Nagar","Manish Nagar","Bajaj Nagar","Pratap Nagar",
  "Khamla","Trimurti Nagar","Friends Colony","Reshimbagh","Nandanvan","Hudkeshwar",
  "Wathoda","Koradi Road","Kamptee Road","Amravati Road","Wardha Road","Katol Road",
];
const NAGPUR_PINCODES = [
  "440001","440010","440012","440013","440018","440022","440025","440028",
  "440030","440033","440034","440036","440037","440072","440014","440008",
];

const AREAS_OF_PRACTICE = [
  "GST","Direct Tax","Indirect Tax","Statutory Audit","Internal Audit",
  "Tax Audit","Bank Audit","Forensic Audit","Companies Act / Corporate Law",
  "FEMA & International Taxation","IFRS / Ind AS","Transfer Pricing",
  "Insolvency (IBC)","RERA","Stock Audit","Concurrent Audit",
  "Management Consultancy","Project Financing","Co-operative Bank Audit",
  "Trust & NGO Audit","ROC Filings & Compliance","Risk Advisory",
];

const FIRM_NAME_PREFIXES = [
  "Sharma & Associates","Joshi Patil & Co.","Mehta Kothari & Associates",
  "Agrawal & Co. Chartered Accountants","Deshpande Mundhra & Co.",
  "Saraf Mukherjee LLP","Iyer Pillai Nair & Associates","Verma Khandelwal & Co.",
  "Lahoti Lodha LLP","Bhandari Surana & Co.","Sinha Tripathi & Associates",
  "Karnik & Co.","Gandhi Wadhwa LLP","Goenka Poddar & Co.",
  "Pratiksha Jain & Associates","Rao & Associates","Chandak Daga LLP",
  "Tibrewal Sarda & Co.","Phadke Vaidya & Associates","Maheshwari Munot LLP",
];

const EMPLOYER_NAMES = [
  "Vidarbha Steel Industries Ltd","Nagpur Coal Tech Pvt Ltd","Maharashtra Agro Mills",
  "Central India Logistics","Wardha Sugar & Chemicals","Indra Polymers Pvt Ltd",
  "Vidarbha Power Holdings","Orange City Pharma","Deccan Infra Projects",
  "NagpurNext Realty","Solar Vidarbha Energy","Bharat Cement Industries",
  "Vidarbha Cotton Mills","Tata Vidarbha Steel","NMC Infrastructure Co.",
  "Vidarbha Dairy Foods Ltd","Pench Forest Products","Nagpur Auto Components",
  "Central Engineering Works","Maharashtra Mineral Co.",
];

// One row per (committee_code, title-template). Committee codes MUST match
// the codes in seed-committees-nagpur.mjs / the seed_committee_leadership.py
// script — bad codes silently fall through to a random committee and the
// event ends up wearing the wrong jersey.
const EVENT_TITLE_TEMPLATES = [
  // GST Study Group
  ["GST_SG", "GST Annual Return — Practical Workshop"],
  ["GST_SG", "GSTR-9 / 9C — Reconciliation Deep Dive"],
  ["GST_SG", "Recent Notifications in GST & Departmental Notices"],
  ["GST_SG", "GST Litigation — Best Practices & Case Studies"],
  // Direct Tax Study Group
  ["DT_SG", "Income Tax Return — AY {fy} Walkthrough"],
  ["DT_SG", "Capital Gains under the New Tax Regime"],
  ["DT_SG", "Faceless Assessment — Practical Pitfalls"],
  ["DT_SG", "TDS / TCS Compliance Refresher"],
  // Audit & Emerging Areas of Practice
  ["AUDIT_EAP", "Forensic Audit Masterclass with Live Case Studies"],
  ["AUDIT_EAP", "SA Updates — What Auditors Must Know"],
  ["AUDIT_EAP", "Internal Financial Controls — Documentation Essentials"],
  ["AUDIT_EAP", "Auditing Estimates & Going Concern — SA 540 & SA 570"],
  // Committee on Information Technology
  ["CIT", "AI & Automation in CA Practice"],
  ["CIT", "Excel Power Query for the Practising CA"],
  ["CIT", "Data Analytics in Audit — Tools & Techniques"],
  ["CIT", "Cybersecurity Essentials for CA Firms"],
  // Study Group on BFSI
  ["BFSI_SG", "Bank Branch Audit — Closing & LFAR"],
  ["BFSI_SG", "Concurrent Audit of Banks — Hands-on Session"],
  ["BFSI_SG", "NBFC Compliance & Auditor Responsibilities"],
  // IBC Study Group
  ["IBC_SG", "Insolvency Resolution Process — Case Studies"],
  ["IBC_SG", "Liquidation under IBC — Practical Aspects"],
  ["IBC_SG", "Pre-pack Insolvency for MSMEs"],
  // RERA Study Group
  ["RERA_SG", "RERA Compliance & Project Annual Audits"],
  ["RERA_SG", "RERA Quarterly Filings — Walkthrough"],
  ["RERA_SG", "Promoter Obligations & MahaRERA Order Studies"],
  // Corporate Law Group
  ["CORP_LAW", "Companies Act — Recent Amendments & MCA Filings"],
  ["CORP_LAW", "Secretarial Standards & Board Practices"],
  ["CORP_LAW", "FEMA & ODI Compliance for CAs"],
  // Fellowship Committee
  ["FELLOWSHIP", "Members' Networking Meet & Cultural Evening"],
  ["FELLOWSHIP", "Annual Members' Family Picnic"],
  ["FELLOWSHIP", "CA Day Celebrations & Felicitation Ceremony"],
  // Women Excellence & Young Members (WICASA)
  ["WICASA", "Mock Test Series — Group I & II"],
  ["WICASA", "Career Counseling for CA Students"],
  ["WICASA", "Articleship Orientation Programme"],
  ["WICASA", "Women in CA — Panel Discussion & Networking"],
  // Study Group on Cooperatives
  ["COOP_SG", "Co-operative Society Audit — Procedural Refresher"],
  ["COOP_SG", "Urban Co-operative Bank Audit — Special Aspects"],
  ["COOP_SG", "Co-operative Housing Society Compliance"],
  // Study Group on Subsidies & Incentives
  ["SUBSIDIES_SG", "MSME Subsidies & Government Incentives Update"],
  ["SUBSIDIES_SG", "PLI Scheme — Eligibility & Application Walkthrough"],
  ["SUBSIDIES_SG", "State Industrial Policy — Practical Subsidy Filings"],
  // Committee for Members in Industry & Business (CMIB)
  ["CMIB", "CA in Industry — Reporting Beyond Numbers"],
  ["CMIB", "FP&A Essentials for the CA in Industry"],
  ["CMIB", "Treasury & Working Capital Management Workshop"],
];

const VENUES_IN_PERSON = [
  "ICAI Bhawan, Nagpur","Chitnavis Centre, Civil Lines","Hotel Centre Point, Ramdaspeth",
  "Hotel Tuli Imperial, Sadar","Hotel Pride, Wardha Road","Branch Auditorium, Dharampeth",
  "Vanamati Auditorium, Civil Lines","WIRC Regional Office, Mumbai",
];

const RESOURCE_TOPICS = [
  ["GST",         "Goods & Services Tax"],
  ["DT",          "Direct Tax"],
  ["IT",          "Information Technology"],
  ["AUDIT",       "Auditing & Assurance"],
  ["CORP_LAW",    "Corporate Law"],
  ["FEMA",        "FEMA & International Tax"],
  ["IBC",         "Insolvency & Bankruptcy"],
  ["RERA",        "Real Estate (RERA)"],
  ["IND_AS",      "Ind AS / IFRS"],
  ["BFSI",        "Banking & Insurance"],
  ["FORENSIC",    "Forensic Accounting"],
  ["VALUATION",   "Valuation"],
  ["NPO",         "NGO / Trust"],
  ["STARTUP",     "Startups & MSME"],
];

const PAPER_TITLES = [
  "Recent Amendments to GST and Their Impact on Compliance",
  "Forensic Auditing: A New Frontier for CAs",
  "Faceless Assessments under Income Tax — Lessons from the Field",
  "Companies Act 2013 — Recent MCA Notifications Decoded",
  "Bank Branch Audit — Beyond LFAR",
  "RERA Quarterly Audits — Practitioner's Notes",
  "Insolvency & Bankruptcy Code — Walkthrough of Recent NCLT Orders",
  "Internal Financial Controls (ICFR) — Documentation Templates",
  "Ind AS 115 Revenue — Common Implementation Pitfalls",
  "GSTR-9C Reconciliation — A Practitioner's Manual",
  "Standards on Auditing — A Refresher for the New Year",
  "Tax Audit u/s 44AB — Reporting Requirements & Common Errors",
  "Transfer Pricing Documentation — A Step-by-step Guide",
  "Co-operative Bank Audit — Statutory Considerations",
  "Concurrent Audit of Banks — Risk-based Approach",
  "Stock Audit — Lender's Perspective vs Auditor's Mandate",
  "AI in Audit — Where Practising CAs Should Start",
  "Excel Power Query for CA Practice",
  "MSME Subsidies — Documentation & Claim Procedures",
  "Trust & NGO Audit — Section 12A / 80G Compliance",
];

const FORUM_THREAD_TITLES = [
  "Doubt — GST RCM applicability on legal services post-amendment",
  "How are you handling 26AS mismatch this AY?",
  "Suggestion — Branch newsletter could include case-law digest",
  "Articleship transfer process — clarification needed",
  "Tax Audit report — Form 3CD recent changes",
  "Best practices for documentation in SA 230",
  "MCA portal frequent timeouts — anyone else?",
  "RERA — quarterly compliance schedule clarification",
  "Bank concurrent audit — RBI directives this year",
  "How are firms handling AI-assisted research?",
  "Resource request — sample engagement letter template",
  "Announcement — Branch will close on regional holidays",
  "Doubt — Section 44ADA presumptive taxation edge case",
  "GSTR-9C limit changes — discussion thread",
  "ICFR reporting — sample templates anyone?",
];

const VENDOR_NAMES = [
  "Hotel Centre Point","Sai Caterers","Chitnavis Auditorium","Sunshine Decorators",
  "Vidarbha Print Press","RVN Florists","Aspire Audio-Visual","Maharashtra Travel Co.",
  "Royal Caterers","Quick Print Solutions","Tech Stage AV","Eden Garden Banquet",
  "Maple Conference Hall","Speed Logistics","Coffee Day Express","Bharat Stationers",
];

const ANNOUNCEMENT_TITLES = [
  "Branch office closed on Regional Holiday",
  "Annual General Meeting — Save the date",
  "New batch of WICASA mock tests starting next month",
  "GST clinic on Saturdays — walk-in slots open",
  "Members are requested to update KYM details",
  "CABF disbursement window for FY{fy}",
  "Branch library expanded — new acquisitions list inside",
  "Last date for COP renewal approaching",
  "Career counselling drive for foundation-level students",
  "Tax practitioners meet — registrations open",
];

const ROOM_NAMES = [
  "Conference Hall A","Conference Hall B","Boardroom","Library Reading Room",
  "Training Room 1","Training Room 2",
];

const OFFICE_BEARER_ROLES = [
  ["Chairman", "branch_chairman"],
  ["Vice-Chairman", "branch_vice_chairman"],
  ["Secretary", "branch_secretary"],
  ["Treasurer", "branch_treasurer"],
  ["Chairman, WICASA", "wicasa_chairman"],
  ["Vice-Chairperson, WICASA", "wicasa_vice_chairman"],
  ["Managing Committee Member", "mcm"],
  ["Managing Committee Member", "mcm"],
  ["Managing Committee Member", "mcm"],
  ["Managing Committee Member", "mcm"],
  ["Past Chairman", "past_chairman"],
];

const GRIEVANCE_SUBJECTS_DEFAULT = [
  "general", "branch_admin", "billing", "events", "membership", "professional",
];

const NOTIFICATION_TITLES = [
  "Your registration is confirmed",
  "Reminder — event tomorrow",
  "CPE credit issued",
  "Your bill was approved",
  "Refund processed",
  "New paper presentation added",
  "Mock test result published",
  "Mentorship request matched",
  "Articleship match update",
  "Grievance acknowledged",
];

// ─── Main runner ────────────────────────────────────────────────────────────

const summary = {};
async function section(name, fn) {
  if (!shouldRun(name)) {
    console.log(`\n· skip ${name}`);
    return;
  }
  const t0 = Date.now();
  console.log(`\n→ ${name}`);
  try {
    const count = await fn();
    const ms = Date.now() - t0;
    summary[name] = { count: count ?? 0, ms };
    console.log(`  ✓ ${name}: ${count ?? 0} rows in ${ms}ms`);
  } catch (err) {
    summary[name] = { error: err.message };
    console.error(`  ✗ ${name} failed: ${err.message}`);
    if (err.detail) console.error("    detail:", err.detail);
    if (err.where)  console.error("    where: ", err.where);
  }
}

// Shared state populated across sections.
const ctx = {
  branchId: null,
  committees: [],            // [{ id, code }]
  committeeByCode: new Map(),
  fileIds: [],
  firmIds: [],
  employerIds: [],
  memberIds: [],
  studentIds: [],
  rooms: [],                 // [{ id, name }]
  events: [],                // [{ id, slug, isPast, audience, capacity }]
  topicIds: [],
  paperIds: [],
  quizIds: [],
  ejournalIds: [],
  paymentIds: [],
  mockTestIds: [],
};

// ─── 0. Preflight: branch + committees ──────────────────────────────────────

async function preflight() {
  const [branch] = await sql`
    SELECT id FROM branches
    WHERE code = 'NGP' OR lower(name) LIKE '%nagpur%'
    ORDER BY active DESC LIMIT 1
  `;
  if (!branch) {
    const [any] = await sql`SELECT id FROM branches WHERE active = true LIMIT 1`;
    if (!any) throw new Error("No branches in DB. Insert at least one.");
    ctx.branchId = any.id;
  } else {
    ctx.branchId = branch.id;
  }

  ctx.committees = await sql`SELECT id, code FROM committees WHERE active = true`;
  if (ctx.committees.length === 0) {
    throw new Error("committees table empty. Run seed-committees-nagpur.mjs first.");
  }
  ctx.committeeByCode = new Map(ctx.committees.map((c) => [c.code, c.id]));
  console.log(`Preflight: branch=${ctx.branchId.slice(0, 8)}…, committees=${ctx.committees.length}`);
}

// ─── 1. Files (placeholder pool) ────────────────────────────────────────────

async function seedFiles() {
  // Reuse existing mock files if present.
  const existing = await sql`SELECT id FROM files WHERE storage_path LIKE 'mock/%'`;
  if (existing.length >= CFG.files) {
    ctx.fileIds = existing.map((f) => f.id);
    return existing.length;
  }
  const need = CFG.files - existing.length;
  const rows = [];
  const mimes = [
    ["application/pdf", "pdf",  randInt(80_000, 4_000_000)],
    ["image/jpeg",      "jpg",  randInt(40_000, 800_000)],
    ["image/png",       "png",  randInt(40_000, 1_200_000)],
    ["image/webp",      "webp", randInt(20_000, 500_000)],
  ];
  for (let i = 0; i < need; i++) {
    const [mime, ext, size] = pick(mimes);
    const id = randomUUID();
    rows.push({
      id,
      name: `mock-file-${i + 1}.${ext}`,
      mime_type: mime,
      size_bytes: size,
      storage_path: `mock/${id}.${ext}`,
      bucket: "public",
    });
  }
  await sql`INSERT INTO files ${sql(rows, "id", "name", "mime_type", "size_bytes", "storage_path", "bucket")}`;
  ctx.fileIds = [...existing.map((f) => f.id), ...rows.map((r) => r.id)];
  return rows.length;
}

// ─── 2. Resource topics (taxonomy) ──────────────────────────────────────────

async function seedResourceTopics() {
  let inserted = 0;
  for (let i = 0; i < RESOURCE_TOPICS.length; i++) {
    const [code, name] = RESOURCE_TOPICS[i];
    const [row] = await sql`
      INSERT INTO resource_topics (code, name, sort_order, active)
      VALUES (${code}, ${name}, ${i}, true)
      ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
      RETURNING id, (xmax = 0) AS inserted
    `;
    if (row.inserted) inserted++;
  }
  const all = await sql`SELECT id FROM resource_topics WHERE active = true`;
  ctx.topicIds = all.map((r) => r.id);
  return inserted;
}

// ─── 3. Firms ───────────────────────────────────────────────────────────────

async function seedFirms() {
  const existing = await sql`SELECT id FROM firms WHERE registration_no LIKE 'MOCK-FRN-%'`;
  const existingIds = new Set(existing.map((r) => r.id));
  ctx.firmIds.push(...existing.map((r) => r.id));
  const need = Math.max(0, CFG.firms - existing.length);
  if (need === 0) return 0;

  const rows = [];
  for (let i = existing.length + 1; i <= CFG.firms; i++) {
    const name = `${pick(FIRM_NAME_PREFIXES)} (FRN-${String(i).padStart(4, "0")})`;
    rows.push({
      name,
      registration_no: `MOCK-FRN-${String(i).padStart(6, "0")}`,
      email: `firm${i}@mock-firm.local`,
      phone: genIndianPhone(),
      website: chance(0.5) ? `https://mock-firm${i}.example.com` : null,
      address: `${randInt(1, 250)}, ${pick(NAGPUR_AREAS)}, Nagpur`,
      city: "Nagpur",
      pincode: pick(NAGPUR_PINCODES),
      gstin: chance(0.7) ? genGSTIN(100000 + i) : null,
      partners_count: randInt(1, 8),
      areas_of_expertise: pickN(AREAS_OF_PRACTICE, randInt(1, 4)),
      verified: chance(0.6),
    });
  }
  const inserted = await sql`
    INSERT INTO firms ${sql(rows, "name", "registration_no", "email", "phone", "website", "address", "city", "pincode", "gstin", "partners_count", "areas_of_expertise", "verified")}
    ON CONFLICT (registration_no) DO NOTHING
    RETURNING id
  `;
  ctx.firmIds.push(...inserted.map((r) => r.id));
  return inserted.length;
}

// ─── 4. Employers ───────────────────────────────────────────────────────────

async function seedEmployers() {
  const existing = await sql`SELECT id FROM employers WHERE gstin LIKE '07MOCK%'`;
  ctx.employerIds.push(...existing.map((r) => r.id));
  const need = Math.max(0, CFG.employers - existing.length);
  if (need === 0) return 0;

  const rows = [];
  for (let i = existing.length + 1; i <= CFG.employers; i++) {
    rows.push({
      company_name: `${pick(EMPLOYER_NAMES)} (Mock ${i})`,
      gstin: genGSTIN(200000 + i),
      pan: genPAN(i),
      verified: chance(0.65),
      website: chance(0.7) ? `https://employer${i}.mock-corp.local` : null,
      address: `${randInt(1, 250)}, ${pick(NAGPUR_AREAS)}, Nagpur`,
    });
  }
  const inserted = await sql`
    INSERT INTO employers ${sql(rows, "company_name", "gstin", "pan", "verified", "website", "address")}
    RETURNING id
  `;
  ctx.employerIds.push(...inserted.map((r) => r.id));
  return inserted.length;
}

// ─── 5. Members (+ profiles) ────────────────────────────────────────────────

async function seedMembers() {
  // Generate the full deterministic target list (always all CFG.members
  // entries, so the PRNG advances the same way each run regardless of
  // how many already exist).
  const targets = [];
  for (let i = 1; i <= CFG.members; i++) {
    const genderHint = chance(0.32) ? "female" : "male";
    const first = genderHint === "female" ? pick(FIRST_NAMES_F) : pick(FIRST_NAMES_M);
    const cop = chance(0.55) ? "active" : (chance(0.6) ? "none" : "surrendered");
    const memberSinceYear = randInt(1990, 2024);
    targets.push({
      i,
      email: mockEmail("m", i),
      user: {
        name: `${first} ${pick(SURNAMES)}`,
        email: mockEmail("m", i),
        phone: genIndianPhone(),
        primary_role: "member",
        status: "active",
        locale: "en",
        branch_id: ctx.branchId,
      },
      profile: {
        mrn: `MOCK-M-${String(i).padStart(6, "0")}`,
        is_fca: chance(0.35),
        cop_status: cop,
        cop_number: cop === "active" ? `COP-${randInt(10000, 99999)}` : null,
        is_practising: cop === "active" && chance(0.85),
        gender: genderHint,
        member_since: `${memberSinceYear}-${String(randInt(1, 12)).padStart(2, "0")}-${String(randInt(1, 28)).padStart(2, "0")}`,
        areas_of_practice: pickN(AREAS_OF_PRACTICE, randInt(1, 4)),
        address: `${randInt(1, 250)}, ${pick(NAGPUR_AREAS)}`,
        city: "Nagpur",
        pincode: pick(NAGPUR_PINCODES),
      },
    });
  }

  // Look up which emails already exist (so we can skip).
  const memberLike = `mock+m%@${MOCK_EMAIL_DOMAIN}`;
  const existing = await sql`SELECT id, email FROM users WHERE email LIKE ${memberLike}`;
  const byEmail = new Map(existing.map((r) => [r.email, r.id]));

  // Bulk-insert missing users in chunks.
  const missingUsers = targets.filter((t) => !byEmail.has(t.email)).map((t) => t.user);
  const BATCH = 250;
  let inserted = 0;
  for (let off = 0; off < missingUsers.length; off += BATCH) {
    const chunk = missingUsers.slice(off, off + BATCH);
    const result = await sql`
      INSERT INTO users ${sql(chunk, "name", "email", "phone", "primary_role", "status", "locale", "branch_id")}
      ON CONFLICT (email) DO NOTHING
      RETURNING id, email
    `;
    for (const r of result) byEmail.set(r.email, r.id);
    inserted += result.length;
    process.stdout.write(".");
  }
  if (missingUsers.length > 0) process.stdout.write(" ");

  // Populate ctx.memberIds in deterministic target order.
  ctx.memberIds.push(...targets.map((t) => byEmail.get(t.email)).filter(Boolean));

  // Bulk-insert missing member_profiles. Two unique constraints — user_id
  // AND mrn — so we pre-filter on BOTH (a prior interrupted run can leave
  // orphan rows where one is set but not the other).
  const userIds = ctx.memberIds;
  const existingProfiles = userIds.length > 0
    ? await sql`SELECT user_id, mrn FROM member_profiles WHERE user_id = ANY(${userIds}) OR mrn LIKE 'MOCK-M-%'`
    : [];
  const havingProfile = new Set(existingProfiles.map((r) => r.user_id));
  const usedMrns = new Set(existingProfiles.map((r) => r.mrn));
  const profileRows = [];
  for (const t of targets) {
    const uid = byEmail.get(t.email);
    if (!uid || havingProfile.has(uid) || usedMrns.has(t.profile.mrn)) continue;
    profileRows.push({ user_id: uid, ...t.profile });
  }
  let profilesInserted = 0;
  for (let off = 0; off < profileRows.length; off += BATCH) {
    const chunk = profileRows.slice(off, off + BATCH);
    // ON CONFLICT DO NOTHING (no target) catches ANY unique conflict —
    // belt-and-suspenders over the pre-filter above.
    const result = await sql`
      INSERT INTO member_profiles ${sql(chunk, "user_id", "mrn", "is_fca", "cop_status", "cop_number", "is_practising", "gender", "member_since", "areas_of_practice", "address", "city", "pincode")}
      ON CONFLICT DO NOTHING
      RETURNING user_id
    `;
    profilesInserted += result.length;
    process.stdout.write(".");
  }
  if (profileRows.length > 0) process.stdout.write(" ");

  return inserted + profilesInserted;
}

// ─── 6. Students (+ profiles) ───────────────────────────────────────────────

async function seedStudents() {
  const targets = [];
  for (let i = 1; i <= CFG.students; i++) {
    const genderHint = chance(0.5) ? "female" : "male";
    const first = genderHint === "female" ? pick(FIRST_NAMES_F) : pick(FIRST_NAMES_M);
    const level = pick(["foundation", "intermediate", "final"]);
    const artStatus = level === "foundation" ? "not_started" :
                      level === "intermediate" ? pick(["not_started", "ongoing"]) :
                      pick(["ongoing", "completed"]);
    const artStart = artStatus === "not_started" ? null :
      `${randInt(2022, 2026)}-${String(randInt(1, 12)).padStart(2, "0")}-${String(randInt(1, 28)).padStart(2, "0")}`;
    const principalId = artStart && ctx.memberIds.length > 0 ? pick(ctx.memberIds) : null;
    targets.push({
      i,
      email: mockEmail("s", i),
      user: {
        name: `${first} ${pick(SURNAMES)}`,
        email: mockEmail("s", i),
        phone: genIndianPhone(),
        primary_role: "student",
        status: "active",
        locale: "en",
        branch_id: ctx.branchId,
      },
      profile: {
        srn: `MOCK-S-${String(i).padStart(6, "0")}`,
        level,
        articleship_status: artStatus,
        articleship_start: artStart,
        principal_member_id: principalId,
        exam_attempts: randInt(0, 3),
      },
    });
  }

  const studentLike = `mock+s%@${MOCK_EMAIL_DOMAIN}`;
  const existing = await sql`SELECT id, email FROM users WHERE email LIKE ${studentLike}`;
  const byEmail = new Map(existing.map((r) => [r.email, r.id]));

  const missingUsers = targets.filter((t) => !byEmail.has(t.email)).map((t) => t.user);
  const BATCH = 250;
  let inserted = 0;
  for (let off = 0; off < missingUsers.length; off += BATCH) {
    const chunk = missingUsers.slice(off, off + BATCH);
    const result = await sql`
      INSERT INTO users ${sql(chunk, "name", "email", "phone", "primary_role", "status", "locale", "branch_id")}
      ON CONFLICT (email) DO NOTHING
      RETURNING id, email
    `;
    for (const r of result) byEmail.set(r.email, r.id);
    inserted += result.length;
    process.stdout.write(".");
  }
  if (missingUsers.length > 0) process.stdout.write(" ");

  ctx.studentIds.push(...targets.map((t) => byEmail.get(t.email)).filter(Boolean));

  const userIds = ctx.studentIds;
  const existingProfiles = userIds.length > 0
    ? await sql`SELECT user_id, srn FROM student_profiles WHERE user_id = ANY(${userIds}) OR srn LIKE 'MOCK-S-%'`
    : [];
  const havingProfile = new Set(existingProfiles.map((r) => r.user_id));
  const usedSrns = new Set(existingProfiles.map((r) => r.srn));
  const profileRows = [];
  for (const t of targets) {
    const uid = byEmail.get(t.email);
    if (!uid || havingProfile.has(uid) || usedSrns.has(t.profile.srn)) continue;
    profileRows.push({ user_id: uid, ...t.profile });
  }
  let profilesInserted = 0;
  for (let off = 0; off < profileRows.length; off += BATCH) {
    const chunk = profileRows.slice(off, off + BATCH);
    const result = await sql`
      INSERT INTO student_profiles ${sql(chunk, "user_id", "srn", "level", "articleship_status", "articleship_start", "principal_member_id", "exam_attempts")}
      ON CONFLICT DO NOTHING
      RETURNING user_id
    `;
    profilesInserted += result.length;
    process.stdout.write(".");
  }
  if (profileRows.length > 0) process.stdout.write(" ");

  return inserted + profilesInserted;
}

// ─── 7. Employer ↔ user links ───────────────────────────────────────────────

async function seedEmployerUsers() {
  if (ctx.employerIds.length === 0 || ctx.memberIds.length === 0) return 0;

  // Pre-fetch existing (employer_id, user_id) pairs so we can de-dup in JS.
  const existing = await sql`
    SELECT employer_id, user_id FROM employer_users
    WHERE employer_id = ANY(${ctx.employerIds})
  `;
  const seen = new Set(existing.map((r) => `${r.employer_id}|${r.user_id}`));

  const rows = [];
  for (const employerId of ctx.employerIds) {
    const posters = pickN(ctx.memberIds, randInt(1, 3));
    for (const userId of posters) {
      const key = `${employerId}|${userId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ employer_id: employerId, user_id: userId, role: chance(0.2) ? "owner" : "poster" });
    }
  }
  if (rows.length === 0) return 0;

  const BATCH = 500;
  let inserted = 0;
  for (let off = 0; off < rows.length; off += BATCH) {
    const chunk = rows.slice(off, off + BATCH);
    const result = await sql`
      INSERT INTO employer_users ${sql(chunk, "employer_id", "user_id", "role")}
      RETURNING id
    `;
    inserted += result.length;
    process.stdout.write(".");
  }
  if (rows.length > 0) process.stdout.write(" ");
  return inserted;
}

// ─── 8. User role assignments ───────────────────────────────────────────────

async function seedUserRoleAssignments() {
  const roles = await sql`SELECT id, code, scope FROM roles`;
  if (roles.length === 0 || ctx.memberIds.length === 0) return 0;

  const roleByCode = new Map(roles.map((r) => [r.code, r]));
  const inserted = { count: 0 };

  // DB trigger enforce_committee_chairman_is_mcm() requires a user to hold
  // active mcm BEFORE they can hold committee_chairman. So we sequence
  // assignments: first carve out an "MCM pool" and give them mcm; then
  // give committee_chairman / branch_treasurer / wicasa_chairman to
  // people inside that pool; finally scatter committee_member /
  // newsletter_editor freely.

  async function tryInsert(userId, role, scopeBranchId, scopeCommitteeId, effFrom, effTo) {
    try {
      const result = await sql`
        INSERT INTO user_role_assignments (
          user_id, role_id, scope_branch_id, scope_committee_id, effective_from, effective_to
        )
        SELECT ${userId}, ${role.id}, ${scopeBranchId}, ${scopeCommitteeId}, ${effFrom}, ${effTo}
        WHERE NOT EXISTS (
          SELECT 1 FROM user_role_assignments
          WHERE user_id = ${userId} AND role_id = ${role.id}
            AND COALESCE(scope_branch_id::text, '') = COALESCE(${scopeBranchId}::text, '')
            AND COALESCE(scope_committee_id::text, '') = COALESCE(${scopeCommitteeId}::text, '')
        )
        RETURNING id
      `;
      if (result.length > 0) inserted.count++;
    } catch (e) {
      // Trigger / singleton guards may reject some combinations; skip.
      if (!/singleton|already|mcm|chairman|trigger|cannot hold/i.test(e.message)) throw e;
    }
  }

  // Step 1: create an MCM pool.
  const mcmRole = roleByCode.get("mcm");
  const mcmPool = pickN(ctx.memberIds, Math.min(30, ctx.memberIds.length));
  if (mcmRole) {
    for (const uid of mcmPool) {
      const scopeBranchId = mcmRole.scope === "branch" ? ctx.branchId : null;
      await tryInsert(uid, mcmRole, scopeBranchId, null,
        dateNDaysFromNow(-randInt(180, 600)), null);
    }
  }

  // Step 2: singleton roles (treasurer, wicasa_chairman, committee_chairman)
  // are deliberately SKIPPED here. Assigning mock users to singleton-per-scope
  // roles blocks real-user assignments later — you can't promote a real
  // treasurer if a mock one already holds the (only) slot. Real holders of
  // these roles are managed manually via the admin UI (or scripts/assign-role.mjs).
  // If you ever need to re-enable for some reason, also update
  // scripts/free-mock-singleton-roles.mjs.

  // Step 3: scatter committee_member / newsletter_editor.
  const looseRoleCodes = ["committee_member", "newsletter_editor"];
  for (let i = 0; i < CFG.user_role_assignments; i++) {
    const code = pick(looseRoleCodes);
    const role = roleByCode.get(code);
    if (!role) continue;
    const userId = pick(ctx.memberIds);
    const scopeBranchId = role.scope === "branch" ? ctx.branchId : null;
    const scopeCommitteeId = role.scope === "committee" ? pick(ctx.committees).id : null;
    await tryInsert(userId, role, scopeBranchId, scopeCommitteeId,
      dateNDaysFromNow(-randInt(30, 800)),
      chance(0.3) ? dateNDaysFromNow(randInt(60, 400)) : null);
  }

  return inserted.count;
}

// ─── 9. Office bearers ──────────────────────────────────────────────────────

async function seedOfficeBearers() {
  const existing = await sql`SELECT id FROM office_bearers WHERE term_label LIKE 'MOCK-%'`;
  const need = Math.max(0, CFG.office_bearers - existing.length);
  if (need === 0) return 0;

  // 3 terms: current (2025-26), recent (2024-25), past (2023-24).
  const terms = [
    { label: "MOCK-2025-26", isCurrent: true,  startYear: 2025 },
    { label: "MOCK-2024-25", isCurrent: false, startYear: 2024 },
    { label: "MOCK-2023-24", isCurrent: false, startYear: 2023 },
  ];
  let inserted = 0;
  for (let i = existing.length; i < CFG.office_bearers; i++) {
    const term = terms[i % terms.length];
    const [roleLabel, roleCode] = pick(OFFICE_BEARER_ROLES);
    const personName = `CA ${pick(FIRST_NAMES_M)} ${pick(SURNAMES)}`;
    const tenureStart = `${term.startYear}-04-01`;
    const tenureEnd = `${term.startYear + 1}-03-31`;
    const photoFileId = chance(0.6) ? pick(ctx.fileIds) : null;
    const [row] = await sql`
      INSERT INTO office_bearers (
        term_label, role_label, role_code, person_name, photo_file_id,
        bio, email, phone, is_current, tenure_start, tenure_end, sort_order, hidden
      ) VALUES (
        ${term.label}, ${roleLabel}, ${roleCode}, ${personName}, ${photoFileId},
        ${`${personName} has been associated with the Nagpur Branch for many years and contributes actively in branch initiatives.`},
        ${`bearer${i + 1}@mock-bearer.local`}, ${genIndianPhone()},
        ${term.isCurrent}, ${tenureStart}, ${tenureEnd}, ${i}, false
      )
      RETURNING id
    `;
    if (row) inserted++;
  }
  return inserted;
}

// ─── 10. Rooms ──────────────────────────────────────────────────────────────

async function seedRooms() {
  const existing = await sql`SELECT id, name FROM rooms WHERE name LIKE '[MOCK]%'`;
  ctx.rooms.push(...existing);
  const need = Math.max(0, CFG.rooms - existing.length);
  if (need === 0) return 0;

  let inserted = 0;
  for (let i = existing.length; i < CFG.rooms; i++) {
    const baseName = ROOM_NAMES[i % ROOM_NAMES.length];
    const [row] = await sql`
      INSERT INTO rooms (name, location, capacity, fee_paise_per_hour, active)
      VALUES (
        ${`[MOCK] ${baseName}`}, 'ICAI Bhawan, Civil Lines',
        ${randInt(10, 80)}, ${randInt(50, 500) * 100}, true
      )
      RETURNING id, name
    `;
    ctx.rooms.push(row);
    inserted++;
  }
  return inserted;
}

// ─── 11. Events ─────────────────────────────────────────────────────────────

async function seedEvents() {
  const existing = await sql`SELECT id, slug, status, audience, capacity FROM events WHERE slug LIKE 'mock-%'`;
  for (const e of existing) {
    ctx.events.push({
      id: e.id, slug: e.slug, isPast: e.status === "completed",
      audience: e.audience, capacity: e.capacity,
    });
  }
  const need = Math.max(0, CFG.events - existing.length);
  if (need === 0) return 0;

  const pastCount = Math.floor(CFG.events * CFG.events_past_ratio);
  let inserted = 0;
  for (let i = existing.length + 1; i <= CFG.events; i++) {
    const isPast = i <= pastCount;
    const [commCode, titleTemplate] = pick(EVENT_TITLE_TEMPLATES);
    const committeeId = ctx.committeeByCode.get(commCode) ?? pick(ctx.committees).id;
    const thisYear = new Date().getFullYear() % 100;
    const fy = `${thisYear + (isPast ? -1 : 0)}-${thisYear + (isPast ? 0 : 1)}`;
    const title = titleTemplate.replace("{fy}", fy);
    const slug = `mock-${slugify(title)}-${String(i).padStart(4, "0")}`;
    const daysOffset = isPast ? -randInt(5, 365) : randInt(2, 90);
    const startsAt = isoNDaysFromNow(daysOffset, randInt(10, 17));
    const durationHours = pick([2, 3, 4, 6]);
    const endsAt = new Date(new Date(startsAt).getTime() + durationHours * 3600 * 1000).toISOString();
    const mode = chance(0.7) ? "in_person" : chance(0.5) ? "online" : "hybrid";
    const venue = mode === "online" ? "Online (Zoom)" : pick(VENUES_IN_PERSON);
    const audience = commCode === "WICASA" ? "students" : chance(0.85) ? "members" : "all";
    const capacity = pick([60, 80, 100, 120, 150, 200, 300]);
    const fee = chance(0.7) ? 0 : pick([10000, 25000, 50000, 100000]);
    const status = isPast ? "completed" : "published";
    const bannerId = chance(0.5) ? pick(ctx.fileIds) : null;

    const [row] = await sql`
      INSERT INTO events (
        slug, title, description, committee_id, branch_id, audience, mode, venue,
        starts_at, ends_at, fee_paise, capacity, status, highlights, banner_id
      ) VALUES (
        ${slug}, ${title},
        ${`Practical session on ${title.toLowerCase()}. Open to all ${audience}.`},
        ${committeeId}, ${ctx.branchId}, ${audience}, ${mode}, ${venue},
        ${startsAt}, ${endsAt}, ${fee}, ${capacity}, ${status},
        ${["Hands-on case-study walkthrough", "Q&A with experienced faculty"]},
        ${bannerId}
      )
      ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
      RETURNING id, slug, audience, capacity, (xmax = 0) AS inserted
    `;
    ctx.events.push({
      id: row.id, slug: row.slug, isPast,
      audience: row.audience, capacity: row.capacity,
    });
    if (row.inserted) inserted++;
  }
  return inserted;
}

// ─── 12. Event registrations + CPE ──────────────────────────────────────────

async function seedRegistrationsAndCPE() {
  let regInserted = 0;
  const BATCH = 500;

  for (const ev of ctx.events) {
    const eligible =
      ev.audience === "students" ? ctx.studentIds :
      ev.audience === "members"  ? ctx.memberIds :
      [...ctx.memberIds, ...ctx.studentIds];
    if (eligible.length === 0) continue;

    const target = Math.min(between(CFG.registrations_per_event), ev.capacity ?? Infinity, eligible.length);
    const subset = [...eligible].sort(() => rand() - 0.5).slice(0, target);

    // Pre-load existing regs for this event.
    const existingRegs = new Set((await sql`
      SELECT user_id FROM event_registrations
      WHERE event_id = ${ev.id} AND deleted_at IS NULL
    `).map((r) => r.user_id));

    const regRows = [];
    for (const userId of subset) {
      if (existingRegs.has(userId)) continue;
      let regStatus = "registered";
      let attendedAt = null;
      if (ev.isPast) {
        const r = rand();
        if (r < 0.88) { regStatus = "attended"; attendedAt = isoNDaysFromNow(-randInt(5, 90)); }
        else if (r < 0.96) { regStatus = "no_show"; }
        else { regStatus = "cancelled"; }
      }
      regRows.push({ event_id: ev.id, user_id: userId, status: regStatus, attended_at: attendedAt });
    }

    // Bulk insert registrations.
    for (let off = 0; off < regRows.length; off += BATCH) {
      const chunk = regRows.slice(off, off + BATCH);
      const result = await sql`
        INSERT INTO event_registrations ${sql(chunk, "event_id", "user_id", "status", "attended_at")}
        RETURNING id
      `;
      regInserted += result.length;
    }
    // (CPE credit seeding removed alongside the CPE feature — migration 0087.)

    await sql`
      UPDATE events SET registered_count = (
        SELECT COUNT(*) FROM event_registrations
        WHERE event_id = ${ev.id} AND status IN ('registered', 'attended') AND deleted_at IS NULL
      )
      WHERE id = ${ev.id}
    `;
    process.stdout.write(".");
  }
  process.stdout.write(" ");
  return regInserted;
}

// ─── 13. Payments (standalone mock payments tagged via metadata) ────────────

async function seedPayments() {
  if (ctx.memberIds.length === 0) return 0;
  const purposes = ["event_registration", "consultation", "room_booking", "job_posting", "cabf_donation"];
  let inserted = 0;
  const total = scaled(400);
  for (let i = 0; i < total; i++) {
    const payerId = pick([...ctx.memberIds, ...ctx.studentIds]);
    const amount = pick([10000, 25000, 50000, 100000, 250000, 500000]); // paise
    const purpose = pick(purposes);
    const status = pick(["success", "success", "success", "created", "failed", "refunded"]);
    const [row] = await sql`
      INSERT INTO payments (
        payer_user_id, amount_paise, currency, status, purpose,
        razorpay_order_id, razorpay_payment_id, metadata, created_at
      ) VALUES (
        ${payerId}, ${amount}, 'INR', ${status}, ${purpose},
        ${`order_MOCK${randomUUID().replace(/-/g, "").slice(0, 14)}`},
        ${status === "success" ? `pay_MOCK${randomUUID().replace(/-/g, "").slice(0, 14)}` : null},
        ${JSON.stringify({ mock_seed: true, note: `Seeded payment for ${purpose}` })},
        ${isoNDaysFromNow(-randInt(1, 400))}
      )
      ON CONFLICT (razorpay_order_id) DO NOTHING
      RETURNING id
    `;
    if (row) { ctx.paymentIds.push(row.id); inserted++; }
  }
  return inserted;
}

// ─── 14. Payment refunds ────────────────────────────────────────────────────

async function seedPaymentRefunds() {
  if (ctx.paymentIds.length === 0) return 0;
  let inserted = 0;
  const sample = pickN(ctx.paymentIds, Math.min(CFG.payment_refunds, ctx.paymentIds.length));
  for (const payId of sample) {
    const [row] = await sql`
      INSERT INTO payment_refunds (
        payment_id, amount_paise, reason, status, requested_by, requested_at,
        approved_by, approved_at, notes
      ) VALUES (
        ${payId}, ${randInt(10000, 100000)},
        ${pick(["Event cancelled","Duplicate payment","Member requested","Service not rendered"])},
        ${pick(["requested","approved","processed","rejected"])},
        ${pick(ctx.memberIds)}, ${isoNDaysFromNow(-randInt(5, 90))},
        ${chance(0.6) ? pick(ctx.memberIds) : null},
        ${chance(0.6) ? isoNDaysFromNow(-randInt(1, 5)) : null},
        '[MOCK] Routine refund test row'
      )
      RETURNING id
    `;
    if (row) inserted++;
  }
  return inserted;
}

// ─── 15. Room bookings ──────────────────────────────────────────────────────

async function seedRoomBookings() {
  if (ctx.rooms.length === 0 || ctx.memberIds.length === 0) return 0;
  let inserted = 0;
  for (let i = 0; i < CFG.room_bookings; i++) {
    const room = pick(ctx.rooms);
    const userId = pick(ctx.memberIds);
    const dayOffset = randInt(-180, 90);
    const startHour = randInt(9, 17);
    const slotStart = isoNDaysFromNow(dayOffset, startHour);
    const slotEnd = new Date(new Date(slotStart).getTime() + randInt(1, 4) * 3600 * 1000).toISOString();
    const status = dayOffset < 0
      ? pick(["completed", "completed", "cancelled"])
      : pick(["requested", "confirmed", "confirmed"]);
    try {
      const [row] = await sql`
        INSERT INTO room_bookings (room_id, user_id, slot_start, slot_end, purpose, status)
        VALUES (
          ${room.id}, ${userId}, ${slotStart}, ${slotEnd},
          ${pick(["Committee meeting","CPE training","Internal review","Study group","Member meet"])},
          ${status}
        )
        RETURNING id
      `;
      if (row) inserted++;
    } catch (e) {
      // EXCLUDE gist on (room_id, tstzrange) — silently skip overlap.
      if (!/exclusion|overlap/i.test(e.message)) throw e;
    }
  }
  return inserted;
}

// ─── 16. Consultations ──────────────────────────────────────────────────────

async function seedConsultations() {
  if (ctx.memberIds.length < 5) return 0;
  // Designate ~10 members as counselors.
  const counselors = pickN(ctx.memberIds, Math.min(10, ctx.memberIds.length));
  const clients = [...ctx.memberIds, ...ctx.studentIds];
  let inserted = 0;
  for (let i = 0; i < CFG.consultations; i++) {
    const counselorId = pick(counselors);
    let clientId = pick(clients);
    while (clientId === counselorId) clientId = pick(clients);
    const dayOffset = randInt(-180, 60);
    const startHour = randInt(10, 18);
    const slotStart = isoNDaysFromNow(dayOffset, startHour);
    const slotEnd = new Date(new Date(slotStart).getTime() + 3600 * 1000).toISOString();
    const status = dayOffset < 0
      ? pick(["completed", "completed", "cancelled", "no_show"])
      : pick(["requested", "confirmed"]);
    try {
      const [row] = await sql`
        INSERT INTO consultations (
          counselor_id, client_user_id, kind, slot_start, slot_end, status, medium,
          feedback_rating
        ) VALUES (
          ${counselorId}, ${clientId},
          ${pick(["women_counseling","career_counseling","mentorship"])},
          ${slotStart}, ${slotEnd}, ${status},
          ${pick(["video","call","in_person"])},
          ${status === "completed" && chance(0.7) ? randInt(3, 5) : null}
        )
        RETURNING id
      `;
      if (row) inserted++;
    } catch (e) {
      // EXCLUDE gist on (counselor_id, tstzrange) — silently skip overlap.
      if (!/exclusion|overlap/i.test(e.message)) throw e;
    }
  }
  return inserted;
}

// ─── 17. CABF assistance requests ───────────────────────────────────────────

async function seedCABFRequests() {
  if (ctx.memberIds.length === 0) return 0;
  let inserted = 0;
  const categories = ["[MOCK] Medical","[MOCK] Education","[MOCK] Bereavement","[MOCK] Disability"];
  for (let i = 0; i < CFG.cabf_requests; i++) {
    const memberId = pick(ctx.memberIds);
    const amount = randInt(25000, 200000) * 100;
    const status = pick(["submitted","reviewing","approved","rejected","disbursed","disbursed"]);
    const disbursedAmount = status === "disbursed" ? Math.floor(amount * (0.5 + rand() * 0.5)) : null;
    const [row] = await sql`
      INSERT INTO cabf_assistance_requests (
        member_user_id, category, amount_requested_paise, status, reviewer_user_id,
        decision_note, disbursed_amount_paise, disbursed_at, created_at
      ) VALUES (
        ${memberId}, ${pick(categories)}, ${amount}, ${status},
        ${chance(0.7) ? pick(ctx.memberIds) : null},
        ${chance(0.5) ? "[MOCK] Reviewed by branch CABF panel" : null},
        ${disbursedAmount}, ${disbursedAmount ? isoNDaysFromNow(-randInt(1, 60)) : null},
        ${isoNDaysFromNow(-randInt(10, 300))}
      )
      RETURNING id
    `;
    if (row) inserted++;
  }
  return inserted;
}

// ─── 18. Mentorship requests ────────────────────────────────────────────────

async function seedMentorshipRequests() {
  if (ctx.studentIds.length === 0) return 0;
  let inserted = 0;
  const topics = [
    "[MOCK] Career planning post-CA","[MOCK] Articleship guidance",
    "[MOCK] Exam strategy for Group II","[MOCK] How to pick a firm","[MOCK] CA in Industry vs Practice",
  ];
  for (let i = 0; i < CFG.mentorship_requests; i++) {
    const studentId = pick(ctx.studentIds);
    const mentorId = chance(0.7) ? pick(ctx.memberIds) : null;
    const status = pick(["pending","matched","scheduled","completed","completed","cancelled"]);
    const matchedAt = ["matched","scheduled","completed"].includes(status)
      ? isoNDaysFromNow(-randInt(1, 60)) : null;
    const [row] = await sql`
      INSERT INTO mentorship_requests (
        student_user_id, mentor_user_id, topic, preferred_window, status,
        matched_at, scheduled_at, completed_at
      ) VALUES (
        ${studentId}, ${mentorId}, ${pick(topics)},
        ${pick(["Weekday evenings","Weekend mornings","Anytime","Sat 10am–1pm"])},
        ${status}, ${matchedAt},
        ${status === "scheduled" || status === "completed" ? isoNDaysFromNow(-randInt(0, 30)) : null},
        ${status === "completed" ? isoNDaysFromNow(-randInt(0, 25)) : null}
      )
      RETURNING id
    `;
    if (row) inserted++;
  }
  return inserted;
}

// ─── 19. Articleship matches ────────────────────────────────────────────────

async function seedArticleshipMatches() {
  if (ctx.studentIds.length === 0 || ctx.firmIds.length === 0) return 0;
  let inserted = 0;
  for (let i = 0; i < CFG.articleship_matches; i++) {
    const studentId = pick(ctx.studentIds);
    const status = pick(["submitted","matched","placed","placed","cancelled"]);
    const recommendedFirms = pickN(ctx.firmIds, randInt(2, 5));
    const placedFirm = status === "placed" ? pick(recommendedFirms) : null;
    const [row] = await sql`
      INSERT INTO articleship_matches (
        student_user_id, preferred_specialisations, preferred_location,
        preferred_firm_size, expected_stipend_paise, status,
        recommended_firm_ids, placed_firm_id, notes
      ) VALUES (
        ${studentId},
        ${pickN(AREAS_OF_PRACTICE, randInt(1, 3))},
        ${pick(["Nagpur","Mumbai","Pune","Hyderabad","Anywhere"])},
        ${pick(["sole_practitioner","small","medium","large","big4"])},
        ${randInt(8000, 25000) * 100},
        ${status}, ${recommendedFirms}, ${placedFirm},
        ${chance(0.5) ? "[MOCK] Auto-matched by similarity score" : null}
      )
      RETURNING id
    `;
    if (row) inserted++;
  }
  return inserted;
}

// ─── 20. Mock tests + questions + options + registrations + attempts ──────

async function seedMockTests() {
  if (ctx.studentIds.length === 0) return 0;
  let testsInserted = 0;
  let qInserted = 0;
  let optInserted = 0;
  let regInserted = 0;
  let attemptInserted = 0;

  for (let i = 1; i <= CFG.mock_tests; i++) {
    const level = pick(["foundation", "intermediate", "final"]);
    const groupNo = level === "foundation" ? null : pick([1, 2]);
    const paperNo = randInt(1, level === "foundation" ? 4 : 8);
    const scheduledOffset = randInt(-180, 60);
    const scheduledAt = isoNDaysFromNow(scheduledOffset, randInt(9, 14));
    const status = scheduledOffset < -7 ? "completed" :
                   scheduledOffset < 0  ? "closed" :
                   chance(0.5) ? "open_for_registration" : "scheduled";

    const [row] = await sql`
      INSERT INTO mock_tests (
        branch_id, title, series_name, level, group_no, paper_no, scheduled_at,
        duration_mins, venue, capacity, fee_paise, status, max_score,
        supports_online, registration_close_at
      ) VALUES (
        ${ctx.branchId},
        ${`[MOCK] Mock Test Series — ${level} Paper ${paperNo} #${String(i).padStart(3, "0")}`},
        ${`MOCK-${level.toUpperCase()}-${new Date().getFullYear()}`},
        ${level}, ${groupNo}, ${paperNo}, ${scheduledAt},
        ${pick([120, 180, 240])}, ${pick(VENUES_IN_PERSON)},
        ${randInt(30, 120)}, ${pick([0, 20000, 50000])}, ${status},
        100, ${chance(0.4)},
        ${new Date(new Date(scheduledAt).getTime() - 86400000).toISOString()}
      )
      RETURNING id
    `;
    if (!row) continue;
    ctx.mockTestIds.push(row.id);
    testsInserted++;

    // Questions
    const qCount = between(CFG.mock_test_questions_per_test);
    const questionIds = [];
    for (let q = 1; q <= qCount; q++) {
      const [qRow] = await sql`
        INSERT INTO mock_test_questions (
          mock_test_id, question_no, question_type, body, marks, negative_marks
        ) VALUES (
          ${row.id}, ${q}, 'mcq',
          ${`Mock question #${q}: Which of the following best describes the treatment under the relevant standard?`},
          ${randInt(1, 4)}, ${chance(0.5) ? 0.25 : 0}
        )
        RETURNING id
      `;
      if (qRow) {
        questionIds.push(qRow.id);
        qInserted++;
        // Options A/B/C/D
        const correctIdx = randInt(0, 3);
        for (let o = 0; o < 4; o++) {
          const [oRow] = await sql`
            INSERT INTO mock_test_options (question_id, option_label, body, is_correct)
            VALUES (${qRow.id}, ${["A","B","C","D"][o]}, ${`Option ${["A","B","C","D"][o]} statement text.`}, ${o === correctIdx})
            RETURNING id
          `;
          if (oRow) optInserted++;
        }
      }
    }

    // Registrations
    const regTarget = Math.min(between(CFG.mock_test_regs_per_test), ctx.studentIds.length);
    const subset = pickN(ctx.studentIds, regTarget);
    for (const userId of subset) {
      const isPast = scheduledOffset < 0;
      const regStatus = isPast
        ? pick(["attended","attended","attended","absent","cancelled"])
        : pick(["registered","registered"]);
      const score = regStatus === "attended" ? randInt(35, 95) : null;
      const [regRow] = await sql`
        INSERT INTO mock_test_registrations (mock_test_id, user_id, status, score, attended_at)
        SELECT ${row.id}, ${userId}, ${regStatus}, ${score},
               ${regStatus === "attended" ? scheduledAt : null}
        WHERE NOT EXISTS (
          SELECT 1 FROM mock_test_registrations WHERE mock_test_id = ${row.id} AND user_id = ${userId}
        )
        RETURNING id
      `;
      if (regRow) {
        regInserted++;
        // Attempts (for attended)
        if (regStatus === "attended" && questionIds.length > 0 && chance(0.7)) {
          const [aRow] = await sql`
            INSERT INTO mock_test_attempts (
              mock_test_id, user_id, registration_id, attempt_token,
              started_at, expires_at, submitted_at, status,
              score_auto, score_total, graded_at
            ) VALUES (
              ${row.id}, ${userId}, ${regRow.id},
              ${`MOCK-ATT-${randomUUID().replace(/-/g, "").slice(0, 16)}`},
              ${scheduledAt}, ${new Date(new Date(scheduledAt).getTime() + 180 * 60_000).toISOString()},
              ${new Date(new Date(scheduledAt).getTime() + randInt(60, 175) * 60_000).toISOString()},
              'submitted', ${score}, ${score}, ${new Date(new Date(scheduledAt).getTime() + 200 * 60_000).toISOString()}
            )
            RETURNING id
          `;
          if (aRow) {
            attemptInserted++;
            // Mock test answers for each question (best-effort, no per-question selected option)
            for (const qid of questionIds) {
              await sql`
                INSERT INTO mock_test_answers (
                  attempt_id, question_id, time_spent_ms, marked_for_review
                )
                SELECT ${aRow.id}, ${qid}, ${randInt(5000, 90000)}, ${chance(0.15)}
                WHERE NOT EXISTS (
                  SELECT 1 FROM mock_test_answers WHERE attempt_id = ${aRow.id} AND question_id = ${qid}
                )
              `;
            }
          }
        }
      }
    }
  }
  console.log(`    questions=${qInserted}, options=${optInserted}, regs=${regInserted}, attempts=${attemptInserted}`);
  return testsInserted;
}

// ─── 21. Job postings ───────────────────────────────────────────────────────

async function seedJobPostings() {
  if (ctx.memberIds.length === 0) return 0;
  let inserted = 0;
  const types = ["job", "articleship", "assignment"];
  for (let i = 1; i <= CFG.job_postings; i++) {
    const type = pick(types);
    const titleStub = type === "articleship" ? "Articleship Vacancy" :
                      type === "assignment"  ? "Assignment Opportunity" :
                      "CA Position Open";
    const title = `[MOCK] ${titleStub} — ${pick(AREAS_OF_PRACTICE)}`;
    const usesEmployer = type === "job" && chance(0.6);
    const employerId = usesEmployer && ctx.employerIds.length > 0 ? pick(ctx.employerIds) : null;
    const firmId = !usesEmployer && ctx.firmIds.length > 0 ? pick(ctx.firmIds) : null;
    const posterId = pick(ctx.memberIds);
    const status = pick(["active","active","active","filled","expired","draft"]);
    const expiresAt = chance(0.7) ? isoNDaysFromNow(randInt(15, 90)) : null;
    const [row] = await sql`
      INSERT INTO job_postings (
        type, title, description, poster_user_id, employer_id, firm_id,
        seat_count, experience_required, location, fee_paise, status, expires_at
      ) VALUES (
        ${type}, ${title},
        ${`Detailed description for [MOCK] ${type}. Candidate should have hands-on experience in ${pick(AREAS_OF_PRACTICE)}.`},
        ${posterId}, ${employerId}, ${firmId},
        ${randInt(1, 5)}, ${pick(["Fresher","1-2 years","3-5 years","5+ years","Qualified CA"])},
        'Nagpur', ${pick([0, 25000, 50000])}, ${status}, ${expiresAt}
      )
      RETURNING id
    `;
    if (row) inserted++;
  }
  return inserted;
}

// ─── 22. Bills ──────────────────────────────────────────────────────────────

async function seedBills() {
  if (ctx.memberIds.length === 0) return 0;
  let inserted = 0;
  for (let i = 0; i < CFG.bills; i++) {
    const vendor = `[MOCK] ${pick(VENDOR_NAMES)}`;
    const amount = randInt(2000, 200000) * 100;
    const status = pick(["draft","submitted","approved","approved","paid","rejected"]);
    const eventId = chance(0.6) && ctx.events.length > 0 ? pick(ctx.events).id : null;
    const committeeId = eventId ? null : pick(ctx.committees).id;
    const submittedBy = pick(ctx.memberIds);
    const [row] = await sql`
      INSERT INTO bills (
        event_id, committee_id, vendor_name, description, amount_paise, bill_date, bill_number,
        budget_paise, status, submitted_by, submitted_at, approved_by, approved_at
      ) VALUES (
        ${eventId}, ${committeeId}, ${vendor},
        ${`Vendor invoice for catering / venue / stationery (mock row ${i + 1}).`},
        ${amount}, ${dateNDaysFromNow(-randInt(1, 300))},
        ${`MOCK-INV-${String(i + 1).padStart(5, "0")}`},
        ${chance(0.6) ? amount + randInt(5000, 50000) * 100 : null},
        ${status}, ${submittedBy}, ${isoNDaysFromNow(-randInt(1, 90))},
        ${["approved","paid"].includes(status) ? pick(ctx.memberIds) : null},
        ${["approved","paid"].includes(status) ? isoNDaysFromNow(-randInt(0, 60)) : null}
      )
      RETURNING id
    `;
    if (row) inserted++;
  }
  return inserted;
}

// ─── 23. IUT transfers ──────────────────────────────────────────────────────

async function seedIUTTransfers() {
  if (ctx.memberIds.length === 0) return 0;
  let inserted = 0;
  const accounts = ["MAIN-CC", "WICASA-OPS", "CPE-FUND", "BUILDING-FUND", "CABF-ACCOUNT"];
  for (let i = 1; i <= CFG.iut_transfers; i++) {
    const amount = randInt(5000, 500000) * 100;
    const status = pick(["requested","approved","executed","executed","rejected"]);
    const from = pick(accounts);
    let to = pick(accounts);
    while (to === from) to = pick(accounts);
    const [row] = await sql`
      INSERT INTO iut_transfers (
        amount_paise, transfer_date, from_account, to_account, purpose,
        reference_number, status, requested_by, approved_by, approved_at, executed_at
      ) VALUES (
        ${amount}, ${dateNDaysFromNow(-randInt(1, 200))}, ${from}, ${to},
        ${pick(["Quarterly fund balancing","CPE programme expense reimbursement","WICASA event funding","CABF disbursement"])},
        ${`MOCK-IUT-${String(i).padStart(5, "0")}`},
        ${status}, ${pick(ctx.memberIds)},
        ${["approved","executed"].includes(status) ? pick(ctx.memberIds) : null},
        ${["approved","executed"].includes(status) ? isoNDaysFromNow(-randInt(0, 30)) : null},
        ${status === "executed" ? isoNDaysFromNow(-randInt(0, 25)) : null}
      )
      RETURNING id
    `;
    if (row) inserted++;
  }
  return inserted;
}

// ─── 24. Announcements ──────────────────────────────────────────────────────

async function seedAnnouncements() {
  let inserted = 0;
  for (let i = 1; i <= CFG.announcements; i++) {
    const fy = `${new Date().getFullYear() % 100}-${(new Date().getFullYear() % 100) + 1}`;
    const titleRaw = pick(ANNOUNCEMENT_TITLES).replace("{fy}", fy);
    const title = `[MOCK] ${titleRaw}`;
    const startsAt = isoNDaysFromNow(-randInt(0, 60));
    const endsAt = chance(0.6) ? isoNDaysFromNow(randInt(0, 60)) : null;
    const [row] = await sql`
      INSERT INTO announcements (
        branch_id, title, body, audience, starts_at, ends_at, display_order, created_by
      ) VALUES (
        ${ctx.branchId}, ${title},
        ${`Detailed announcement body — please read carefully. (Mock seed row ${i}.)`},
        ${pick(["all","members","students"])}, ${startsAt}, ${endsAt}, ${i}, ${pick(ctx.memberIds)}
      )
      RETURNING id
    `;
    if (row) inserted++;
  }
  return inserted;
}

// ─── 25. Forum threads + posts ──────────────────────────────────────────────

async function seedForumThreads() {
  if (ctx.memberIds.length === 0) return 0;
  let inserted = 0;
  let postsInserted = 0;
  for (let i = 0; i < CFG.forum_threads; i++) {
    const useEvent = chance(0.4) && ctx.events.length > 0;
    const eventId = useEvent ? pick(ctx.events).id : null;
    const committeeId = useEvent ? null : pick(ctx.committees).id;
    const [row] = await sql`
      INSERT INTO forum_threads (
        title, body, tag, event_id, committee_id, created_by
      ) VALUES (
        ${`[MOCK] ${pick(FORUM_THREAD_TITLES)}`},
        ${`Opening post for the thread. ${pick(["What's the right interpretation here?","Has anyone seen similar cases?","Sharing notes — please critique.","Suggested templates inside."])}`},
        ${pick(["doubt","suggestion","discussion","resource_request","announcement"])},
        ${eventId}, ${committeeId}, ${pick(ctx.memberIds)}
      )
      RETURNING id
    `;
    if (!row) continue;
    inserted++;

    const postCount = between(CFG.forum_posts_per_thread);
    for (let p = 0; p < postCount; p++) {
      const [pRow] = await sql`
        INSERT INTO forum_posts (
          thread_id, body, created_by, attachments, mention_user_ids
        ) VALUES (
          ${row.id},
          ${pick([
            "Thanks for raising — here's how we handled it last year.",
            "I think the answer depends on the specific notification.",
            "Adding a relevant CBDT circular for reference.",
            "Agreed. Also worth checking the Sec 44 implications.",
            "Sharing our internal SOP — happy to discuss offline.",
            "Will revisit after the next council meeting.",
          ])},
          ${pick(ctx.memberIds)}, '[]'::jsonb, ${[]}
        )
        RETURNING id
      `;
      if (pRow) postsInserted++;
    }
  }
  console.log(`    posts=${postsInserted}`);
  return inserted;
}

// ─── 26. Paper presentations + topics ───────────────────────────────────────

async function seedPaperPresentations() {
  let inserted = 0;
  for (let i = 1; i <= CFG.paper_presentations; i++) {
    const title = `${pick(PAPER_TITLES)} — Mock Paper #${i}`;
    const slug = `mock-${slugify(title)}-${i}`;
    const committeeId = pick(ctx.committees).id;
    const authorId = chance(0.7) ? pick(ctx.memberIds) : null;
    const pdfId = chance(0.7) ? pick(ctx.fileIds) : null;
    const coverId = chance(0.5) ? pick(ctx.fileIds) : null;
    const [row] = await sql`
      INSERT INTO paper_presentations (
        slug, title, speaker_name, committee_id, presented_on, pdf_file_id, cover_file_id,
        description, abstract, author_user_id, author_designation, hidden, sort_order,
        status, published_at, view_count
      ) VALUES (
        ${slug}, ${title},
        ${authorId ? `CA ${pick(FIRST_NAMES_M)} ${pick(SURNAMES)}` : "Guest Faculty"},
        ${committeeId}, ${dateNDaysFromNow(-randInt(5, 1000))},
        ${pdfId}, ${coverId},
        ${`Practitioner notes on ${title.toLowerCase()}.`},
        ${`This paper covers the practical aspects of ${title.toLowerCase()}, drawing on recent case studies and notifications.`},
        ${authorId}, ${authorId ? pick(["Partner","Senior Partner","Principal","Associate"]) : null},
        false, ${i}, 'published', ${isoNDaysFromNow(-randInt(1, 500))}, ${randInt(0, 800)}
      )
      ON CONFLICT (slug) DO NOTHING
      RETURNING id
    `;
    if (row) {
      ctx.paperIds.push(row.id);
      inserted++;
      // Assign 1–3 topics.
      if (ctx.topicIds.length > 0) {
        for (const topicId of pickN(ctx.topicIds, randInt(1, 3))) {
          await sql`
            INSERT INTO paper_topics (paper_id, topic_id)
            VALUES (${row.id}, ${topicId})
            ON CONFLICT DO NOTHING
          `;
        }
      }
    }
  }
  return inserted;
}

// ─── 27. E-journal issues + topics ──────────────────────────────────────────

async function seedEJournalIssues() {
  let inserted = 0;
  for (let i = 1; i <= CFG.ejournal_issues; i++) {
    const year = 2018 + Math.floor((i - 1) / 4);
    const quarter = ((i - 1) % 4) + 1;
    const slug = `mock-ejournal-${year}-q${quarter}-${i}`;
    const title = `[MOCK] Nagpur Branch e-Journal — Q${quarter} ${year}`;
    const [row] = await sql`
      INSERT INTO ejournal_issues (
        slug, title, issue_label, issue_year, issue_quarter,
        cover_file_id, pdf_file_id, editorial_summary, status, published_at, view_count
      ) VALUES (
        ${slug}, ${title},
        ${`Q${quarter} ${year}`}, ${year}, ${quarter},
        ${chance(0.7) ? pick(ctx.fileIds) : null},
        ${chance(0.7) ? pick(ctx.fileIds) : null},
        ${`Editorial roundup for Q${quarter} ${year} — featuring articles from the branch faculty and contributing members.`},
        'published', ${isoNDaysFromNow(-randInt(1, 1500))}, ${randInt(0, 600)}
      )
      ON CONFLICT (slug) DO NOTHING
      RETURNING id
    `;
    if (row) {
      ctx.ejournalIds.push(row.id);
      inserted++;
      if (ctx.topicIds.length > 0) {
        for (const topicId of pickN(ctx.topicIds, randInt(1, 4))) {
          await sql`
            INSERT INTO ejournal_topics (issue_id, topic_id)
            VALUES (${row.id}, ${topicId})
            ON CONFLICT DO NOTHING
          `;
        }
      }
    }
  }
  return inserted;
}

// ─── 28. Resource bookmarks + subscriptions + comments ─────────────────────

async function seedResourceBookmarks() {
  const resources = [
    ...ctx.paperIds.map((id) => ["paper", id]),
    ...ctx.ejournalIds.map((id) => ["ejournal", id]),
  ];
  if (resources.length === 0 || ctx.memberIds.length === 0) return 0;
  let inserted = 0;
  for (let i = 0; i < CFG.resource_bookmarks; i++) {
    const [type, id] = pick(resources);
    const userId = pick(ctx.memberIds);
    const [row] = await sql`
      INSERT INTO resource_bookmarks (user_id, resource_type, resource_id)
      SELECT ${userId}, ${type}, ${id}
      WHERE NOT EXISTS (
        SELECT 1 FROM resource_bookmarks
        WHERE user_id = ${userId} AND resource_type = ${type} AND resource_id = ${id}
      )
      RETURNING id
    `;
    if (row) inserted++;
  }
  return inserted;
}

async function seedTopicSubscriptions() {
  if (ctx.topicIds.length === 0 || ctx.memberIds.length === 0) return 0;
  let inserted = 0;
  for (let i = 0; i < CFG.resource_topic_subs; i++) {
    const userId = pick(ctx.memberIds);
    const topicId = pick(ctx.topicIds);
    const [row] = await sql`
      INSERT INTO resource_topic_subscriptions (user_id, topic_id)
      SELECT ${userId}, ${topicId}
      WHERE NOT EXISTS (
        SELECT 1 FROM resource_topic_subscriptions
        WHERE user_id = ${userId} AND topic_id = ${topicId}
      )
      RETURNING id
    `;
    if (row) inserted++;
  }
  return inserted;
}

async function seedResourceComments() {
  const resources = [
    ...ctx.paperIds.map((id) => ["paper", id]),
    ...ctx.ejournalIds.map((id) => ["ejournal", id]),
  ];
  if (resources.length === 0 || ctx.memberIds.length === 0) return 0;
  let inserted = 0;
  const bodies = [
    "[MOCK] Great article — thanks for sharing.",
    "[MOCK] Could you elaborate on the ICDS treatment?",
    "[MOCK] We faced a similar issue with a client recently.",
    "[MOCK] Would appreciate a follow-up paper on the litigation angle.",
    "[MOCK] Sharing this with my articles this evening.",
  ];
  for (let i = 0; i < CFG.resource_comments; i++) {
    const [type, id] = pick(resources);
    const [row] = await sql`
      INSERT INTO resource_comments (resource_type, resource_id, user_id, body, status)
      VALUES (${type}, ${id}, ${pick(ctx.memberIds)}, ${pick(bodies)}, 'visible')
      RETURNING id
    `;
    if (row) inserted++;
  }
  return inserted;
}

// ─── 29. Resource quizzes + questions + options + attempts ─────────────────

async function seedResourceQuizzes() {
  if (ctx.paperIds.length === 0 || ctx.memberIds.length === 0) return 0;
  let quizInserted = 0;
  let qInserted = 0;
  let optInserted = 0;
  let attInserted = 0;

  const pool = pickN(ctx.paperIds, Math.min(CFG.resource_quizzes, ctx.paperIds.length));
  for (const paperId of pool) {
    const [row] = await sql`
      INSERT INTO resource_quizzes (
        paper_id, pass_threshold, question_count, cooldown_hours, is_published
      ) VALUES (${paperId}, 4, 5, 24, true)
      ON CONFLICT (paper_id) DO NOTHING
      RETURNING id
    `;
    if (!row) continue;
    ctx.quizIds.push(row.id);
    quizInserted++;

    for (let q = 1; q <= 5; q++) {
      const [qRow] = await sql`
        INSERT INTO resource_quiz_questions (quiz_id, sort_order, text, explanation)
        VALUES (${row.id}, ${q}, ${`Mock quiz question ${q}: which option below correctly states the principle?`},
                ${`Refer to the paper's section ${q}.`})
        RETURNING id
      `;
      if (qRow) {
        qInserted++;
        const correctIdx = randInt(0, 3);
        for (let o = 0; o < 4; o++) {
          const [oRow] = await sql`
            INSERT INTO resource_quiz_options (question_id, sort_order, text, is_correct)
            VALUES (${qRow.id}, ${o}, ${`Statement ${["A","B","C","D"][o]}.`}, ${o === correctIdx})
            RETURNING id
          `;
          if (oRow) optInserted++;
        }
      }
    }

    // Attempts.
    const attemptCount = between(CFG.resource_quiz_attempts_per_quiz);
    const attemptUsers = pickN(ctx.memberIds, Math.min(attemptCount, ctx.memberIds.length));
    for (const uid of attemptUsers) {
      const score = randInt(2, 5);
      const passed = score >= 4;
      const [aRow] = await sql`
        INSERT INTO resource_quiz_attempts (quiz_id, user_id, score, passed, completed_at)
        VALUES (${row.id}, ${uid}, ${score}, ${passed}, ${isoNDaysFromNow(-randInt(1, 200))})
        RETURNING id
      `;
      if (aRow) attInserted++;
    }
  }
  console.log(`    questions=${qInserted}, options=${optInserted}, attempts=${attInserted}`);
  return quizInserted;
}

// ─── 30. ICAI link cards ────────────────────────────────────────────────────

async function seedICAILinkCards() {
  let inserted = 0;
  const categories = ["regulatory", "compliance", "tools", "resources"];
  for (let i = 1; i <= CFG.icai_link_cards; i++) {
    const [row] = await sql`
      INSERT INTO icai_link_cards (category, title, description, url, icon_emoji, sort_order, active, created_by)
      VALUES (
        ${pick(categories)},
        ${`[MOCK] Quick link #${i} — ${pick(["MCA Portal","Income Tax e-Filing","GST Portal","ICAI Home","WIRC","DRB","BoS Knowledge Portal"])}`},
        ${`Direct link to a frequently-used external resource (mock entry ${i}).`},
        ${`https://example.com/mock-link-${i}`},
        ${pick(["🔗","📂","📋","⚖️","🧾","📊","📚"])},
        ${i}, true, ${chance(0.6) ? pick(ctx.memberIds) : null}
      )
      RETURNING id
    `;
    if (row) inserted++;
  }
  return inserted;
}

// ─── 31. Gallery albums + photos ────────────────────────────────────────────

async function seedGalleries() {
  if (ctx.fileIds.length === 0) return 0;
  let albumsInserted = 0;
  let photosInserted = 0;
  for (let i = 1; i <= CFG.gallery_albums; i++) {
    const eventId = chance(0.7) && ctx.events.length > 0 ? pick(ctx.events).id : null;
    const [row] = await sql`
      INSERT INTO gallery_albums (
        title, event_id, occurred_on, description, cover_file_id, sort_order, visibility
      ) VALUES (
        ${`[MOCK] Album #${i} — ${pick(["GST Workshop","Annual Day","Members Meet","WICASA Day","Independence Day","Annual Conference","CPE Programme"])}`},
        ${eventId}, ${dateNDaysFromNow(-randInt(5, 1500))},
        ${"Photographs from the event."},
        ${pick(ctx.fileIds)}, ${i}, ${pick(["public","public","members"])}
      )
      RETURNING id
    `;
    if (!row) continue;
    albumsInserted++;

    const photoCount = between(CFG.gallery_photos_per_album);
    for (let p = 0; p < photoCount; p++) {
      const [pRow] = await sql`
        INSERT INTO gallery_photos (album_id, file_id, caption, sort_order)
        VALUES (${row.id}, ${pick(ctx.fileIds)},
                ${pick(["Group photo","Inauguration","Felicitation","Audience","Q&A session","Refreshments break", null])},
                ${p})
        RETURNING id
      `;
      if (pRow) photosInserted++;
    }
  }
  console.log(`    photos=${photosInserted}`);
  return albumsInserted;
}

// ─── 32. Branch newsletters ─────────────────────────────────────────────────

async function seedBranchNewsletters() {
  let inserted = 0;
  for (let i = 1; i <= CFG.branch_newsletters; i++) {
    const issueYear = 2022 + Math.floor((i - 1) / 12);
    const issueMonth = ((i - 1) % 12) + 1;
    const [row] = await sql`
      INSERT INTO branch_newsletters (
        title, issue_month, issue_year, pdf_file_id, cover_file_id, editor_note,
        published_at, hidden
      ) VALUES (
        ${`[MOCK] Branch Newsletter — ${issueMonth}/${issueYear}`},
        ${issueMonth}, ${issueYear},
        ${chance(0.7) ? pick(ctx.fileIds) : null},
        ${chance(0.7) ? pick(ctx.fileIds) : null},
        ${`From the editor's desk — issue ${issueMonth}/${issueYear}. (Mock seed row.)`},
        ${isoNDaysFromNow(-randInt(15, 700))}, false
      )
      ON CONFLICT (issue_year, issue_month) DO NOTHING
      RETURNING id
    `;
    if (row) inserted++;
  }
  return inserted;
}

// ─── 33. Annual reports ─────────────────────────────────────────────────────

async function seedAnnualReports() {
  let inserted = 0;
  for (let i = 1; i <= CFG.annual_reports; i++) {
    const startYr = 2018 + (i - 1);
    const fy = `MOCK-FY${startYr}-${(startYr + 1) % 100}`;
    const [row] = await sql`
      INSERT INTO annual_reports (
        fy_label, title, pdf_file_id, cover_file_id, summary, published_at, hidden
      ) VALUES (
        ${fy}, ${`[MOCK] Annual Report ${startYr}-${startYr + 1}`},
        ${chance(0.8) ? pick(ctx.fileIds) : null},
        ${chance(0.6) ? pick(ctx.fileIds) : null},
        ${`Audited financial statements, achievements and activities of the Nagpur Branch for the financial year ${startYr}-${startYr + 1}.`},
        ${isoNDaysFromNow(-randInt(30, 1500))}, false
      )
      ON CONFLICT (fy_label) DO NOTHING
      RETURNING id
    `;
    if (row) inserted++;
  }
  return inserted;
}

// ─── 34. Grievances ─────────────────────────────────────────────────────────

async function seedGrievances() {
  // Make sure default subject routes exist (idempotent).
  const subjects = await sql`SELECT subject FROM grievance_subject_routes`;
  if (subjects.length === 0) {
    for (const subj of GRIEVANCE_SUBJECTS_DEFAULT) {
      await sql`
        INSERT INTO grievance_subject_routes (subject, label, route_email, active)
        VALUES (${subj}, ${subj.replace(/_/g, " ")}, ${`mock-grievance+${subj}@${MOCK_EMAIL_DOMAIN}`}, true)
        ON CONFLICT (subject) DO NOTHING
      `;
    }
  }

  let inserted = 0;
  const subjectPool = (await sql`SELECT subject FROM grievance_subject_routes WHERE active = true`).map((r) => r.subject);
  for (let i = 1; i <= CFG.grievances; i++) {
    const linkedUserId = chance(0.7) ? pick(ctx.memberIds) : null;
    const status = pick(["open","open","in_review","resolved","resolved","closed"]);
    const [row] = await sql`
      INSERT INTO grievances (
        ticket_no, name, email, phone, subject, against_type, against_ref,
        message, user_id, status, assigned_to, resolution_note, resolved_at, created_at
      ) VALUES (
        ${`MOCK-${String(i).padStart(6, "0")}`},
        ${`${pick(FIRST_NAMES_M)} ${pick(SURNAMES)}`},
        ${linkedUserId ? mockEmail("m", randInt(1, ctx.memberIds.length)) : `complainant${i}@mock-grievance.local`},
        ${genIndianPhone()},
        ${pick(subjectPool)}, ${pick(["member","firm","branch"])},
        ${chance(0.6) ? `MOCK-REF-${randInt(1000, 9999)}` : null},
        ${`Mock grievance message #${i}. Please look into the matter at the earliest convenience.`},
        ${linkedUserId}, ${status},
        ${["in_review","resolved","closed"].includes(status) ? pick(ctx.memberIds) : null},
        ${["resolved","closed"].includes(status) ? "Resolved after internal discussion." : null},
        ${["resolved","closed"].includes(status) ? isoNDaysFromNow(-randInt(0, 30)) : null},
        ${isoNDaysFromNow(-randInt(0, 200))}
      )
      ON CONFLICT (ticket_no) DO NOTHING
      RETURNING id
    `;
    if (row) inserted++;
  }
  return inserted;
}

// ─── 35. Notifications ──────────────────────────────────────────────────────

async function seedNotifications() {
  if (ctx.memberIds.length === 0) return 0;
  const all = [...ctx.memberIds, ...ctx.studentIds];
  const rows = [];
  for (let i = 0; i < CFG.notifications; i++) {
    const isRead = chance(0.55);
    rows.push({
      user_id: pick(all),
      template_key: null,
      title: `[MOCK] ${pick(NOTIFICATION_TITLES)}`,
      body: "Body of the notification — short, scannable, with a clear next action.",
      link_url: chance(0.6) ? "/notifications" : null,
      metadata: JSON.stringify({ mock_seed: true }),
      read_at: isRead ? isoNDaysFromNow(-randInt(0, 10)) : null,
      created_at: isoNDaysFromNow(-randInt(0, 60)),
    });
  }
  const BATCH = 500;
  let inserted = 0;
  for (let off = 0; off < rows.length; off += BATCH) {
    const chunk = rows.slice(off, off + BATCH);
    const result = await sql`
      INSERT INTO notifications ${sql(chunk, "user_id", "template_key", "title", "body", "link_url", "metadata", "read_at", "created_at")}
      RETURNING id
    `;
    inserted += result.length;
    process.stdout.write(".");
  }
  if (rows.length > 0) process.stdout.write(" ");
  return inserted;
}

// ─── Orchestrator ───────────────────────────────────────────────────────────

try {
  console.log(`\nMock data stress seed — scale=${SCALE}`);
  console.log(`Target volumes:`, Object.fromEntries(
    Object.entries(CFG).filter(([, v]) => typeof v === "number")
  ));

  await preflight();

  // Dependency order matters — sections that produce IDs run before sections that consume them.
  await section("files",                 seedFiles);
  await section("resource_topics",       seedResourceTopics);
  await section("firms",                 seedFirms);
  await section("employers",             seedEmployers);
  await section("members",               seedMembers);
  await section("students",              seedStudents);
  await section("employer_users",        seedEmployerUsers);
  await section("user_role_assignments", seedUserRoleAssignments);
  await section("office_bearers",        seedOfficeBearers);
  await section("rooms",                 seedRooms);
  await section("events",                seedEvents);
  await section("registrations_cpe",     seedRegistrationsAndCPE);
  await section("payments",              seedPayments);
  await section("payment_refunds",       seedPaymentRefunds);
  await section("room_bookings",         seedRoomBookings);
  await section("consultations",         seedConsultations);
  await section("cabf",                  seedCABFRequests);
  await section("mentorship",            seedMentorshipRequests);
  await section("articleship_matches",   seedArticleshipMatches);
  await section("mock_tests",            seedMockTests);
  await section("job_postings",          seedJobPostings);
  await section("bills",                 seedBills);
  await section("iut_transfers",         seedIUTTransfers);
  await section("announcements",         seedAnnouncements);
  await section("forum",                 seedForumThreads);
  await section("paper_presentations",   seedPaperPresentations);
  await section("ejournal_issues",       seedEJournalIssues);
  await section("resource_bookmarks",    seedResourceBookmarks);
  await section("topic_subscriptions",   seedTopicSubscriptions);
  await section("resource_comments",     seedResourceComments);
  await section("resource_quizzes",      seedResourceQuizzes);
  await section("icai_link_cards",       seedICAILinkCards);
  await section("gallery",               seedGalleries);
  await section("newsletters",           seedBranchNewsletters);
  await section("annual_reports",        seedAnnualReports);
  await section("grievances",            seedGrievances);
  await section("notifications",         seedNotifications);

  // Summary
  const totalRows = Object.values(summary).reduce((sum, s) => sum + (s.count ?? 0), 0);
  const totalMs = Object.values(summary).reduce((sum, s) => sum + (s.ms ?? 0), 0);
  console.log(`\n──────────────────────────────────────────────`);
  console.log(`Done. ${totalRows} total rows inserted across ${Object.keys(summary).length} sections in ${(totalMs / 1000).toFixed(1)}s.`);
  const failed = Object.entries(summary).filter(([, s]) => s.error);
  if (failed.length > 0) {
    console.log(`\n${failed.length} section(s) had errors:`);
    for (const [name, s] of failed) console.log(`  ✗ ${name}: ${s.error}`);
  }
  console.log(`\nTo wipe: node scripts/clean-mock-data.mjs\n`);
} catch (err) {
  console.error("\n✗ Top-level failure:", err.message);
  if (err.detail) console.error("  detail:", err.detail);
  if (err.where)  console.error("  where: ", err.where);
  process.exitCode = 1;
} finally {
  await sql.end();
}
