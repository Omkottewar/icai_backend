// Apply a raw .sql file to the Supabase Postgres using postgres-js.
// Usage: node scripts/apply-sql.mjs drizzle/0001_constraints_and_indexes.sql

import "dotenv/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/apply-sql.mjs <path-to-sql-file>");
  process.exit(1);
}

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });
const text = readFileSync(resolve(file), "utf8");

try {
  console.log(`Applying ${file} …`);
  await sql.unsafe(text);
  console.log("✓ Done.");
} catch (err) {
  console.error("✗ Failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
