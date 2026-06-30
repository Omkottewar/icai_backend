// Full restore: Nagpur branch + 13 committees + real chairmen / conveners /
// co-conveners as supplied by the client roster sheet (June 2026).
//
// Idempotent — safe to re-run. Designed to recover from a truncated DB.
//
// What it does:
//   1. Ensures the NGP branch row exists.
//   2. Seeds the 13 standing committees (codes match seed-committees-nagpur.mjs).
//   3. For each (committee, person, role) triple from the PDF:
//      - Looks up or creates a placeholder user (email = name slug @
//        committee.icainagpur.in). Users have no password — they're stubs to
//        satisfy the FK on user_role_assignments. Real members can be linked
//        in later by an admin via /admin/users.
//      - Ensures every chairman holds the branch-scoped `mcm` role (DB
//        trigger `enforce_committee_chairman_is_mcm` requires it before the
//        committee_chairman assignment will succeed).
//      - Inserts the appropriate committee-scoped role
//        (committee_chairman / committee_convener / committee_co_convener).
//
// What it does NOT do:
//   - Download chairman photos from Google Drive (the PDF lists drive URLs
//     but they need OAuth + per-file share-permission handling). The script
//     prints a "photos pending" report at the end so an admin can upload
//     them manually via /admin/office-bearers or the committee admin UI.
//
// Usage:  npx tsx scripts/seed-committees-and-staff.mjs

import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}
const sql = postgres(url, { max: 1, prepare: false });

// ─── Source data (verbatim from the client roster PDF) ──────────────────
// Each row: [committee_code, chairman, convener|null, co_convener|null,
//            chairman_photo_drive_url|null]
const ROSTER = [
  ["DT_SG",        "CA Ankush Kesharwani",   "CA Kailash Jogani",  "CA Pranav Ashtikar",  "https://drive.google.com/open?id=1d3JpS91vDW7wmXDbriJag653Xe_FPD6D"],
  ["FELLOWSHIP",   "CA Ankush Kesharwani",   "CA Saket Bagadiya",  "CA Pawan Khabiya",    "https://drive.google.com/open?id=1d0dMk7b2Y7H1iFuIypAlCdq7R7CBiX11"],
  ["SUBSIDIES_SG", "CA Vinod Vijay Agrawal", "CA Julfesh Shah",    "CA Nitin Agrawal",    "https://drive.google.com/open?id=1_AH3P5WuTzXvzNdD01mpuht1rBiT6OFX"],
  ["BFSI_SG",      "CA Vinod Vijay Agrawal", "CA Mahesh Rathi",    "CA Arpan Lohiya",     "https://drive.google.com/open?id=1EfKVZ5N2CigSLJZyPqgUYW7LrZ3W6qCD"],
  ["CMIB",         "CA Ashish Agarwal",      "CA Ahijit Kelkar",   "CA Hetal Sampat",     "https://drive.google.com/open?id=1KxnU3Kf14Oxss7xnU92EemddSPs3Qsju"],
  ["CIT",          "CA Ashish Agarwal",      "CA Akshay Gulhane",  "CA Ravi Ramani",      "https://drive.google.com/open?id=1rlIrqhfLzI0nPusvwL0kauu9PekI6p4O"],
  ["IBC_SG",       "CA Pranavkumar Limaja",  "CA Swapnil Agrawal", "CA Prasad Dharap",    "https://drive.google.com/open?id=1qdvHmE1OH4iGjYKRz_Q7_vb0SPgtpJ28"],
  ["RERA_SG",      "CA Pranavkumar Limaja",  "CA Suren Duragkar",  "CA Mayank Saraf",     "https://drive.google.com/open?id=1cEVS-Wiw3wweQ6qNwQuiv-Li6a5_z_xP"],
  ["GST_SG",       "CA Deepak Jethwani",     "CA Satish Sarda",    "CA Jai Poptani",      "https://drive.google.com/open?id=1BbbO8I6ybaCGzGOYB0B0nJuaP7EU4Tce"],
  ["AUDIT_EAP",    "CA Dinesh Rathi",        "CA Sandeep Jotwani", "CA Nitin Alsi",       "https://drive.google.com/open?id=1K9xnuiGuaopgp-hE-eMk76avEuXpBajL"],
  ["CORP_LAW",     "CA Deepak Jethwani",     "CA I S Bagadia",     null,                  "https://drive.google.com/open?id=113Hwxxmqe-yqdaJUc-4-ffB3bC-BDWOu"],
  ["COOP_SG",      "CA Vinod Vijay Agrawal", "CA Makrand Joshi",   null,                  "https://drive.google.com/open?id=1RtQiK71Y7InKpP0kjQ25tLYCQdtb2g2E"],
  ["WICASA",       "CA Trupti Bhattad",      null,                 null,                  "https://drive.google.com/open?id=1b_kPAAc0Q7ewja6v1MT-auSBqsxQbH4r"],
];

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

// ─── Helpers ─────────────────────────────────────────────────────────────

function slugify(name) {
  return name.toLowerCase()
    .replace(/^ca\.?\s+/i, "")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 48);
}

function placeholderEmail(name) {
  return `${slugify(name)}@committee.icainagpur.in`;
}

// ─── Main ────────────────────────────────────────────────────────────────

