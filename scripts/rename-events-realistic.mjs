// One-shot script to rename existing events in the DB with realistic
// CA/ICAI event titles. Pulls the current events list, matches each to
// its committee (via committee.code), and rewrites the title + slug from
// a curated pool of real-life branch-programme names.
//
// - Only touches events whose current title looks generic (contains "mock-",
//   "demo-", "Event #", "Placeholder", or matches the seed-mock-data
//   template output like "GST-...-Workshop" with the FY placeholder).
//   Pass --all to force-rename every event regardless.
// - New slugs get a short random suffix so the UNIQUE constraint holds
//   even if two events end up with the same base name.
// - Prints a dry-run summary. Pass --apply to actually persist.
//
// Usage:
//   node scripts/rename-events-realistic.mjs              # dry-run, only generic titles
//   node scripts/rename-events-realistic.mjs --all        # dry-run over every event
//   node scripts/rename-events-realistic.mjs --apply      # persist changes
//   node scripts/rename-events-realistic.mjs --all --apply

import "dotenv/config";
import postgres from "postgres";
import { randomBytes } from "node:crypto";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const APPLY = args.has("--apply");
const RENAME_ALL = args.has("--all");

// Curated titles per committee. Every entry is a real programme kind the
// Nagpur branch (or any ICAI branch) actually runs — not marketing fluff.
// Add / edit freely; the script picks per committee in order and cycles
// if you have more events than titles.
const TITLES_BY_COMMITTEE = {
  GST: [
    "GST Annual Return (GSTR-9 & 9C) — Practical Workshop",
    "GST Input Tax Credit — Recent Judicial Developments",
    "E-Invoicing, E-Way Bill & QR Code Compliance",
    "GST Litigation & Advance Ruling Case Studies",
    "Reverse Charge Mechanism — Sector-wise Analysis",
    "GST Refunds & Zero-Rated Supplies — Procedural Guidance",
    "Composition Scheme & Small Taxpayer Compliance",
    "GST Audit Under Section 65 — Preparation & Defence",
  ],
  DIRECT_TAX: [
    "Income Tax Return — AY 2026-27 Walkthrough",
    "Faceless Assessment & Appeals — Practitioner Guide",
    "TDS/TCS Compliance — Latest Amendments",
    "Capital Gains Taxation — Section 54/54F Case Studies",
    "Transfer Pricing Documentation for Domestic Transactions",
    "Section 43B(h) — MSME Payment Deductibility",
    "Reassessment Under Section 148 — Recent Case Law",
    "Presumptive Taxation (44AD / 44ADA / 44AE) — Best Practices",
  ],
  AUDIT: [
    "SA 700 Series — Reporting on Financial Statements",
    "Forensic Audit — Uncovering Financial Irregularities",
    "Bank Concurrent Audit — Documentation & Reporting",
    "Internal Audit — Risk-Based Approach Workshop",
    "Tax Audit Under Section 44AB — Form 3CD Walkthrough",
    "Statutory Audit of Charitable Trusts & Section 12A Entities",
    "IFC Reporting — Practical Application by SMPs",
    "Peer Review — Understanding the New Framework",
  ],
  IT: [
    "AI Tools for CA Practice — Audit, Tax & Advisory",
    "Excel Power Query & Pivot for Practitioners",
    "Cybersecurity Fundamentals for CA Firms",
    "Cloud Accounting — Zoho, Tally Prime & QuickBooks",
    "Automation with Python — CA Use Cases",
    "MCA V3 Portal — Navigating the New Filings",
    "Digital Signature & DSC Management for Firms",
    "Data Analytics for Audit Sampling",
  ],
  DIRECT_TAX_INTL: [
    "International Taxation — DTAA & Treaty Interpretation",
    "BEPS 2.0 & Pillar Two — Practical Implications",
    "Transfer Pricing — Master File & CbCR Reporting",
    "Non-Resident Taxation & Section 195 Compliance",
    "FEMA Compliance for Cross-Border Transactions",
  ],
  CPE: [
    "Annual Regional Conference",
    "National Webinar Series — Emerging Professional Standards",
    "Chairman's Address & Members' Meet",
    "Refresher Course — Practice Management",
    "Foundation Day Programme",
  ],
  WICASA: [
    "Mock Test Series — CA Foundation",
    "Mock Test Series — CA Intermediate",
    "Mock Test Series — CA Final",
    "Articleship Orientation & Industry Interaction",
    "Career Counselling — Post-Qualification Options",
    "Study Circle — Costing & Financial Management",
    "Study Circle — Taxation for CA Inter",
    "Student Convention — Nagpur Chapter",
  ],
  MEMBERSHIP: [
    "New Members' Induction & Certificate Distribution",
    "Members' Networking Meet",
    "Family Sports Day",
    "Annual Members' Meet",
  ],
  ACCOUNTING: [
    "Ind AS 115 — Revenue Recognition Deep Dive",
    "Ind AS 116 — Leases: Lessee & Lessor Accounting",
    "Ind AS 109 — ECL Model for NBFC & Corporates",
    "Consolidation & Investment in Associates — Practical Issues",
    "Companies Act Financial Reporting — Schedule III Amendments",
  ],
  CORPORATE_LAW: [
    "Companies Act 2013 — Annual Compliance Roadmap",
    "MCA e-Forms — DIR-3 KYC, DPT-3, MSME-1 Deadlines",
    "SEBI LODR — Recent Amendments for Listed Entities",
    "Insolvency & Bankruptcy Code — Recent Case Law",
  ],
};

