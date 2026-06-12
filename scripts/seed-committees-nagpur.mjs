// Seeds the 13 standing committees of ICAI Nagpur Branch as shared by the
// client (June 2026). Names come straight from the official roster sheet;
// codes are short uppercase tags I've chosen so URLs / pills stay readable.
//
// Idempotent — uses ON CONFLICT (code) DO NOTHING / UPDATE so re-running is
// safe. Existing test committees (CPE, GST, AUDIT, IT, etc. from the
// original seed-committees.mjs) are LEFT IN PLACE; the codes below are
// deliberately distinct (DT_SG vs the legacy "TAX", etc.) so we don't
// rename anything live without a deliberate sweep.
//
// Usage: node scripts/seed-committees-nagpur.mjs

import "dotenv/config";
import postgres from "postgres";

const COMMITTEES = [
  { code: "DT_SG",        name: "Direct Tax Study Group",                       description: "Study group on direct tax updates, case law and practice" },
  { code: "FELLOWSHIP",   name: "Fellowship Committee",                         description: "Member fellowship, networking, and community events" },
  { code: "SUBSIDIES_SG", name: "Study Group on Subsidies & Incentives",        description: "Government subsidies, MSME incentives and related advisory" },
  { code: "BFSI_SG",      name: "Study Group on BFSI",                          description: "Banking, financial services and insurance sector practice" },
  { code: "CMIB",         name: "Committee for Members in Industry & Business", description: "Programmes for CAs working in industry and business roles" },
  { code: "CIT",          name: "Committee on Information Technology",          description: "Tech-for-CAs initiatives, automation, data tools" },
  { code: "IBC_SG",       name: "IBC Study Group",                              description: "Insolvency and Bankruptcy Code practice and case studies" },
  { code: "RERA_SG",      name: "RERA Study Group",                             description: "Real Estate Regulation Act compliance and advisory" },
  { code: "GST_SG",       name: "GST Study Group",                              description: "GST advisory, training, updates and case law" },
  { code: "AUDIT_EAP",    name: "Audit & Emerging Areas of Practice",           description: "Audit standards and new areas of professional practice" },
  { code: "CORP_LAW",     name: "Corporate Law Group",                          description: "Companies Act, SEBI, corporate compliance and advisory" },
  { code: "COOP_SG",      name: "Study Group on Cooperatives",                  description: "Cooperative societies and bank audits, sector practice" },
  { code: "WICASA",       name: "Women Excellence and Young Members",           description: "Programmes for women members, young CAs and student wing" },
];

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

try {
  let inserted = 0;
  let updated = 0;
  for (const c of COMMITTEES) {
    // ON CONFLICT … DO UPDATE keeps the description fresh if I tweak it
    // later, but never resurrects deactivated committees (active stays
    // whatever it was, since we don't include it in the SET clause).
    const result = await sql`
      INSERT INTO committees (code, name, description, active)
      VALUES (${c.code}, ${c.name}, ${c.description}, true)
      ON CONFLICT (code) DO UPDATE SET
        name = EXCLUDED.name,
        description = EXCLUDED.description
      RETURNING id, (xmax = 0) AS inserted
    `;
    const row = result[0];
    if (row.inserted) {
      console.log(`✓ Inserted ${c.code} — ${c.name}`);
      inserted++;
    } else {
      console.log(`↻ Updated  ${c.code} — ${c.name}`);
      updated++;
    }
  }
  console.log(`\nDone. ${inserted} inserted, ${updated} updated.`);
} catch (err) {
  console.error("✗ Failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
