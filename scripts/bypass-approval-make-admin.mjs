// One-off: bypass the sign-up approval gate AND grant admin to a specific email.
//
// Usage:
//   node scripts/bypass-approval-make-admin.mjs <email>
//
// What it does (all-or-nothing, wrapped in a transaction):
//   1. Looks up the user by email (case-insensitive).
//   2. If status='pending_approval', flips it to 'active' — this is the
//      "bypass" part: the JWT middleware only rejects non-active users, so
//      this single field flip removes the approval wall.
//   3. Sets primary_role='admin' so the sidebar / dashboard treat them as
//      admin without a second lookup.
//   4. Inserts an active `admin` row in user_role_assignments (idempotent —
//      re-running is safe).
//
// Prints a summary of every field it touched so you can eyeball the change.
// Exits non-zero if the user doesn't exist yet (they must sign up first).

import "dotenv/config";
import postgres from "postgres";

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("Usage: node scripts/bypass-approval-make-admin.mjs <email>");
  process.exit(1);
}

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false });

try {
  await sql.begin(async (tx) => {
    // 1. User lookup
    const [user] = await tx`
      SELECT id, name, email, primary_role, status, deleted_at
      FROM users
      WHERE lower(email) = ${email}
      LIMIT 1
    `;
    if (!user) {
      console.error(`✗ No user found with email "${email}".`);
      console.error("  Have the user sign up via /signup first, then re-run.");
      process.exitCode = 2;
      throw new Error("USER_NOT_FOUND");
    }
    if (user.deleted_at) {
      console.error(`✗ User "${email}" is soft-deleted. Restore first.`);
      process.exitCode = 3;
      throw new Error("USER_DELETED");
    }

    console.log(`→ Found user: ${user.name} <${user.email}>`);
    console.log(`  Before: status=${user.status}  primary_role=${user.primary_role}`);

    // 2 + 3. Bypass approval + set primary_role in a single UPDATE.
    // Only touches columns that actually need to change so the audit trail
    // stays honest (updated_at moves only when we change something).
    const patch = {};
    if (user.status !== "active")            patch.status = "active";
    if (user.primary_role !== "admin")       patch.primary_role = "admin";

    if (Object.keys(patch).length > 0) {
      await tx`
        UPDATE users
        SET status        = ${patch.status ?? user.status},
            primary_role  = ${patch.primary_role ?? user.primary_role},
            updated_at    = now()
        WHERE id = ${user.id}
      `;
      const changes = Object.entries(patch)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      console.log(`✓ Updated users row: ${changes}`);
    } else {
      console.log("= Users row already active + admin primary_role. No change.");
    }

    // 4. Ensure the admin role exists (should already, but guard anyway).
    let [role] = await tx`SELECT id, code FROM roles WHERE code = 'admin' LIMIT 1`;
    if (!role) {
      [role] = await tx`
        INSERT INTO roles (code, name, description)
        VALUES ('admin', 'Admin', 'System administrator with full access to the admin console')
        RETURNING id, code
      `;
      console.log(`✓ Created missing 'admin' role (id=${role.id})`);
    }

    // 5. Idempotent role assignment.
    const today = new Date().toISOString().slice(0, 10);
    const [existing] = await tx`
      SELECT id FROM user_role_assignments
      WHERE user_id = ${user.id}
        AND role_id = ${role.id}
        AND (effective_to IS NULL OR effective_to >= ${today})
      LIMIT 1
    `;
    if (existing) {
      console.log(`= Admin role assignment already active (${existing.id}).`);
    } else {
      const [assignment] = await tx`
        INSERT INTO user_role_assignments (user_id, role_id, effective_from)
        VALUES (${user.id}, ${role.id}, ${today})
        RETURNING id
      `;
      console.log(`✓ Inserted admin role assignment (${assignment.id}).`);
    }

    console.log(`\nDone. ${user.email} can sign in and open /admin.`);
    console.log("Tip: if they were already logged in, ask them to sign out + back in so the new role loads.");
  });
} catch (err) {
  if (err.message !== "USER_NOT_FOUND" && err.message !== "USER_DELETED") {
    console.error("✗ Failed:", err.message);
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
