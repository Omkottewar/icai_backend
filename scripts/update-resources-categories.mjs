// One-shot updater for the `resources_categories` site-content slot.
//
// Splits the combined "Standards (AS / SA)" tile into two — one for
// Standards on Auditing (SA), one for Accounting Standards (AS / Ind AS)
// — and drops the "Web-Media Policy" tile. Keeps card_1 (Circulars) and
// what was card_3 (e-Journal Archive) intact, now as card_4.
//
// Idempotent: overwrites the slot's data JSONB with the desired shape.
// Safe to re-run.
//
// Usage:  node scripts/update-resources-categories.mjs

import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

const DESIRED = {
  card_1_title: "Circulars",
  card_1_desc:  "ICAI announcements, notifications and council decisions.",
  card_1_url:   "https://www.icai.org/category/announcements",
  card_2_title: "Standards on Auditing (SA)",
  card_2_desc:  "ICAI-issued Standards on Auditing — planning, evidence, reporting and quality.",
  card_2_url:   "https://www.icai.org/post/standards-on-auditing",
  card_3_title: "Accounting Standards (AS / Ind AS)",
  card_3_desc:  "Accounting Standards and Ind AS notified for entities in India.",
  card_3_url:   "https://www.icai.org/post/accounting-standards",
  card_4_title: "e-Journal Archive",
  card_4_desc:  "Browse The Chartered Accountant journal archives.",
  card_4_url:   "https://www.icai.org/category/e-journal",
};

try {
  const rows = await sql`
    INSERT INTO site_content (slug, data)
    VALUES ('resources_categories', ${sql.json(DESIRED)})
    ON CONFLICT (slug) DO UPDATE
      SET data = ${sql.json(DESIRED)},
          updated_at = now()
    RETURNING slug
  `;
  console.log(`✓ Updated slot: ${rows[0].slug}`);
  console.log("  Cards: Circulars → SA → AS/Ind AS → e-Journal. Web-Media Policy removed.");
} catch (err) {
  console.error("✗ Failed:", err.message);
  if (err.detail) console.error("  detail:", err.detail);
  process.exitCode = 1;
} finally {
  await sql.end();
}
