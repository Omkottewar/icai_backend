// Adds 5 more articleship openings to /job-vacancies?type=articleship.
//
// Idempotent — every posting title carries a `[BATCH-2]` marker; the script
// bails if any of the 5 titles already exist. Firms are keyed by
// registration_no (unique) with the `DEMO2-FRN-` prefix so re-runs never
// collide with the primary demo seed (`DEMO-FRN-` in seed-demo-jobs.mjs).
//
// Usage:  node scripts/seed-more-articleships.mjs

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
    registration_no: "DEMO2-FRN-140215W",
    name: "Bhandari Ranka & Co.",
    email: "articles@bhandariranka-demo.in",
    phone: "+91 712 224 8877",
    website: "https://bhandariranka-demo.in",
    address: "3rd Floor, Panchsheel Square, Wardhaman Nagar",
    city: "Nagpur",
    pincode: "440008",
    partners_count: 5,
    areas_of_expertise: ["Statutory Audit", "Ind AS", "Corporate Tax"],
  },
  {
    registration_no: "DEMO2-FRN-146891W",
    name: "Ghatate Kalantri LLP",
    email: "recruit@ghatatekalantri-demo.in",
    phone: "+91 712 275 1420",
    website: "https://ghatatekalantri-demo.in",
    address: "Hindustan Colony, Amravati Road",
    city: "Nagpur",
    pincode: "440033",
    partners_count: 7,
    areas_of_expertise: ["Internal Audit", "Risk Advisory", "SOX Testing"],
  },
  {
    registration_no: "DEMO2-FRN-151203W",
    name: "Motiwala Jain & Associates",
    email: "hr@motiwalajain-demo.in",
    phone: "+91 712 260 3344",
    address: "Opposite RBI, Civil Lines",
    city: "Nagpur",
    pincode: "440001",
    partners_count: 4,
    areas_of_expertise: ["Indirect Tax", "GST Litigation", "Customs"],
  },
  {
    registration_no: "DEMO2-FRN-157788W",
    name: "Deshpande Karandikar & Co.",
    email: "office@deshpandekarandikar-demo.in",
    phone: "+91 712 253 9021",
    address: "Shankar Nagar Square",
    city: "Nagpur",
    pincode: "440010",
    partners_count: 3,
    areas_of_expertise: ["Concurrent Audit", "Bank Audit", "Trust Audit"],
  },
  {
    registration_no: "DEMO2-FRN-163344W",
    name: "Agrawal Malani & Partners",
    email: "articleship@agrawalmalani-demo.in",
    phone: "+91 712 271 6655",
    website: "https://agrawalmalani-demo.in",
    address: "West High Court Road, Dharampeth",
    city: "Nagpur",
    pincode: "440010",
    partners_count: 6,
    areas_of_expertise: ["M&A Advisory", "Valuations", "Due Diligence"],
  },
];

