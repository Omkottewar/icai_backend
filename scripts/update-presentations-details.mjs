// One-shot: fill in human metadata (title, speaker, committee, date) for the
// paper_presentations rows created by upload-presentations.mjs, and unhide them
// so they go live on the public Resources page.
//
// Keyed by the ORIGINAL filename-derived title (what upload-presentations.mjs
// used as the initial title). Updates are safe to re-run — anything already at
// the target state stays put.
//
// Run:  npx tsx scripts/update-presentations-details.mjs
import "dotenv/config";
import { db } from "../db/client.ts";
import { paperPresentations } from "../schema/index.ts";
import { eq, and, ne } from "drizzle-orm";

// originalTitle (filename minus ".pdf", trimmed) → final metadata
const UPDATES = [
  { from: "24.07.2026",
    title: "ICAI Nagpur Branch Presentation – 24 July 2026",
    speaker_name: "ICAI Nagpur Branch", committee_tag: "Branch", presented_on: "2026-07-24" },

  { from: "AQMM v 2.0  ICAI Nagpur Branch October 2026",
    title: "Audit Quality Maturity Model (AQMM) v 2.0",
    speaker_name: "ICAI Nagpur Branch", committee_tag: "Audit", presented_on: "2026-10-01" },

  { from: "Analysis of Bank st for auditing",
    title: "Analysis of Bank Statements for Auditing",
    speaker_name: "ICAI Nagpur Branch", committee_tag: "Audit" },

  { from: "Approach to Forensic Audit_with case study",
    title: "Approach to Forensic Audit (with Case Study)",
    speaker_name: "ICAI Nagpur Branch", committee_tag: "Audit" },

  { from: "CA Kuntal Shah_CBS_LFAR-Linked",
    title: "CBS & LFAR – Linked Aspects",
    speaker_name: "CA Kuntal Shah", committee_tag: "Audit" },

  { from: "Code of Ethics PPT 15.11.2025 Nagpur Branch of WIRC , ICAI",
    title: "Code of Ethics",
    speaker_name: "ICAI Nagpur Branch (WIRC)", committee_tag: "CPE", presented_on: "2025-11-15" },

  { from: "Compliance with Ethical Standards 25-03-2026 KS (1)",
    title: "Compliance with Ethical Standards",
    speaker_name: "CA Kuntal Shah", committee_tag: "CPE", presented_on: "2026-03-25" },

  { from: "Fintech-The-Indian-Revolution",
    title: "Fintech – The Indian Revolution",
    speaker_name: "ICAI Nagpur Branch", committee_tag: "IT" },

  { from: "Fund Raising for Real Estate_ICAI_Nov25- CA Vinit Deo",
    title: "Fund Raising for Real Estate",
    speaker_name: "CA Vinit Deo", committee_tag: "Direct Tax", presented_on: "2025-11-01" },

  { from: "IFC_Nagpur Seminar presentation",
    title: "Internal Financial Controls (IFC) – Nagpur Seminar",
    speaker_name: "ICAI Nagpur Branch", committee_tag: "Audit" },

  { from: "LFAR _Bank Branch audit _Nagpur (1)",
    title: "LFAR – Bank Branch Audit",
    speaker_name: "ICAI Nagpur Branch", committee_tag: "Audit" },

  { from: "Making March Meaningful (1)",
    title: "Making March Meaningful",
    speaker_name: "ICAI Nagpur Branch", committee_tag: "Audit" },

  { from: "NAGPUR FINAL TAX AUDIT (3) (1)",
    title: "Tax Audit – Nagpur (Final)",
    speaker_name: "ICAI Nagpur Branch", committee_tag: "Audit" },

  { from: "Nagpur Study Circle_Taxation of Charitable Trusts, NGOs & Instituions with recent amendments_27.12.2025",
    title: "Taxation of Charitable Trusts, NGOs & Institutions – Recent Amendments",
    speaker_name: "ICAI Nagpur Study Circle", committee_tag: "Direct Tax", presented_on: "2025-12-27" },

  { from: "PPT- A. Kelkar- 2025",
    title: "Presentation by CA A. Kelkar (2025)",
    speaker_name: "CA A. Kelkar", presented_on: "2025-01-01" },

  { from: "Peer Review -Compliance with Audit Documentation - KS (1)",
    title: "Peer Review – Compliance with Audit Documentation",
    speaker_name: "CA Kuntal Shah", committee_tag: "Audit" },

  { from: "Rationale_and_Significance_of_Peer_Review",
    title: "Rationale and Significance of Peer Review",
    speaker_name: "ICAI Nagpur Branch", committee_tag: "Audit" },

  { from: "Search & Seizure Presentation Firm- CA Vishnukumar Agrawal",
    title: "Search & Seizure",
    speaker_name: "CA Vishnukumar Agrawal", committee_tag: "Direct Tax" },

  { from: "Tax_Audit_PPT_FINAL (1) (1)",
    title: "Tax Audit – Final Presentation",
    speaker_name: "ICAI Nagpur Branch", committee_tag: "Audit" },

  { from: "Taxation of Charitable Trusts ICAI Nagpur 16.10.2026- Gautam Nayak",
    title: "Taxation of Charitable Trusts – ICAI Nagpur",
    speaker_name: "CA Gautam Nayak", committee_tag: "Direct Tax", presented_on: "2026-10-16" },

  { from: "Tools and Utilities for Audit",
    title: "Tools and Utilities for Audit",
    speaker_name: "ICAI Nagpur Branch", committee_tag: "Audit" },

  { from: "VASAI final Peer Review Procedure with reportings with AQMM",
    title: "Peer Review Procedure with Reporting (with AQMM)",
    speaker_name: "VASAI Branch", committee_tag: "Audit" },

  { from: "Womens day presentation",
    title: "Women's Day Presentation",
    speaker_name: "ICAI Nagpur Branch", committee_tag: "WICASA" },

  { from: "final GSTAT  pprt (1)",
    title: "GSTAT – Goods & Services Tax Appellate Tribunal",
    speaker_name: "ICAI Nagpur Branch", committee_tag: "GST" },
];

