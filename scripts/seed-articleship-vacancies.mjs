// Seeds 5 realistic articleship vacancies from Nagpur CA firms so the
// /job-vacancies?type=articleship page shows actual listings instead of
// the "No articleship vacancies at the moment" empty state.
//
// What this does:
//   1. Ensures 5 realistic Nagpur CA firms exist in the `firms` table.
//      Firms carry a unique registration_no so re-runs UPDATE rather
//      than duplicate.
//   2. Ensures a "system-poster" user exists — job_postings requires a
//      poster_user_id (NOT NULL FK to users). We reuse an existing admin
//      if one is around, otherwise create a shell user.
//   3. Upserts 5 articleship postings (status='active', 30-day expiry).
//      Idempotent on (title, firm_id).
//
// Usage:
//   node scripts/seed-articleship-vacancies.mjs
//   node scripts/seed-articleship-vacancies.mjs --refresh   # bump expiry + description

import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const REFRESH = process.argv.includes("--refresh");
const sql = postgres(url, { max: 1, prepare: false });

// ─── Firms ────────────────────────────────────────────────────────────────
// Registration numbers look like real ICAI-issued FRN patterns (6-digit
// followed by a suffix letter). They're not linked to actual live firms —
// substitute the real numbers if you have them.

// Firm names are prefixed with "DEMO —" so the openings page makes it
// unmistakable to real users that these are placeholder/demo firms
// (helpful during pilot / soft-launch before real employers post).
// When a real firm posts through the admin flow, no prefix is applied.
const FIRMS = [
  {
    name:              "DEMO — Sharma Choudhary & Associates",
    registration_no:   "108452C",
    email:             "articles@sharmachoudhary.in",
    phone:             "+91 712 254 6712",
    website:           "https://sharmachoudhary.in",
    address:           "3rd Floor, Trimurti Complex, Wardhaman Nagar",
    city:              "Nagpur",
    pincode:           "440008",
    partners_count:    4,
    areas:             ["GST", "Direct Tax", "Statutory Audit"],
  },
  {
    name:              "DEMO — Deshmukh Kale & Co.",
    registration_no:   "119203C",
    email:             "articles@deshmukhkale.com",
    phone:             "+91 712 224 8890",
    website:           "https://deshmukhkale.com",
    address:           "Kingsway Business Centre, Kingsway Road",
    city:              "Nagpur",
    pincode:           "440001",
    partners_count:    7,
    areas:             ["Statutory Audit", "Tax Audit", "Internal Audit", "IND AS"],
  },
  {
    name:              "DEMO — Iyer Naidu Advisory LLP",
    registration_no:   "132876N",
    email:             "hr@iyernaiduadvisory.com",
    phone:             "+91 712 660 4501",
    website:           "https://iyernaiduadvisory.com",
    address:           "Business Bay, Ramdaspeth",
    city:              "Nagpur",
    pincode:           "440010",
    partners_count:    12,
    areas:             ["Corporate Advisory", "M&A", "Transfer Pricing", "GST"],
  },
  {
    name:              "DEMO — Mundra & Bhagchandka",
    registration_no:   "127654W",
    email:             "articles@mundrabhagchandka.in",
    phone:             "+91 712 254 3120",
    website:           "https://mundrabhagchandka.in",
    address:           "Ganga Bhavan, Sitabuldi",
    city:              "Nagpur",
    pincode:           "440012",
    partners_count:    3,
    areas:             ["GST", "Small & Medium Practice", "Bank Audit"],
  },
  {
    name:              "DEMO — Rathi Jain & Partners",
    registration_no:   "141298C",
    email:             "recruitment@rathijain.co.in",
    phone:             "+91 712 224 5511",
    website:           "https://rathijain.co.in",
    address:           "IT Park, Parsodi",
    city:              "Nagpur",
    pincode:           "440022",
    partners_count:    9,
    areas:             ["Indirect Tax", "Litigation Support", "IND AS", "IT Advisory"],
  },
];

// ─── Articleship postings ─────────────────────────────────────────────────
// One per firm. Real-life-feeling descriptions that a student would read
// and think "yes, this is the kind of firm/work I want".

const nowIso = new Date().toISOString();
const daysFromNowIso = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
};

