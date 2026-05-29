// Seeds the default committees the events form depends on.
// Idempotent — uses ON CONFLICT (code) DO NOTHING.
// Usage: node scripts/seed-committees.mjs

import "dotenv/config";
import postgres from "postgres";

const COMMITTEES = [
  { code: "CPE",    name: "Continuing Professional Education", description: "Seminars, workshops, and CPE programmes for members" },
  { code: "WICASA", name: "WICASA — Students' wing",            description: "Programmes and events for CA students" },
  { code: "TAX",    name: "Direct Tax",                          description: "Direct tax updates, seminars, and study circles" },
  { code: "GST",    name: "GST & Indirect Tax",                  description: "GST advisory, training, and updates" },
  { code: "AUDIT",  name: "Audit & Assurance",                   description: "Audit standards and practice development" },
  { code: "IT",     name: "Information Technology",              description: "Tech-for-CAs initiatives, automation, data tools" },
];

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

try {
  let inserted = 0;
  for (const c of COMMITTEES) {
    const result = await sql`
      INSERT INTO committees (code, name, description, active)
      VALUES (${c.code}, ${c.name}, ${c.description}, true)
      ON CONFLICT (code) DO NOTHING
      RETURNING id
    `;
    if (result.length > 0) {
      console.log(`✓ Inserted ${c.code} — ${c.name}`);
      inserted++;
    } else {
      console.log(`= ${c.code} already exists`);
    }
  }
  console.log(`\nDone. ${inserted} committee${inserted === 1 ? "" : "s"} inserted.`);
} catch (err) {
  console.error("✗ Failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
