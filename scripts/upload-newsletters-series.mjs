// One-shot: upload the PDFs in ../newsletters-upload (Branch + WICASA issues)
// with their cover pictures from ../newsletters-upload/covers/<same name>.jpg.
//
// File names carry the issue:  <...>-YYYY-MM-<Mon>[-partN].pdf
//   "wicasa" anywhere in the name → WICASA series, otherwise Branch.
//
// If an entry already exists for the same series / year / month / part
// (e.g. the hidden ones whose old files were lost), it gets the new PDF and
// cover and is made visible. Otherwise a new entry is created.
//
// Run from the backend folder:   npx tsx scripts/upload-newsletters-series.mjs
// Add --dry-run to only print what would happen.
import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { storage } from "../server/lib/storage.ts";
import { ensureNewsletterSeries } from "../server/lib/newsletterSeries.ts";
import { db } from "../db/client.ts";
import { files, branchNewsletters } from "../schema/index.ts";

const DRY = process.argv.includes("--dry-run");
const SOURCE_DIR = resolve(process.cwd(), "..", "newsletters-upload");
const COVER_DIR = join(SOURCE_DIR, "covers");
const BUCKET = "newsletters";
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function parse(name) {
  const m = name.match(/(20\d{2})[-_ .](0[1-9]|1[0-2])/);
  if (!m) return null;
  const series = /wicasa/i.test(name) ? "wicasa" : "branch";
  const part = Number((name.match(/part[-_ ]?(\d{1,2})/i) || [])[1] || 0);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const base = `${MONTHS[month - 1]} ${year}`;
  const title = series === "wicasa"
    ? `WICASA ${/udaan/i.test(name) ? "Udaan " : ""}— ${base}${part ? `, Part ${part}` : ""}`
    : `${base} Newsletter`;
  return { series, year, month, part, title };
}

async function putFile(path, name, mime) {
  const bytes = await readFile(path);
  const ext = mime === "application/pdf" ? "pdf" : "jpg";
  const storagePath = await storage().put(BUCKET, `${randomUUID()}.${ext}`, bytes, mime);
  const [row] = await db.insert(files).values({
    name, mime_type: mime, size_bytes: bytes.length, storage_path: storagePath, bucket: BUCKET,
  }).returning();
  return row.id;
}

await ensureNewsletterSeries();

const pdfs = (await readdir(SOURCE_DIR)).filter((n) => /\.pdf$/i.test(n)).sort();
console.log(`${pdfs.length} PDFs in ${SOURCE_DIR}${DRY ? "  (dry run)" : ""}\n`);

let added = 0, updated = 0, failed = 0;
for (const name of pdfs) {
  const p = parse(name);
  if (!p) { console.log(`SKIP  ${name}  (no YYYY-MM in name)`); continue; }
  const label = `${p.series.padEnd(6)} ${p.year}-${String(p.month).padStart(2, "0")}${p.part ? ` part ${p.part}` : ""}  ${name}`;
  try {
    const [existing] = await db.select({ id: branchNewsletters.id })
      .from(branchNewsletters)
      .where(and(
        eq(branchNewsletters.series, p.series),
        eq(branchNewsletters.issue_year, p.year),
        eq(branchNewsletters.issue_month, p.month),
        eq(branchNewsletters.part, p.part),
      ))
      .limit(1);

    if (DRY) { console.log(`${existing ? "UPDATE" : "ADD   "} ${label}  → "${p.title}"`); continue; }

    const pdf_file_id = await putFile(join(SOURCE_DIR, name), name, "application/pdf");
    const coverPath = join(COVER_DIR, name.replace(/\.pdf$/i, ".jpg"));
    const cover_file_id = existsSync(coverPath)
      ? await putFile(coverPath, name.replace(/\.pdf$/i, "-cover.jpg"), "image/jpeg")
      : null;

    const values = {
      title: p.title, series: p.series, part: p.part,
      issue_year: p.year, issue_month: p.month,
      pdf_file_id, cover_file_id, hidden: false,
      published_at: new Date(Date.UTC(p.year, p.month - 1, 1)),
      updated_at: new Date(),
    };
    if (existing) {
      await db.update(branchNewsletters).set(values).where(eq(branchNewsletters.id, existing.id));
      updated += 1;
      console.log(`UPDATED ${label}`);
    } else {
      await db.insert(branchNewsletters).values(values);
      added += 1;
      console.log(`ADDED   ${label}`);
    }
  } catch (err) {
    failed += 1;
    console.log(`FAILED  ${label}  — ${err?.message || err}`);
  }
}

console.log(`\nDone. added=${added} updated=${updated} failed=${failed}`);
process.exit(failed ? 1 : 0);
