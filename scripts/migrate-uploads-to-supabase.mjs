// One-shot backfill: copy every file in ./uploads/ to the configured
// Supabase Storage bucket, preserving the same `<bucket>/<filename>` layout
// as folders inside the Supabase bucket.
//
// Idempotent — re-running skips files already present at the target. Safe
// to run multiple times during/after a partial run.
//
// What this does NOT do:
//   * Doesn't delete local files. Bytes stay on disk until you manually
//     remove them. This keeps the old /uploads route as a recovery path.
//   * Doesn't touch `files.storage_path` rows. The path inside the
//     Supabase bucket is identical to the path on disk, so existing rows
//     resolve correctly once the API restarts with SUPABASE_URL set.
//
// Usage:
//   1. Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET in .env
//   2. Create the bucket in Supabase Studio (public access if using public-content)
//   3. node scripts/migrate-uploads-to-supabase.mjs
//   4. Restart the API → it picks up the env vars and switches driver
//   5. Verify by uploading a new photo and checking the URL points at supabase.co
//   6. Once happy, remove ./uploads/ if you want
//
// Flags:
//   --dry-run     List what would be uploaded without writing
//   --verbose     Log every file (default: summary only)

import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const args = new Set(process.argv.slice(2));
const dryRun  = args.has("--dry-run");
const verbose = args.has("--verbose");

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET ?? "public-content";
const UPLOAD_DIR      = "uploads";

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.");
  process.exit(1);
}

const client = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
});

// Lightweight MIME-by-extension lookup. Covers everything the upload pipeline
// produces (webp, jpg, png, gif, pdf) plus a few legacy formats we might see
// in older `/uploads/` content.
const MIME_BY_EXT = {
  ".webp": "image/webp",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png":  "image/png",
  ".gif":  "image/gif",
  ".pdf":  "application/pdf",
};

function mimeFor(filename) {
  const ext = filename.match(/\.[a-zA-Z0-9]+$/)?.[0]?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === "ENOENT") return;       // no uploads dir at all
    throw e;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory())   yield* walk(abs);
    else if (e.isFile())   yield abs;
  }
}

async function existsInBucket(path) {
  // Supabase doesn't expose a cheap HEAD per path; list with a search filter
  // and exact-match. For one-time backfill this is fast enough.
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const name = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
  const { data, error } = await client.storage.from(SUPABASE_BUCKET).list(dir, {
    limit: 1,
    search: name,
  });
  if (error) return false;
  return Array.isArray(data) && data.some((f) => f.name === name);
}

async function uploadOne(absPath, storagePath) {
  const bytes = await readFile(absPath);
  const { error } = await client.storage.from(SUPABASE_BUCKET).upload(
    storagePath,
    bytes,
    {
      contentType: mimeFor(storagePath),
      upsert: false,                     // we already check existsInBucket
      cacheControl: "31536000",
    },
  );
  if (error) throw new Error(error.message);
  return bytes.length;
}

async function run() {
  const uploadsRoot = join(process.cwd(), UPLOAD_DIR);
  let scanned = 0;
  let uploaded = 0;
  let skipped = 0;
  let totalBytes = 0;
  let errors = 0;

  console.log(`Source: ${uploadsRoot}`);
  console.log(`Target: Supabase bucket "${SUPABASE_BUCKET}" at ${SUPABASE_URL}`);
  console.log(dryRun ? "Mode:   DRY-RUN (no writes)\n" : "Mode:   live\n");

  for await (const abs of walk(uploadsRoot)) {
    scanned++;
    // Build storage_path as the same `<bucket>/<file>` shape used on disk.
    // relative() preserves the layout under ./uploads/.
    const rel = relative(uploadsRoot, abs).split(sep).join("/");

    // Already present? Skip.
    let already = false;
    try { already = await existsInBucket(rel); } catch {}
    if (already) {
      skipped++;
      if (verbose) console.log(`  skip   ${rel}`);
      continue;
    }

    if (dryRun) {
      uploaded++;
      console.log(`  upload ${rel}  (dry-run)`);
      continue;
    }

    try {
      const size = await uploadOne(abs, rel);
      uploaded++;
      totalBytes += size;
      if (verbose) console.log(`  upload ${rel}  (${(size / 1024).toFixed(1)} KB)`);
      if (!verbose && uploaded % 25 === 0) console.log(`  …${uploaded} uploaded so far`);
    } catch (e) {
      errors++;
      console.error(`  fail   ${rel}: ${e.message}`);
    }
  }

  console.log("\n──────────────────────────────────────");
  console.log(`Scanned:  ${scanned}`);
  console.log(`Uploaded: ${uploaded}`);
  console.log(`Skipped:  ${skipped} (already in bucket)`);
  console.log(`Errors:   ${errors}`);
  if (totalBytes > 0) console.log(`Bytes:    ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log("──────────────────────────────────────");
  if (errors > 0) {
    console.log("\nSome uploads failed. Re-run to retry — script is idempotent.");
    process.exitCode = 1;
  } else {
    console.log("\nDone. Restart the API to pick up the Supabase driver.");
  }
}

await run();