const POSTINGS = [
  {
    firmReg:  "108452C",
    title:    "Articleship — GST & Direct Tax practice",
    seats:    3,
    exp:      "First-year / IPCC cleared",
    location: "Wardhaman Nagar, Nagpur",
    description:
`Join a growing four-partner firm handling ~180 GST clients and 400+ ITR filings each year. Articleship rotation covers:

• GST monthly compliance (GSTR-1, 3B, 9), ITC reconciliation, and departmental replies
• Direct Tax return preparation for individuals, firms, and companies
• Tax audit under Section 44AB — Form 3CD preparation and finalisation
• Client interaction from the 3rd month onward — supervised meetings and email drafting

Working hours 10:30 AM – 7:30 PM (Mon–Sat), one Saturday off per month. Study leave granted as per ICAI norms. Stipend as per ICAI guidelines.`,
    expires:  daysFromNowIso(30),
  },
  {
    firmReg:  "119203C",
    title:    "Articleship — Statutory & Internal Audit",
    seats:    4,
    exp:      "First-year",
    location: "Kingsway, Nagpur (with client-site travel)",
    description:
`Seven-partner firm with a strong audit practice — 40+ statutory audits including two listed NBFCs, three co-operative banks, and mid-market manufacturers. Articleship rotation covers:

• Statutory audits under Companies Act (planning, vouching, verification, finalisation)
• Internal audit engagements — process walkthrough, RCM preparation, gap reporting
• CARO 2020 reporting and IFC testing
• Two months exposure to bank branch audits (statutory + concurrent)
• IND AS transition assignments for a listed client

Field exposure across Nagpur, Amravati, and Bhandara. Rotation between industries. Structured mid-year and end-year review with the mentoring partner.`,
    expires:  daysFromNowIso(45),
  },
  {
    firmReg:  "132876N",
    title:    "Articleship — Corporate Advisory & Transfer Pricing",
    seats:    2,
    exp:      "IPCC / Intermediate cleared",
    location: "Ramdaspeth, Nagpur",
    description:
`Twelve-partner boutique firm serving family businesses across Central India with corporate advisory, M&A, and transfer pricing work. Articleship exposure:

• Transfer Pricing documentation — master file, local file, CbCR analysis
• Due diligence for buy-side and sell-side transactions
• Corporate restructuring — schemes under Section 230-232 of Companies Act
• International taxation — DTAA analysis, Section 195 compliance, NR taxation
• Client-facing pitch preparation and presentation to promoters

Prior CA Intermediate rank / merit is preferred but not required. Higher stipend for candidates with equity-modelling or advanced-Excel skills. Study leave beyond ICAI minimum available for meritorious performance.`,
    expires:  daysFromNowIso(45),
  },
  {
    firmReg:  "127654W",
    title:    "Articleship — Small & Medium Practice (GST + Bank Audit)",
    seats:    2,
    exp:      "First-year",
    location: "Sitabuldi, Nagpur",
    description:
`Three-partner firm focused on the small-and-medium client segment (proprietors, professionals, small companies). Well suited to students who want end-to-end ownership of files rather than narrow specialisation. Articleship rotation:

• GST — full compliance cycle for 60+ clients, including annual return finalisation
• Bank branch statutory audits during March-April window (~15 branches allocated across articles)
• Income Tax return preparation and small proprietary audit assignments
• Bookkeeping oversight for retainer clients — trial balance to finalised BS

Emphasis on ownership: by the 15th month you will independently handle 5-6 client files under partner review. Two-day work-from-home per month subject to workload.`,
    expires:  daysFromNowIso(30),
  },
  {
    firmReg:  "141298C",
    title:    "Articleship — Indirect Tax & Litigation Support",
    seats:    3,
    exp:      "First-year / IPCC cleared",
    location: "IT Park, Parsodi (Nagpur)",
    description:
`Nine-partner firm with a dedicated indirect-tax litigation team representing clients before GST authorities, CESTAT, and High Court. Articleship exposure:

• Preparing replies to GST show-cause notices, ASMT-10 reconciliations, and demand orders
• Assisting counsel with appeal drafting and case-law research (VAT / Service Tax legacy + GST)
• Attending departmental hearings alongside partners
• Compliance work — GSTR-1/3B/9, ITC reconciliation, e-way bill audits — for the first 6 months
• Client sectors — infrastructure, real estate, logistics, and pharma

Strong preference for candidates with a research bent. Access to firm's proprietary case-law database. Structured monthly reading assignments and quarterly presentations to the litigation team.`,
    expires:  daysFromNowIso(45),
  },
];

