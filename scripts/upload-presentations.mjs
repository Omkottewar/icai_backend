// One-shot: upload every PDF under ../presentation/upload to Supabase Storage
// and create a hidden paper_presentations row for each. Mirrors the admin UI's
// "Bulk upload PDFs" button (icai-frontend/src/pages/admin/PaperPresentationsAdminPage.jsx)
// but runs server-side so you don't need an admin browser session.
//
// Run:  npx tsx scripts/upload-presentations.mjs
//
// Idempotent — skips files whose exact title already exists in paper_presentations.
import "dotenv/config";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { storage } from "../server/lib/storage.ts";
import { db } from "../db/client.ts";
import { files, paperPresentations } from "../schema/index.ts";
import { eq } from "drizzle-orm";

const SOURCE_DIR = resolve(process.cwd(), "..", "presentation", "upload");
const BUCKET = "paper_presentations";
const SPEAKER_DEFAULT = "ICAI Nagpur Branch";
const MAX_PDF_BYTES = 6 * 1024 * 1024; // matches admin files.ts cap

function slugify(s) {
  return s.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "paper";
}

async function uniqueSlug(base) {
  for (let i = 1; i <= 60; i++) {
    const candidate = i === 1 ? base : `${base}-${i}`;
    const [exists] = await db.select({ id: paperPresentations.id })
      .from(paperPresentations)
      .where(eq(paperPresentations.slug, candidate))
      .limit(1);
    if (!exists) return candidate;
  }
  throw new Error("Could not generate a unique slug");
}

const driver = storage();
const entries = await readdir(SOURCE_DIR);
const pdfs = entries.filter((n) => /\.pdf$/i.test(n)).sort();

if (!pdfs.length) {
  console.log(`No PDFs found in ${SOURCE_DIR}`);
  process.exit(0);
}

console.log(`Found ${pdfs.length} PDFs in ${SOURCE_DIR}`);
console.log(`Target: Supabase bucket "${process.env.SUPABASE_BUCKET}" / folder "${BUCKET}"`);
console.log("");

const results = { uploaded: [], skipped: [], failed: [] };

for (const [idx, name] of pdfs.entries()) {
  const label = `[${idx + 1}/${pdfs.length}] ${name}`;
  try {
    const title = name.replace(/\.pdf$/i, "").trim();

    // Idempotency: if a row with this exact title already exists, skip.
    const [existing] = await db.select({ id: paperPresentations.id, slug: paperPresentations.slug })
      .from(paperPresentations)
      .where(eq(paperPresentations.title, title))
      .limit(1);
    if (existing) {
      console.log(`${label}  SKIP (already exists, id=${existing.id})`);
      results.skipped.push(name);
      continue;
    }

    const path = join(SOURCE_DIR, name);
    const st = await stat(path);
    if (st.size > MAX_PDF_BYTES) {
      throw new Error(`exceeds 6 MB limit (${(st.size / 1024 / 1024).toFixed(1)} MB)`);
    }
    const bytes = await readFile(path);

    // Upload to Supabase Storage at paper_presentations/<uuid>.pdf
    const filename = `${randomUUID()}.pdf`;
    const storagePath = await driver.put(BUCKET, filename, bytes, "application/pdf");

    // Insert files row (uploaded_by left NULL — no human user for this script).
    const [fileRow] = await db.insert(files).values({
      name,
      mime_type:    "application/pdf",
      size_bytes:   bytes.length,
      storage_path: storagePath,
      bucket:       BUCKET,
    }).returning();

    // Insert paper_presentations row — hidden, so nothing goes public until
    // an admin reviews the title/speaker/committee and un-hides it.
    const slug = await uniqueSlug(slugify(title));
    const [paperRow] = await db.insert(paperPresentations).values({
      slug,
      title,
      speaker_name: SPEAKER_DEFAULT,
      pdf_file_id:  fileRow.id,
      hidden:       true,
    }).returning({ id: paperPresentations.id, slug: paperPresentations.slug });

    console.log(`${label}  OK (paper=${paperRow.id}, slug=${paperRow.slug})`);
    results.uploaded.push({ name, id: paperRow.id, slug: paperRow.slug });
  } catch (err) {
    console.log(`${label}  FAIL — ${err?.message || err}`);
    results.failed.push({ name, error: err?.message || String(err) });
  }
}

console.log("");
console.log(`Done. uploaded=${results.uploaded.length}  skipped=${results.skipped.length}  failed=${results.failed.length}`);
if (results.failed.length) {
  console.log("");
  console.log("Failures:");
  for (const f of results.failed) console.log(`  - ${f.name}: ${f.error}`);
}

process.exit(results.failed.length ? 1 : 0);