try {
  console.log("Step 1 — Ensure Nagpur branch exists");
  let [branch] = await sql`SELECT id, name FROM branches WHERE code = 'NGP'`;
  if (!branch) {
    [branch] = await sql`
      INSERT INTO branches (code, name, city, state, region_code, active)
      VALUES ('NGP', 'ICAI Nagpur Branch (WIRC)', 'Nagpur', 'Maharashtra', 'WIRC', true)
      RETURNING id, name
    `;
    console.log(`  ✓ Created branch: ${branch.name}  id=${branch.id}`);
  } else {
    console.log(`  = Branch exists: ${branch.name}  id=${branch.id}`);
  }

  console.log("\nStep 2 — Seed the 13 standing committees");
  const committeeIdByCode = new Map();
  for (const c of COMMITTEES) {
    const [row] = await sql`
      INSERT INTO committees (code, name, description, active)
      VALUES (${c.code}, ${c.name}, ${c.description}, true)
      ON CONFLICT (code) DO UPDATE SET
        name        = EXCLUDED.name,
        description = EXCLUDED.description
      RETURNING id, (xmax = 0) AS inserted
    `;
    committeeIdByCode.set(c.code, row.id);
    console.log(`  ${row.inserted ? "✓ Inserted" : "↻ Updated "} ${c.code.padEnd(12)} ${c.name}`);
  }

  console.log("\nStep 3 — Resolve the role ids");
  const roleRows = await sql`
    SELECT id, code FROM roles
    WHERE code IN ('mcm', 'committee_chairman', 'committee_convener', 'committee_co_convener')
  `;
  const roleByCode = new Map(roleRows.map((r) => [r.code, r.id]));
  for (const code of ["mcm", "committee_chairman", "committee_convener", "committee_co_convener"]) {
    if (!roleByCode.has(code)) {
      throw new Error(`Required role "${code}" missing from roles table. Run scripts/seed-roles.mjs first.`);
    }
  }
  console.log("  ✓ All 4 required roles present");

  console.log("\nStep 4 — Upsert placeholder users for each unique person");
  // De-dupe across rows (one person can hold multiple positions).
  const uniqueNames = new Set();
  for (const [, chairman, convener, coConvener] of ROSTER) {
    if (chairman)    uniqueNames.add(chairman);
    if (convener)    uniqueNames.add(convener);
    if (coConvener)  uniqueNames.add(coConvener);
  }
  const userIdByName = new Map();
  for (const name of uniqueNames) {
    const email = placeholderEmail(name);
    let [user] = await sql`SELECT id FROM users WHERE lower(email) = ${email.toLowerCase()}`;
    if (!user) {
      [user] = await sql`
        INSERT INTO users (email, name, primary_role, branch_id, status)
        VALUES (${email}, ${name}, 'member', ${branch.id}, 'active')
        RETURNING id
      `;
      console.log(`  ✓ Created user: ${name.padEnd(28)} ${email}`);
    } else {
      console.log(`  = User exists:  ${name.padEnd(28)} ${email}`);
    }
    userIdByName.set(name, user.id);
  }

  console.log("\nStep 5 — Grant MCM (branch-scoped) to every chairman");
  // DB trigger enforce_committee_chairman_is_mcm() requires this before
  // we can assign committee_chairman in the next step.
  const chairmenNames = new Set(ROSTER.map((r) => r[1]).filter(Boolean));
  for (const name of chairmenNames) {
    const userId = userIdByName.get(name);
    const [existing] = await sql`
      SELECT id FROM user_role_assignments
      WHERE user_id = ${userId}
        AND role_id = ${roleByCode.get("mcm")}
        AND scope_branch_id = ${branch.id}
        AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
    `;
    if (existing) {
      console.log(`  = ${name.padEnd(28)} already has MCM`);
      continue;
    }
    await sql`
      INSERT INTO user_role_assignments (user_id, role_id, scope_branch_id, effective_from)
      VALUES (${userId}, ${roleByCode.get("mcm")}, ${branch.id}, CURRENT_DATE)
    `;
    console.log(`  + ${name.padEnd(28)} granted MCM`);
  }

  console.log("\nStep 6 — Assign committee roles");
  let granted = 0;
  let skipped = 0;
  for (const [committeeCode, chairman, convener, coConvener] of ROSTER) {
    const committeeId = committeeIdByCode.get(committeeCode);
    console.log(`\n  ${committeeCode}`);
    for (const [name, roleCode, label] of [
      [chairman,   "committee_chairman",    "Chairman"],
      [convener,   "committee_convener",    "Convener"],
      [coConvener, "committee_co_convener", "Co-Convener"],
    ]) {
      if (!name) {
        console.log(`    · ${label.padEnd(12)} (none in roster)`);
        continue;
      }
      const userId = userIdByName.get(name);
      const roleId = roleByCode.get(roleCode);
      const [existing] = await sql`
        SELECT id FROM user_role_assignments
        WHERE user_id = ${userId}
          AND role_id = ${roleId}
          AND scope_committee_id = ${committeeId}
          AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
      `;
      if (existing) {
        console.log(`    = ${label.padEnd(12)} ${name} (already assigned)`);
        skipped++;
        continue;
      }
      try {
        await sql`
          INSERT INTO user_role_assignments
            (user_id, role_id, scope_committee_id, effective_from)
          VALUES (${userId}, ${roleId}, ${committeeId}, CURRENT_DATE)
        `;
        console.log(`    + ${label.padEnd(12)} ${name}`);
        granted++;
      } catch (err) {
        console.log(`    ✗ ${label.padEnd(12)} ${name}  — ${err.message}`);
      }
    }
  }

  console.log("\n────────────────────────────────────────");
  console.log(`✓ Done. ${granted} new role assignments, ${skipped} already in place.`);
  console.log("\nPhotos pending (upload via /admin/office-bearers when ready):");
  for (const [code, chairman, , , drive] of ROSTER) {
    console.log(`  ${code.padEnd(12)} ${chairman.padEnd(28)} ${drive}`);
  }
} catch (err) {
  console.error("\n✗ Failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
