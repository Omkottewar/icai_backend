// Assign an office-bearer role to an existing user by email.
//
// Usage:
//   node scripts/assign-role.mjs <email> <role_code> [committee_code]
//
// Examples:
//   node scripts/assign-role.mjs sahil@example.com branch_treasurer
//   node scripts/assign-role.mjs ankush@example.com committee_chairman DT_SG
//   node scripts/assign-role.mjs ankush@example.com mcm
//
// The script:
//   • Looks up the user by email (errors out if not found)
//   • Looks up the role by code (errors out if not in the canonical taxonomy)
//   • For branch-scoped roles, attaches scope_branch_id to the Nagpur branch
//   • For committee-scoped roles, requires committee_code as the 3rd arg
//   • The DB trigger enforces: committee_chairman implies mcm (auto-assign
//     mcm first if needed before chairman; this script does it for you)
//
// Idempotent — re-running the same args is a no-op (we check for an existing
// active assignment first).

import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const [, , emailRaw, roleCodeRaw, committeeCodeRaw] = process.argv;
if (!emailRaw || !roleCodeRaw) {
  console.error("Usage: node scripts/assign-role.mjs <email> <role_code> [committee_code]");
  process.exit(1);
}

const email = String(emailRaw).trim().toLowerCase();
const roleCode = String(roleCodeRaw).trim();
const committeeCode = committeeCodeRaw ? String(committeeCodeRaw).trim() : null;

const sql = postgres(url, { max: 1, prepare: false });

try {
  // 1. User
  const [user] = await sql`SELECT id, name, branch_id FROM users WHERE lower(email) = ${email} AND deleted_at IS NULL`;
  if (!user) {
    console.error(`✗ No user found with email ${email}`);
    process.exit(1);
  }
  console.log(`→ User: ${user.name} (${user.id})`);

  // 2. Role
  const [role] = await sql`SELECT id, code, scope, singleton_per_scope FROM roles WHERE code = ${roleCode}`;
  if (!role) {
    console.error(`✗ Unknown role code ${roleCode}. Run \`SELECT code, name FROM roles\` to see all role codes.`);
    process.exit(1);
  }
  console.log(`→ Role: ${role.code} (scope=${role.scope})`);

  // 3. Scope IDs
  let scope_branch_id = null;
  let scope_committee_id = null;

  if (role.scope === "branch") {
    // Pick the user's own branch, fall back to the Nagpur branch (code='NGP').
    scope_branch_id = user.branch_id;
    if (!scope_branch_id) {
      const [nagpur] = await sql`SELECT id FROM branches WHERE code = 'NGP' OR lower(name) LIKE '%nagpur%' ORDER BY active DESC LIMIT 1`;
      if (!nagpur) {
        console.error("✗ Branch role requires a branch; no Nagpur branch row found. Seed branches first.");
        process.exit(1);
      }
      scope_branch_id = nagpur.id;
    }
  } else if (role.scope === "committee") {
    if (!committeeCode) {
      console.error(`✗ Role ${role.code} is committee-scoped; please pass a committee_code as the 3rd argument.`);
      process.exit(1);
    }
    const [committee] = await sql`SELECT id, name FROM committees WHERE code = ${committeeCode}`;
    if (!committee) {
      console.error(`✗ No committee found with code ${committeeCode}. Run \`SELECT code, name FROM committees\` to see all.`);
      process.exit(1);
    }
    scope_committee_id = committee.id;
    console.log(`→ Committee: ${committee.name}`);
  }

  // 4. Idempotency — bail if an active assignment already exists.
  const existing = await sql`
    SELECT id FROM user_role_assignments
    WHERE user_id = ${user.id}
      AND role_id = ${role.id}
      AND COALESCE(scope_branch_id::text, '~') = COALESCE(${scope_branch_id}::text, '~')
      AND COALESCE(scope_committee_id::text, '~') = COALESCE(${scope_committee_id}::text, '~')
      AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
    LIMIT 1
  `;
  if (existing.length > 0) {
    console.log(`= Already assigned (${existing[0].id}). No change.`);
    process.exit(0);
  }

  // 5. The committee_chairman trigger requires an active mcm role first.
  if (role.code === "committee_chairman") {
    const [mcmRole] = await sql`SELECT id FROM roles WHERE code = 'mcm'`;
    if (!mcmRole) {
      console.error("✗ The 'mcm' role does not exist in the roles table. Seed the role taxonomy first.");
      process.exit(1);
    }
    const mcmActive = await sql`
      SELECT 1 FROM user_role_assignments
      WHERE user_id = ${user.id}
        AND role_id = ${mcmRole.id}
        AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
      LIMIT 1
    `;
    if (mcmActive.length === 0) {
      // Auto-add mcm scoped to the same branch as the chairman.
      const [b] = await sql`SELECT id FROM branches WHERE code = 'NGP' OR lower(name) LIKE '%nagpur%' ORDER BY active DESC LIMIT 1`;
      await sql`
        INSERT INTO user_role_assignments (user_id, role_id, scope_branch_id, effective_from)
        VALUES (${user.id}, ${mcmRole.id}, ${b?.id ?? null}, CURRENT_DATE)
      `;
      console.log("+ Auto-assigned 'mcm' (required by committee_chairman trigger)");
    }
  }

  // 6. Insert.
  const inserted = await sql`
    INSERT INTO user_role_assignments
      (user_id, role_id, scope_branch_id, scope_committee_id, effective_from)
    VALUES
      (${user.id}, ${role.id}, ${scope_branch_id}, ${scope_committee_id}, CURRENT_DATE)
    RETURNING id
  `;
  console.log(`✓ Assigned ${role.code}${committeeCode ? ` / ${committeeCode}` : ""} (${inserted[0].id})`);
} catch (err) {
  console.error("✗ Failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
