// One-shot: grant the 'admin' role to a user by email.
// Usage: npx tsx scripts/grant-admin.mjs <email>
import "dotenv/config";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/client.ts";
import { users, roles, userRoleAssignments } from "../schema/index.ts";

const email = (process.argv[2] || "").trim().toLowerCase();
if (!email) {
  console.error("Usage: npx tsx scripts/grant-admin.mjs <email>");
  process.exit(1);
}

const [user] = await db.select().from(users).where(eq(sql`lower(${users.email})`, email));
if (!user) {
  console.error(`No user found with email: ${email}`);
  process.exit(2);
}
console.log(`Found user: ${user.email}  id=${user.id}  primary_role=${user.primary_role}`);

const [adminRole] = await db.select().from(roles).where(eq(roles.code, "admin"));
if (!adminRole) {
  console.error("No 'admin' role row exists in the roles table. Run migrations first.");
  process.exit(3);
}
console.log(`Found admin role: id=${adminRole.id}  scope=${adminRole.scope}`);

const existing = await db.select().from(userRoleAssignments).where(and(
  eq(userRoleAssignments.user_id, user.id),
  eq(userRoleAssignments.role_id, adminRole.id),
));
if (existing.length > 0) {
  console.log("✓ User already has the admin role. No change.");
} else {
  await db.insert(userRoleAssignments).values({
    user_id: user.id,
    role_id: adminRole.id,
    effective_from: new Date().toISOString().slice(0, 10),
  });
  console.log("✓ Granted admin role.");
}

// Update primary_role for UI hints (sidebar lands on admin, etc.).
if (user.primary_role !== "admin") {
  await db.update(users).set({ primary_role: "admin" }).where(eq(users.id, user.id));
  console.log(`✓ Updated primary_role: ${user.primary_role} → admin`);
} else {
  console.log("✓ primary_role already 'admin'.");
}

console.log("\nDone. The user must log out + log back in for the new role to take effect.");
process.exit(0);
