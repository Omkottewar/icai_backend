// Grant the 'admin' role to an existing user.
// Usage: node scripts/promote-admin.mjs <email>
//
// Idempotent: if the user already has an active admin assignment, the script
// reports success and exits without touching the row.

import "dotenv/config";
import postgres from "postgres";

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("Usage: node scripts/promote-admin.mjs <email>");
  process.exit(1);
}

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

try {
  const [user] = await sql`
    SELECT id, name, email, primary_role, status, deleted_at
    FROM users
    WHERE lower(email) = ${email}
    LIMIT 1
  `;
  if (!user) {
    console.error(`✗ No user found with email "${email}".`);
    console.error("  Tip: have the user sign up first via the /signup page, then run this script.");
    process.exit(2);
  }
  if (user.deleted_at) {
    console.error(`✗ User "${email}" is soft-deleted. Restore the user before promoting.`);
    process.exit(3);
  }

  let [role] = await sql`SELECT id, code, name FROM roles WHERE code = 'admin' LIMIT 1`;
  if (!role) {
    [role] = await sql`
      INSERT INTO roles (code, name, description)
      VALUES ('admin', 'Admin', 'System administrator with full access to the admin console')
      RETURNING id, code, name
    `;
    console.log(`✓ Created 'admin' role (id=${role.id})`);
  }

  const today = new Date().toISOString().slice(0, 10);
  const [existing] = await sql`
    SELECT id FROM user_role_assignments
    WHERE user_id = ${user.id}
      AND role_id = ${role.id}
      AND (effective_to IS NULL OR effective_to >= ${today})
    LIMIT 1
  `;
  if (existing) {
    console.log(`= ${user.name} <${user.email}> is already an active admin (assignment ${existing.id}).`);
    process.exit(0);
  }

  const [assignment] = await sql`
    INSERT INTO user_role_assignments (user_id, role_id, effective_from)
    VALUES (${user.id}, ${role.id}, ${today})
    RETURNING id
  `;
  console.log(`✓ Promoted ${user.name} <${user.email}> to admin (assignment ${assignment.id}).`);
  console.log(`  Sign in at /login then open /admin.`);
} catch (err) {
  console.error("✗ Failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