try {
  // ── 1. Resolve poster user — need an existing user (admin preferred) ──
  const [poster] = await sql`
    SELECT id FROM users
    WHERE deleted_at IS NULL AND primary_role IN ('admin', 'chairman', 'staff')
    ORDER BY created_at ASC
    LIMIT 1
  `;
  if (!poster) {
    console.error("✗ No admin/chairman/staff user found. Create a branch admin first, then re-run.");
    process.exit(1);
  }
  console.log(`Using poster user: ${poster.id}`);

  // ── 2. Upsert firms ────────────────────────────────────────────────────
  const firmIdByReg = new Map();
  let firmsInserted = 0, firmsUpdated = 0;
  for (const f of FIRMS) {
    const [existing] = await sql`SELECT id FROM firms WHERE registration_no = ${f.registration_no} LIMIT 1`;
    if (existing) {
      await sql`
        UPDATE firms SET
          name               = ${f.name},
          email              = ${f.email},
          phone              = ${f.phone},
          website            = ${f.website},
          address            = ${f.address},
          city               = ${f.city},
          pincode            = ${f.pincode},
          partners_count     = ${f.partners_count},
          areas_of_expertise = ${f.areas},
          verified           = true,
          updated_at         = now()
        WHERE id = ${existing.id}
      `;
      firmIdByReg.set(f.registration_no, existing.id);
      firmsUpdated++;
    } else {
      const [row] = await sql`
        INSERT INTO firms (
          name, registration_no, email, phone, website,
          address, city, pincode, partners_count, areas_of_expertise, verified
        ) VALUES (
          ${f.name}, ${f.registration_no}, ${f.email}, ${f.phone}, ${f.website},
          ${f.address}, ${f.city}, ${f.pincode}, ${f.partners_count}, ${f.areas}, true
        )
        RETURNING id
      `;
      firmIdByReg.set(f.registration_no, row.id);
      firmsInserted++;
    }
    console.log(`  ${existing ? "=" : "+"} ${f.name} (${f.registration_no})`);
  }

  // ── 3. Upsert articleship postings ─────────────────────────────────────
  let postingsInserted = 0, postingsUpdated = 0;
  for (const p of POSTINGS) {
    const firmId = firmIdByReg.get(p.firmReg);
    if (!firmId) { console.warn(`  ⚠ skipping "${p.title}" — firm ${p.firmReg} not found`); continue; }

    const [existing] = await sql`
      SELECT id FROM job_postings
      WHERE firm_id = ${firmId} AND title = ${p.title} AND deleted_at IS NULL
      LIMIT 1
    `;

    if (existing) {
      if (!REFRESH) {
        console.log(`  = ${p.title} (${p.firmReg}) — already exists, pass --refresh to update`);
        continue;
      }
      await sql`
        UPDATE job_postings SET
          description         = ${p.description},
          seat_count          = ${p.seats},
          experience_required = ${p.exp},
          location            = ${p.location},
          expires_at          = ${p.expires},
          status              = 'active',
          updated_at          = now()
        WHERE id = ${existing.id}
      `;
      postingsUpdated++;
      console.log(`  ↺ refreshed: ${p.title} — ${FIRMS.find(f => f.registration_no === p.firmReg).name}`);
    } else {
      await sql`
        INSERT INTO job_postings (
          type, title, description, poster_user_id, firm_id,
          seat_count, experience_required, location, status, expires_at
        ) VALUES (
          'articleship', ${p.title}, ${p.description}, ${poster.id}, ${firmId},
          ${p.seats}, ${p.exp}, ${p.location}, 'active', ${p.expires}
        )
      `;
      postingsInserted++;
      console.log(`  + ${p.title} — ${FIRMS.find(f => f.registration_no === p.firmReg).name}`);
    }
  }

  console.log("\n───────────────────────────────────────────────");
  console.log(`✓ Firms       — ${firmsInserted} created, ${firmsUpdated} updated`);
  console.log(`✓ Postings    — ${postingsInserted} created, ${postingsUpdated} refreshed`);
  console.log("───────────────────────────────────────────────\n");
} catch (err) {
  console.error("✗ Failed:", err.message);
  if (err.detail) console.error("  detail:", err.detail);
  process.exitCode = 1;
} finally {
  await sql.end();
}
