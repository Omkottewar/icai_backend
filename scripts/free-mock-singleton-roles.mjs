// One-shot cleanup — delete singleton-role assignments that the mock-data
// stress seed accidentally gave to mock users. These rows block real-user
// assignments (e.g. you can't promote a real treasurer because a mock one
// already holds the slot).
//
// Affected singleton roles (per drizzle/0003_roles_taxonomy.sql):
//   branch_chairman, branch_vice_chairman, branch_secretary, branch_treasurer,
//   wicasa_chairman, wicasa_vice_chairman
//   (committee_chairman is per-committee singleton — also cleared here)
//
// Targets only mock users (email LIKE 'mock+%@icai-nagpur.local'). Real-user
// assignments are untouched.
//
// Usage:  node scripts/free-mock-singleton-roles.mjs

import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(url, { max: 1, prepare: false });

try {
  const before = await sql`
    SELECT u.email, r.code AS role_code, ura.id AS assignment_id
    FROM user_role_assignments ura
    JOIN roles r ON r.id = ura.role_id
    JOIN users u ON u.id = ura.user_id
    WHERE r.singleton_per_scope = true
      AND u.email LIKE 'mock+%@icai-nagpur.local'
      AND (ura.effective_to IS NULL OR ura.effective_to >= CURRENT_DATE)
  `;
  console.log(`Found ${before.length} active singleton assignments held by mock users:`);
  for (const r of before) console.log(`  • ${r.email}  →  ${r.role_code}  (${r.assignment_id})`);

  if (before.length === 0) {
    console.log("\nNothing to do.\n");
    process.exit(0);
  }

  const deleted = await sql`
    DELETE FROM user_role_assignments
    WHERE id IN (
      SELECT ura.id
      FROM user_role_assignments ura
      JOIN roles r ON r.id = ura.role_id
      JOIN users u ON u.id = ura.user_id
      WHERE r.singleton_per_scope = true
        AND u.email LIKE 'mock+%@icai-nagpur.local'
    )
    RETURNING id
  `;
  console.log(`\n✓ Deleted ${deleted.length} mock singleton-role assignment(s). Slots are free.\n`);
} catch (err) {
  console.error("✗", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
