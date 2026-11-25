// One-shot: upload every PDF under ../newsletters to Supabase Storage and
// create a branch_newsletters row for each, live (hidden=false). Parses the
// issue month + year from each filename; skips files where either can't be
// identified. The branch_newsletters table has a UNIQUE(issue_year, issue_month)
// constraint, so when two files cover the same month, the larger file wins
// (assumed to be the un-compressed original).
//
// Run:  npx tsx scripts/upload-newsletters.mjs
//
// Idempotent — rows that already exist in the DB for a given (year, month)
// are skipped.
import "dotenv/config";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { storage } from "../server/lib/storage.ts";
import { db } from "../db/client.ts";
import { files, branchNewsletters } from "../schema/index.ts";
import { and, eq } from "drizzle-orm";

const SOURCE_DIR = resolve(process.cwd(), "..", "newsletters");
const BUCKET = "newsletters";

const MONTHS = [
  ["january", "jan"],
  ["february", "feb"],
  ["march", "mar", "marth"],                 // "Marth_2013_Bulletin.pdf" typo
  ["april", "apr"],
  ["may"],
  ["june", "jun"],
  ["july", "jul"],
  ["august", "aug"],
  ["september", "sept", "sep"],
  ["october", "oct"],
  ["november", "nov"],
  ["december", "dec"],
];

function parseFilename(name) {
  // Return { month: 1-12, year: YYYY, kind: 'Newsletter' | 'Bulletin' } or null.
  const stem = name.replace(/\.pdf$/i, "").toLowerCase();
  const kind = /bulletin/.test(stem) ? "Bulletin" : "Newsletter";

  // Year — first 4-digit number in 1950..2100 range. We bound with \D (any
  // non-digit) rather than \b, because \b treats underscore as a word char
  // — "newsletter_2018" and "August2022" both need to match, and \b wouldn't
  // trigger between letter/underscore and the leading digit.
  const yearMatch = stem.match(/(?:^|\D)(19[5-9]\d|20\d\d|21\d\d)(?:\D|$)/);
  if (!yearMatch) return null;
  const year = Number(yearMatch[1]);

  // Month — scan tokens for a known month name. When a filename spans two
  // months (e.g. "nov-dec-2014", "march-april-2012") take the FIRST hit
  // so the issue sorts by its earlier month in the index.
  let month = null;
  for (let i = 0; i < MONTHS.length; i++) {
    for (const alias of MONTHS[i]) {
      // word-boundary match — avoids "may" hitting "mayor" and the like
      const re = new RegExp(`(^|[^a-z])${alias}([^a-z]|$)`);
      if (re.test(stem)) {
        // Guard against the 'mar' alias matching the 'march-april' token twice
        if (month === null || i < month) month = i + 1;
      }
    }
  }
  if (month === null) return null;
  return { month, year, kind };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const driver = storage();
const entries = await readdir(SOURCE_DIR);
const allPdfs = entries.filter((n) => /\.pdf$/i.test(n)).sort();

// ─── Parse + group ────────────────────────────────────────────────────────
const unidentifiable = [];
const byKey = new Map();   // "YYYY-MM" → { name, size, month, year, kind }

for (const name of allPdfs) {
  const parsed = parseFilename(name);
  if (!parsed) { unidentifiable.push(name); continue; }
  const path = join(SOURCE_DIR, name);
  const size = (await stat(path)).size;
  const key = `${parsed.year}-${String(parsed.month).padStart(2, "0")}`;
  const prev = byKey.get(key);
  if (!prev || size > prev.size) {
    byKey.set(key, { name, size, ...parsed });
  }
}

const picks = [...byKey.values()].sort(
  (a, b) => (a.year - b.year) || (a.month - b.month),
);

console.log(`Found ${allPdfs.length} PDFs. ${picks.length} unique (year, month). ${unidentifiable.length} skipped (no year or month in filename).`);
if (unidentifiable.length) {
  console.log("Skipped (no identifiable date):");
  for (const n of unidentifiable) console.log(`  - ${n}`);
}
console.log("");

// ─── Upload + insert ──────────────────────────────────────────────────────
const results = { uploaded: [], skipped: [], failed: [] };

for (const [idx, p] of picks.entries()) {
  const label = `[${idx + 1}/${picks.length}] ${MONTH_NAMES[p.month - 1]} ${p.year}  (${p.name})`;
  try {
    // Already in DB for this (year, month)?
    const [existing] = await db.select({ id: branchNewsletters.id })
      .from(branchNewsletters)
      .where(and(
        eq(branchNewsletters.issue_year,  p.year),
        eq(branchNewsletters.issue_month, p.month),
      ))
      .limit(1);
    if (existing) {
      console.log(`${label}  SKIP (row exists, id=${existing.id})`);
      results.skipped.push(`${p.year}-${p.month}`);
      continue;
    }

    const bytes = await readFile(join(SOURCE_DIR, p.name));
    const filename = `${randomUUID()}.pdf`;
    const storagePath = await driver.put(BUCKET, filename, bytes, "application/pdf");

    const [fileRow] = await db.insert(files).values({
      name:         p.name,
      mime_type:    "application/pdf",
      size_bytes:   bytes.length,
      storage_path: storagePath,
      bucket:       BUCKET,
    }).returning();

    const title = `${MONTH_NAMES[p.month - 1]} ${p.year} ${p.kind}`;
    // published_at = first of the issue month. No better signal in the
    // filename; the admin can edit later to reflect the actual release date.
    const publishedAt = new Date(Date.UTC(p.year, p.month - 1, 1));

    const [row] = await db.insert(branchNewsletters).values({
      title,
      issue_month:  p.month,
      issue_year:   p.year,
      pdf_file_id:  fileRow.id,
      published_at: publishedAt,
      hidden:       false,
    }).returning({ id: branchNewsletters.id });

    console.log(`${label}  OK (id=${row.id})`);
    results.uploaded.push({ year: p.year, month: p.month, id: row.id, title });
  } catch (err) {
    console.log(`${label}  FAIL — ${err?.message || err}`);
    results.failed.push({ name: p.name, error: err?.message || String(err) });
  }
}

console.log("");
console.log(`Done. uploaded=${results.uploaded.length}  skipped=${results.skipped.length}  failed=${results.failed.length}`);
if (results.failed.length) {
  console.log("Failures:");
  for (const f of results.failed) console.log(`  - ${f.name}: ${f.error}`);
}

process.exit(results.failed.length ? 1 : 0);
