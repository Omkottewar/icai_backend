// Re-seed notification_templates after a data wipe.
//
// The seed lives inside migrations 0016 + 0027 + 0036. Once those migrations
// have been recorded as applied, `npm run db:migrate` won't re-run them — so
// if someone TRUNCATES (or DELETE FROM) notification_templates, the seed
// is gone with no easy way to restore it.
//
// This script re-extracts the INSERT...ON CONFLICT blocks from those three
// SQL files and re-executes them. Idempotent — ON CONFLICT (key) DO NOTHING
// preserves any admin edits made through /admin/notification-templates.
//
// Run:  npx tsx scripts/reseed-notification-templates.mjs

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";

const FILES = [
  "0016_notifications.sql",
  "0027_section_owners_and_tasks.sql",
  "0036_checklist_notification_templates.sql",
];

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(url, { max: 1, prepare: false });

try {
  console.log("Re-seeding notification_templates from migration files…\n");
  let totalRan = 0;

  for (const file of FILES) {
    const path = join(process.cwd(), "drizzle", file);
    const text = await readFile(path, "utf8");

    // Extract every INSERT INTO "notification_templates" … ; block.
    // Stops at the first `;` on its own line, allowing multi-line VALUES.
    const re = /INSERT\s+INTO\s+"?notification_templates"?[\s\S]*?ON\s+CONFLICT[\s\S]*?;/gi;
    const blocks = text.match(re) || [];
    if (blocks.length === 0) {
      console.log(`  ${file}: (no notification_templates INSERT blocks)`);
      continue;
    }

    for (const block of blocks) {
      try {
        await sql.unsafe(block);
        totalRan++;
        console.log(`  ✓ ${file}: ran 1 block`);
      } catch (e) {
        console.log(`  ✗ ${file}: ${e.message.split("\n")[0]}`);
      }
    }
  }

  const [{ count }] = await sql`SELECT COUNT(*)::int AS count FROM notification_templates`;
  console.log(`\n✓ Done. ${totalRan} INSERT blocks ran. notification_templates now has ${count} rows.`);
  process.exit(0);
} catch (err) {
  console.error("\n✗ Failed:", err.message);
  process.exit(1);
} finally {
  await sql.end();
}
