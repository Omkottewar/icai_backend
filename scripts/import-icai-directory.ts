// One-shot CLI import for the ICAI member directory xlsx. Mirrors the logic
// of POST /api/admin/icai-directory/import so it can be re-run from the
// command line without a logged-in admin session.
//
// Usage:
//   npx tsx scripts/import-icai-directory.ts ../ICAI\ DIRECTORY.xlsx
//   npm run icai:import-directory -- "../ICAI DIRECTORY.xlsx"
//
// Idempotent — upserts on `mrn`, so re-running with the same file just
// refreshes the rows.

import "dotenv/config";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import * as XLSX from "xlsx";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { icaiMemberMaster, siteSettings } from "../schema/index.js";

const HEADER_MAP: Record<string, string> = {
  mrn: "mrn",
  membership_no: "mrn",
  membership_number: "mrn",
  membership: "mrn",
  icai_membership_no: "mrn",
  icai_membership_number: "mrn",
  icai_membership: "mrn",
  name: "name",
  full_name: "name",
  member_name: "name",
  email: "email",
  email_id: "email",
  email_address: "email",
  phone: "phone",
  mobile: "phone",
  mobile_no: "phone",
  mobile_number: "phone",
  contact: "phone",
  contact_no: "phone",
  city: "city",
  location: "city",
  firm: "firm_name",
  firm_name: "firm_name",
  firm_organization: "firm_name",
  organization: "firm_name",
  fca: "fca_flag",
  fca_flag: "fca_flag",
  fca_aca: "fca_flag",
  cop: "cop_status",
  cop_status: "cop_status",
};

function normHeader(h: string): string {
  return h
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[\s\-./]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function pickFcaFlag(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "y" || s === "yes" || s === "fca" || s === "true" || s === "1";
}

const filePath = process.argv[2] || "../ICAI DIRECTORY.xlsx";
const abs = resolve(process.cwd(), filePath);
console.log(`Reading: ${abs}`);
const buf = await readFile(abs);
console.log(`File size: ${(buf.length / 1024).toFixed(1)} KB`);

const workbook = XLSX.read(buf, { type: "buffer" });
if (workbook.SheetNames.length === 0) {
  console.error("Workbook has no sheets");
  process.exit(1);
}

// Pick the first sheet that has BOTH an MRN-like column AND a Name-like
// column. Some workbooks lead with a "Summary" / "Pivot" sheet — skip past
// those to the real form-response tab.
let sheetName = "";
let rows: Record<string, unknown>[] = [];
let colMap: Record<string, string> = {};

for (const candidate of workbook.SheetNames) {
  const sheet = workbook.Sheets[candidate];
  const candidateRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });
  if (candidateRows.length === 0) continue;
  const keys = Object.keys(candidateRows[0]);
  const map: Record<string, string> = {};
  for (const raw of keys) {
    const canon = HEADER_MAP[normHeader(raw)];
    if (canon) map[raw] = canon;
  }
  const values = Object.values(map);
  if (values.includes("mrn") && values.includes("name")) {
    sheetName = candidate;
    rows = candidateRows;
    colMap = map;
    break;
  }
  console.log(`  (skipping sheet "${candidate}" — ${candidateRows.length} rows, no MRN+Name columns)`);
}

if (!sheetName) {
  console.error("\n✗ No sheet in the workbook has both an MRN and a Name column.");
  console.error("  Sheets found:", workbook.SheetNames.join(", "));
  process.exit(1);
}

console.log(`Sheet "${sheetName}" — ${rows.length} rows`);
const sampleKeys = Object.keys(rows[0]);

console.log("\nHeader mapping detected:");
for (const [src, dst] of Object.entries(colMap)) {
  console.log(`  "${src}" → ${dst}`);
}