const POSTINGS = [
  {
    firm_registration: "DEMO2-FRN-140215W",
    title: "[BATCH-2] Articleship — Ind AS Statutory Audit Track",
    experience_required: "CA Intermediate — both groups cleared",
    location: "Nagpur (Wardhaman Nagar)",
    seat_count: 3,
    description: [
      "Ind-AS-heavy articleship with a mid-size firm servicing 4 listed clients across auto-components and specialty chemicals.",
      "",
      "You will work on:",
      "• Quarterly limited reviews and annual statutory audits",
      "• Ind AS 115 (revenue), Ind AS 116 (leases), and Ind AS 109 (financial instruments)",
      "• IFC / ICFR testing under CARO 2020",
      "• Analytical review procedures, walkthroughs, and audit documentation",
      "",
      "Stipend: ₹14,000 / ₹17,000 / ₹20,000 across the three years. Study leave: 2 weeks before every exam attempt.",
    ].join("\n"),
    daysToExpire: 60,
  },
  {
    firm_registration: "DEMO2-FRN-146891W",
    title: "[BATCH-2] Articleship — Internal Audit & Risk Advisory",
    experience_required: "CA Intermediate — Group I minimum",
    location: "Nagpur (Amravati Road)",
    seat_count: 4,
    description: [
      "Articleship with a focused internal audit and risk advisory practice — clients include listed manufacturing, hospitality, and healthcare groups.",
      "",
      "Learning exposure:",
      "• Process reviews (P2P, O2C, R2R, HR) using flowcharts and RACM",
      "• SOX ITGC and business process control testing",
      "• ERP walkthroughs (SAP, Oracle NetSuite, Tally Prime)",
      "• Client visits within Vidarbha, occasional travel to Mumbai / Pune",
      "",
      "Stipend: 20% above ICAI minimum + performance bonus. Client-visit TA/DA reimbursed.",
    ].join("\n"),
    daysToExpire: 60,
  },
  {
    firm_registration: "DEMO2-FRN-151203W",
    title: "[BATCH-2] Articleship — Indirect Tax & GST Litigation",
    experience_required: "CA Intermediate — both groups cleared",
    location: "Nagpur (Civil Lines)",
    seat_count: 2,
    description: [
      "Boutique indirect-tax practice handling GST advisory, litigation, and customs valuation matters for manufacturing and trading clients across central India.",
      "",
      "Typical work:",
      "• Drafting replies to SCNs, DRC-01, ASMT-10 and appeals up to Commissioner (Appeals)",
      "• Preparation of representations at GST Council / CBIC level",
      "• Classification opinions, ITC eligibility, cross-border service taxability",
      "• Departmental audit and GST annual return support",
      "",
      "Stipend: ₹16,000 / ₹19,000 / ₹22,000. Preference for students comfortable in Marathi & Hindi for departmental interactions.",
    ].join("\n"),
    daysToExpire: 60,
  },
  {
    firm_registration: "DEMO2-FRN-157788W",
    title: "[BATCH-2] Articleship — Bank & Trust Concurrent Audit",
    experience_required: "CA Foundation cleared, CA Inter appearing",
    location: "Nagpur (Shankar Nagar)",
    seat_count: 3,
    description: [
      "Traditional practice with a strong concurrent audit desk — nationalised bank branches, urban co-op banks, and public charitable trusts.",
      "",
      "You'll rotate through:",
      "• Concurrent audit of assigned bank branches (KYC, advances, forex, treasury)",
      "• Statutory branch audit during Q4 (rotational allocation)",
      "• Trust audits under Bombay Public Trusts Act & Section 12A/10(23C) compliance",
      "• GST returns, TDS, ROC filings for the firm's general-practice clients",
      "",
      "Stipend as per ICAI schedule. Flexible attendance during exam months (up to 6 weeks/year study leave).",
    ].join("\n"),
    daysToExpire: 60,
  },
  {
    firm_registration: "DEMO2-FRN-163344W",
    title: "[BATCH-2] Articleship — M&A, Valuations & Due Diligence",
    experience_required: "CA Intermediate — both groups cleared, exposure to Excel modelling preferred",
    location: "Nagpur (Dharampeth)",
    seat_count: 2,
    description: [
      "Niche corporate advisory practice — perfect for students targeting a transaction-advisory or IB career post-qualification.",
      "",
      "Engagements include:",
      "• Financial and tax due-diligence for PE / strategic-buyer targets",
      "• Registered-valuer reports (IBBI) for shares, businesses, and intangible assets",
      "• Purchase-price allocation, working-capital normalisation, EBITDA bridge builds",
      "• Occasional insolvency-resolution assignments under IBC",
      "",
      "Stipend: ₹20,000 / ₹24,000 / ₹28,000 (well above ICAI minimum). Selection includes an Excel modelling test + partner interview.",
    ].join("\n"),
    daysToExpire: 60,
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
    WHERE title LIKE '[BATCH-2]%' AND deleted_at IS NULL
  `;
  if (existing[0].n > 0) {
    console.log(`= ${existing[0].n} [BATCH-2] postings already exist — skipping insert.`);
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
    const firmId = firmIdByRegNo.get(p.firm_registration);
    const expiresAt = isoDaysFromNow(p.daysToExpire);
    const [row] = await sql`
      INSERT INTO job_postings (
        type, title, description, poster_user_id, firm_id,
        seat_count, experience_required, location, fee_paise, status, expires_at
      ) VALUES (
        'articleship', ${p.title}, ${p.description},
        ${poster.id}, ${firmId},
        ${p.seat_count}, ${p.experience_required},
        ${p.location}, 0, 'active', ${expiresAt}
      )
      RETURNING id
    `;
    if (row) {
      console.log(`✓ articleship — ${p.title}`);
      inserted++;
    }
  }

  console.log(`\nDone. ${inserted} articleship opening${inserted === 1 ? "" : "s"} inserted.`);
} catch (err) {
  console.error("✗ Failed:", err.message);
  if (err.detail) console.error("  detail:", err.detail);
  process.exitCode = 1;
} finally {
  await sql.end();
}
