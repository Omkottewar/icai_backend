// One-shot update for the Resources page top-tile URLs.
//
// Updates the `resources_categories` site-content slot so the Standards
// (AS/SA), e-Journal, and Web-Media Policy tiles point to the URLs the
// client confirmed. Preserves existing titles/descriptions and any other
// keys that may already exist on the row.
//
// Usage:
//   node scripts/update-resource-links.mjs

import "dotenv/config";
import postgres from "postgres";

const DB_URL = process.env.DATABASE_URL || process.env.SUPABASE_URL;
if (!DB_URL) {
  console.error("DATABASE_URL or SUPABASE_URL is required");
  process.exit(1);
}
const sql = postgres(DB_URL, { ssl: DB_URL.includes("supabase") ? "require" : undefined });

const NEW = {
  card_2_url: "https://www.icai.org/post/standards-on-auditing",
  card_3_url: "https://www.icai.org/category/e-journal",
  card_4_url: "https://acrobat.adobe.com/id/urn:aaid:sc:AP:eb1357ad-534c-40f8-93e7-6563ada35afd",
};

async function main() {
  const [row] = await sql`SELECT data FROM site_content WHERE slug = 'resources_categories'`;
  const current = row?.data || {};
  console.log("Before:");
  for (const k of Object.keys(NEW)) console.log(`  ${k} = ${current[k] ?? "(unset)"}`);

  const merged = { ...current, ...NEW };
  await sql`
    INSERT INTO site_content (slug, data, updated_at)
    VALUES ('resources_categories', ${sql.json(merged)}, NOW())
    ON CONFLICT (slug) DO UPDATE
      SET data = EXCLUDED.data, updated_at = NOW()
  `;

  const [after] = await sql`SELECT data FROM site_content WHERE slug = 'resources_categories'`;
  console.log("\nAfter:");
  for (const k of Object.keys(NEW)) console.log(`  ${k} = ${after.data[k]}`);
  console.log("\nDone.");
  await sql.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