// Fallback pool used when a committee has no match in TITLES_BY_COMMITTEE.
const FALLBACK_TITLES = [
  "Professional Update — Recent Regulatory Changes",
  "Practice Management Workshop for Small & Medium Practitioners",
  "Ethics & Professional Standards — Case Study Discussion",
  "Networking Meet — Members in Industry & Practice",
  "Half-Day Refresher Session",
];

// Heuristic: does this title look auto-generated / placeholder?
function looksGeneric(title, slug) {
  if (!title) return true;
  const s = slug ?? "";
  if (s.startsWith("mock-") || s.startsWith("demo-")) return true;
  if (/\bEvent\s*#?\d+/i.test(title)) return true;
  if (/\bPlaceholder\b/i.test(title)) return true;
  if (/^\s*(untitled|test|sample)\b/i.test(title)) return true;
  // seed-mock-data uses the FY placeholder in titles like "{fy}"
  if (title.includes("{fy}")) return true;
  return false;
}

function slugify(s) {
  return s.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 70);
}

const sql = postgres(url, { max: 1, prepare: false });

try {
  const rows = await sql`
    SELECT e.id, e.slug, e.title, e.starts_at, c.code AS committee_code, c.name AS committee_name
    FROM events e
    LEFT JOIN committees c ON c.id = e.committee_id
    WHERE e.deleted_at IS NULL
    ORDER BY e.starts_at
  `;

  console.log(`Loaded ${rows.length} event(s) from DB.`);
  if (rows.length === 0) { console.log("Nothing to rename."); process.exit(0); }

  // Track per-committee cursor so we cycle through titles evenly.
  const cursor = new Map();
  const updates = [];

  for (const r of rows) {
    const isGeneric = looksGeneric(r.title, r.slug);
    if (!RENAME_ALL && !isGeneric) continue;

    const pool = (r.committee_code && TITLES_BY_COMMITTEE[r.committee_code]) || FALLBACK_TITLES;
    const idx = cursor.get(r.committee_code ?? "_") ?? 0;
    const baseTitle = pool[idx % pool.length];
    cursor.set(r.committee_code ?? "_", idx + 1);

    // Add the event's FY suffix so repeat titles (e.g. "Annual Regional
    // Conference") stay distinguishable in the events list.
    const startsAt = new Date(r.starts_at);
    const fyStartYear = startsAt.getMonth() >= 3 ? startsAt.getFullYear() : startsAt.getFullYear() - 1;
    const fyLabel = `${fyStartYear}-${String((fyStartYear + 1) % 100).padStart(2, "0")}`;
    const newTitle = baseTitle.includes("AY ") || baseTitle.includes("FY ")
      ? baseTitle                    // already carries its own year
      : `${baseTitle} — FY ${fyLabel}`;

    // Slug: slugify the base title + short random suffix to guarantee
    // uniqueness even if two events land on the same title.
    const suffix = randomBytes(3).toString("hex");
    const newSlug = `${slugify(baseTitle)}-${suffix}`;

    updates.push({ id: r.id, oldTitle: r.title, newTitle, oldSlug: r.slug, newSlug });
  }

  if (updates.length === 0) {
    console.log("No events matched the rename criteria (pass --all to rename every event).");
    process.exit(0);
  }

  console.log(`\nPlanned ${updates.length} rename(s):\n`);
  for (const u of updates) {
    console.log(`  • ${u.oldTitle}`);
    console.log(`    → ${u.newTitle}`);
    console.log(`      slug: ${u.oldSlug} → ${u.newSlug}\n`);
  }

  if (!APPLY) {
    console.log("(dry-run — pass --apply to persist)");
    process.exit(0);
  }

  console.log("Applying updates…");
  await sql.begin(async (tx) => {
    for (const u of updates) {
      await tx`
        UPDATE events
           SET title = ${u.newTitle},
               slug  = ${u.newSlug},
               updated_at = now()
         WHERE id = ${u.id}
      `;
    }
  });
  console.log(`✓ Renamed ${updates.length} event(s).`);
} catch (err) {
  console.error("✗ Failed:", err.message);
  if (err.detail) console.error("  detail:", err.detail);
  process.exitCode = 1;
} finally {
  await sql.end();
}
