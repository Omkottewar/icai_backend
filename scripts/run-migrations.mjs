// Custom migration runner.
//
// Why not drizzle-kit migrate?
//   drizzle-kit only tracks migrations it generated itself (the 0000-0006
//   files in drizzle/meta/_journal.json). The hand-written SQL migrations
//   (0007+) live alongside but were applied manually via scripts/apply-sql.mjs.
//   This script unifies the workflow: every *.sql file in drizzle/ is tracked
//   in a single _migrations table, and `node scripts/run-migrations.mjs`
//   applies whatever's new — same behaviour for drizzle-generated and
//   hand-written files.
//
// Flags:
//   --bootstrap   Mark every existing migration file as applied without
//                 running it. Use ONCE on an existing DB to seed the
//                 _migrations table to current state, then forget about it.
//   --dry-run     Show what would happen without writing.
//   --status      Print which files are applied / pending and exit.
//
// On a fresh DB you do NOT need --bootstrap — every migration uses
// IF NOT EXISTS / DO EXCEPTION patterns so re-running is harmless.

import "dotenv/config";
import postgres from "postgres";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "drizzle");

const args = new Set(process.argv.slice(2));
const dryRun    = args.has("--dry-run");
const bootstrap = args.has("--bootstrap");
const statusOnly = args.has("--status");

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) must be set");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

function listMigrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") && f !== "verify.sql")
    .sort(); // 0000_… < 0001_… alphabetic = numeric for our naming
}

async function ensureTrackingTable() {
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS "_migrations" (
      filename text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function appliedSet() {
  const rows = await sql`SELECT filename FROM _migrations`;
  return new Set(rows.map((r) => r.filename));
}

async function run() {
  await ensureTrackingTable();
  const files = listMigrationFiles();
  const applied = await appliedSet();

  if (statusOnly) {
    console.log(`${"FILE".padEnd(50)} STATUS`);
    for (const f of files) {
      console.log(`${f.padEnd(50)} ${applied.has(f) ? "applied" : "pending"}`);
    }
    return;
  }

  if (bootstrap) {
    const toMark = files.filter((f) => !applied.has(f));
    console.log(`Bootstrap mode — marking ${toMark.length} file(s) as applied WITHOUT running them:`);
    for (const f of toMark) console.log("  •", f);
    if (!dryRun) {
      if (toMark.length > 0) {
        await sql`INSERT INTO _migrations ${sql(toMark.map((f) => ({ filename: f })))}`;
      }
      console.log("✓ Bootstrap complete.");
    } else {
      console.log("(dry-run — no changes written)");
    }
    return;
  }

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log("Nothing to apply — DB is up to date.");
    return;
  }

  console.log(`Applying ${pending.length} migration(s):`);
  for (const f of pending) console.log("  •", f);
  if (dryRun) { console.log("(dry-run — no changes written)"); return; }

  for (const f of pending) {
    const path = join(MIGRATIONS_DIR, f);
    const text = readFileSync(path, "utf8");
    process.stdout.write(`→ ${f} ... `);
    try {
      // Each migration runs in its own transaction so a failure mid-file
      // rolls back cleanly. The IF NOT EXISTS / DO EXCEPTION patterns mean
      // re-running is safe, but transaction-per-file is still a good fence.
      await sql.begin(async (tx) => {
        await tx.unsafe(text);
        await tx`INSERT INTO _migrations (filename) VALUES (${f})`;
      });
      console.log("✓");
    } catch (err) {
      console.log("✗");
      console.error("\nMigration failed:", f);
      console.error(err.message || err);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`\n✓ Applied ${pending.length} migration(s).`);
}

try {
  await run();
} finally {
  await sql.end();
}