if (!Object.values(colMap).includes("mrn") || !Object.values(colMap).includes("name")) {
  console.error("\n✗ Spreadsheet must include at least an MRN column and a Name column.");
  console.error(`  Headers seen: ${sampleKeys.map((k) => `"${k}"`).join(", ")}`);
  process.exit(1);
}

let imported = 0;
let skipped = 0;
const errors: string[] = [];

const CHUNK = 500;
const filename = filePath.split(/[\\/]/).pop() || "icai_directory.xlsx";

console.log(`\nImporting in chunks of ${CHUNK}…`);
for (let i = 0; i < rows.length; i += CHUNK) {
  const slice = rows.slice(i, i + CHUNK);
  const payload = slice.flatMap((raw) => {
    const out: Record<string, unknown> = {};
    for (const [src, dst] of Object.entries(colMap)) {
      out[dst] = raw[src];
    }
    const mrn = String(out.mrn ?? "").trim();
    const name = String(out.name ?? "").trim();
    if (!mrn || !name) {
      skipped++;
      return [];
    }
    return [{
      mrn,
      name,
      email:       out.email ? String(out.email).trim().toLowerCase() : null,
      phone:       out.phone ? String(out.phone).trim() : null,
      city:        out.city ? String(out.city).trim() : null,
      firm_name:   out.firm_name ? String(out.firm_name).trim() : null,
      fca_flag:    pickFcaFlag(out.fca_flag),
      cop_status:  out.cop_status ? String(out.cop_status).trim() : null,
      source_file: filename,
      raw,
    }];
  });

  if (payload.length === 0) continue;
  // Postgres rejects ON CONFLICT DO UPDATE if the same conflict target
  // appears twice in one INSERT. De-dupe by MRN inside the chunk — last
  // occurrence wins (matches a manual edit overriding an earlier row).
  const byMrn = new Map<string, any>();
  for (const r of payload) byMrn.set(String((r as any).mrn), r);
  const deduped = Array.from(byMrn.values());
  if (deduped.length < payload.length) {
    skipped += (payload.length - deduped.length);
  }
  try {
    await db
      .insert(icaiMemberMaster)
      .values(deduped as any)
      .onConflictDoUpdate({
        target: icaiMemberMaster.mrn,
        set: {
          name:        sql`EXCLUDED.name`,
          email:       sql`EXCLUDED.email`,
          phone:       sql`EXCLUDED.phone`,
          city:        sql`EXCLUDED.city`,
          firm_name:   sql`EXCLUDED.firm_name`,
          fca_flag:    sql`EXCLUDED.fca_flag`,
          cop_status:  sql`EXCLUDED.cop_status`,
          imported_at: sql`now()`,
          source_file: sql`EXCLUDED.source_file`,
          raw:         sql`EXCLUDED.raw`,
        },
      });
    imported += payload.length;
    process.stdout.write(`  rows ${i + 1}-${Math.min(i + CHUNK, rows.length)} of ${rows.length} ✓\r`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    console.error(`\n  ✗ chunk ${i}-${i + CHUNK}: ${msg}`);
  }
}

console.log("\n\n─────────────────────────────────");
console.log(`✓ Imported: ${imported}`);
console.log(`  Skipped:  ${skipped} (missing MRN or Name)`);
if (errors.length) {
  console.log(`  Errors:   ${errors.length}`);
  errors.slice(0, 5).forEach((e, i) => console.log(`    [${i + 1}] ${e}`));
}

// Make sure the gating flag row exists (default off, so dev signups stay
// open until an admin flips it via /admin/icai-directory).
const [flag] = await db.select().from(siteSettings).where(sql`${siteSettings.key} = 'signup.mrn_gating_enabled'`).limit(1);
if (!flag) {
  await db.insert(siteSettings).values({ key: "signup.mrn_gating_enabled", value: "false" });
  console.log("\n  Seeded site_settings.signup.mrn_gating_enabled = false (default off)");
} else {
  console.log(`\n  Existing gating flag: ${flag.value}`);
}

process.exit(errors.length ? 1 : 0);
