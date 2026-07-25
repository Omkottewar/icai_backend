// One-off reconciliation for migrations 0090 and 0091.
//
// Symptom: `npm run db:migrate` fails at 0090 with
// `relation "reading_room_deposits" already exists` because the
// reading-room tables were applied out-of-band (drizzle-kit push or
// manual SQL) without a row in `_migrations`.
//
// This script verifies the expected schema for 0090 + 0091 is actually
// present in the DB. If everything checks out, it records both files in
// `_migrations` so the regular runner will skip them and continue with
// 0092+. If anything is missing it aborts and prints what's absent, so
// you know a real re-run is needed rather than a rubber-stamp.
//
// Usage:
//   node scripts/reconcile-reading-room-migrations.mjs           # verify + mark
//   node scripts/reconcile-reading-room-migrations.mjs --dry-run # verify only
//
// After a successful run, follow up with `npm run db:migrate`.

import "dotenv/config";
import postgres from "postgres";

const dryRun = process.argv.includes("--dry-run");

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) must be set");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

async function tableExists(name) {
  const rows = await sql`
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = ${name}
  `;
  return rows.length > 0;
}

async function columnExists(table, column) {
  const rows = await sql`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = ${table}
      AND column_name = ${column}
  `;
  return rows.length > 0;
}

try {
  // 0090 — reading_room_deposits + reading_room_bookings
  const checks0090 = {
    "reading_room_deposits table":         await tableExists("reading_room_deposits"),
    "reading_room_bookings table":         await tableExists("reading_room_bookings"),
  };
  // 0091 — reading_rooms catalogue + reading_room_bookings.room_id
  const checks0091 = {
    "reading_rooms table":                 await tableExists("reading_rooms"),
    "reading_room_bookings.room_id column": await columnExists("reading_room_bookings", "room_id"),
  };

  console.log("── 0090 checks ──");
  for (const [k, v] of Object.entries(checks0090)) console.log(`  ${v ? "✓" : "✗"} ${k}`);
  console.log("── 0091 checks ──");
  for (const [k, v] of Object.entries(checks0091)) console.log(`  ${v ? "✓" : "✗"} ${k}`);

  const ok0090 = Object.values(checks0090).every(Boolean);
  const ok0091 = Object.values(checks0091).every(Boolean);

  if (!ok0090 || !ok0091) {
    console.error("\n✗ Schema incomplete — aborting. Do NOT mark these migrations as applied.");
    console.error("  If you need to run the migrations for real, edit the .sql files to be");
    console.error("  idempotent (IF NOT EXISTS) first, then run `npm run db:migrate`.");
    process.exit(1);
  }

  console.log("\nAll expected objects present. Marking 0090 + 0091 as applied.");
  if (dryRun) {
    console.log("(dry-run — no changes written)");
  } else {
    const filenames = [
      "0090_reading_room_pass.sql",
      "0091_reading_rooms_multi.sql",
    ];
    await sql`
      INSERT INTO _migrations (filename)
      VALUES ${sql(filenames.map((f) => [f]))}
      ON CONFLICT (filename) DO NOTHING
    `;
    console.log("✓ Done. Run `npm run db:migrate` next to apply 0092+.");
  }
} finally {
  await sql.end();
}