function slugify(s) {
  return s.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "paper";
}

async function uniqueSlug(base, exceptId) {
  for (let i = 1; i <= 60; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const [exists] = await db.select({ id: paperPresentations.id })
      .from(paperPresentations)
      .where(and(eq(paperPresentations.slug, candidate), ne(paperPresentations.id, exceptId)))
      .limit(1);
    if (!exists) return candidate;
  }
  throw new Error("Could not generate a unique slug");
}

const results = { updated: [], notFound: [], failed: [] };

for (const [idx, u] of UPDATES.entries()) {
  const label = `[${idx + 1}/${UPDATES.length}] "${u.from}"`;
  try {
    const [row] = await db.select({ id: paperPresentations.id })
      .from(paperPresentations)
      .where(eq(paperPresentations.title, u.from))
      .limit(1);
    if (!row) {
      console.log(`${label}  NOT FOUND`);
      results.notFound.push(u.from);
      continue;
    }
    const newSlug = await uniqueSlug(slugify(u.title), row.id);
    const [updated] = await db.update(paperPresentations)
      .set({
        title:         u.title,
        speaker_name:  u.speaker_name,
        committee_tag: u.committee_tag ?? null,
        presented_on:  u.presented_on ?? null,
        slug:          newSlug,
        hidden:        false,
        updated_at:    new Date(),
      })
      .where(eq(paperPresentations.id, row.id))
      .returning({ id: paperPresentations.id, slug: paperPresentations.slug });

    console.log(`${label}  OK (id=${updated.id}, slug=${updated.slug})`);
    results.updated.push({ title: u.title, id: updated.id, slug: updated.slug });
  } catch (err) {
    console.log(`${label}  FAIL — ${err?.message || err}`);
    results.failed.push({ from: u.from, error: err?.message || String(err) });
  }
}

console.log("");
console.log(`Done. updated=${results.updated.length}  notFound=${results.notFound.length}  failed=${results.failed.length}`);
if (results.notFound.length) {
  console.log("Not found (DB title didn't match from-key):");
  for (const t of results.notFound) console.log(`  - ${t}`);
}
if (results.failed.length) {
  console.log("Failures:");
  for (const f of results.failed) console.log(`  - ${f.from}: ${f.error}`);
}

process.exit(results.failed.length || results.notFound.length ? 1 : 0);
