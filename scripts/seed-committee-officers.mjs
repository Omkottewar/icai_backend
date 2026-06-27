// Demo-mode role seeder. Runs after `npm run seed:mock` to populate the
// singleton officer slots that the base mock seed deliberately leaves
// empty (so they can be promoted to real members later).
//
// Two passes:
//   1. Four branch officers (chairman, vice-chairman, secretary, treasurer)
//      — each branch-scoped, singleton-per-scope, picked from the mock
//      MCM pool.
//   2. One committee chairman per committee — committee-scoped,
//      singleton-per-committee. The DB trigger
//      `enforce_committee_chairman_is_mcm()` requires the holder to
//      already have an active `mcm` role, which our pool of candidates
//      satisfies by construction.
//
// After this runs, the EventsAdminPage "Who fills each section?" dialog
// shows real Committee Chairman badges in the filler dropdown, and the
// approver dropdown shows the Branch Chairman + Treasurer.
//
// (WICASA chair/vice-chair aren't in the role taxonomy — they're managed
//  via the office_bearers table only. If/when those roles are added to
//  migration 0003, append their codes to SINGLETON_ROLES below.)
//
// Targets MOCK users only (email LIKE 'mock+%@icai-nagpur.local') so this
// can't accidentally collide with real members. Idempotent — re-running
// skips slots that are already filled.
//
// Usage:  node scripts/seed-committee-officers.mjs
// Cleanup: use scripts/free-mock-singleton-roles.mjs to reverse (handy
//          when promoting a real user into one of these slots later).

import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  console.error("DATABASE_URL (or SUPABASE_URL) missing from .env");
  process.exit(1);
}

const SINGLETON_ROLES = [
  "branch_chairman",
  "branch_vice_chairman",
  "branch_secretary",
  "branch_treasurer",
];

const sql = postgres(url, { max: 1, prepare: false });

try {
  // 1. Resolve the Nagpur branch — singleton roles are branch-scoped, so
  //    every assignment carries this branch's id.
  const [branch] = await sql`
    SELECT id, name FROM branches
    WHERE code = 'NGP' OR lower(name) LIKE '%nagpur%'
    ORDER BY active DESC
    LIMIT 1
  `;
  if (!branch) {
    console.error("✗ Nagpur branch not found. Run the base migrations / seed first.");
    process.exit(1);
  }
  console.log(`→ Branch: ${branch.name} (${branch.id})`);

  // 2. Pull the roles we'll assign — we'll need their ids for the FK.
  const roleRows = await sql`SELECT id, code FROM roles WHERE code = ANY(${SINGLETON_ROLES})`;
  const roleByCode = new Map(roleRows.map((r) => [r.code, r]));
  for (const code of SINGLETON_ROLES) {
    if (!roleByCode.has(code)) {
      console.error(`✗ Role ${code} missing from the roles table — apply migration 0003 first.`);
      process.exit(1);
    }
  }

  // 3. Find the existing MCM pool. The DB trigger
  //    enforce_committee_chairman_is_mcm() doesn't fire for branch_chairman
  //    (only committee_chairman), but we still want each officer to hold
  //    mcm too so they show up under both filters and the "Member /
  //    Managing Committee" badge is consistent.
  const [mcmRole] = await sql`SELECT id FROM roles WHERE code = 'mcm'`;

  const mcmHolders = await sql`
    SELECT u.id, u.name, u.email
    FROM users u
    JOIN user_role_assignments ura ON ura.user_id = u.id
    JOIN roles r ON r.id = ura.role_id
    WHERE r.code = 'mcm'
      AND u.email LIKE 'mock+%@icai-nagpur.local'
      AND u.deleted_at IS NULL
      AND (ura.effective_to IS NULL OR ura.effective_to >= CURRENT_DATE)
    ORDER BY u.name
  `;
  if (mcmHolders.length < SINGLETON_ROLES.length) {
    console.error(
      `✗ Only ${mcmHolders.length} mock MCM users available; need at least ${SINGLETON_ROLES.length}. ` +
      `Re-run \`npm run seed:mock\` to repopulate the pool.`,
    );
    process.exit(1);
  }

  // 4. For each role: skip if the slot is already filled, otherwise pick
  //    the next unassigned mock MCM user and assign them.
  const usedUserIds = new Set();
  let filled = 0;
  let already = 0;

  for (const code of SINGLETON_ROLES) {
    const role = roleByCode.get(code);

    // Is the slot already filled (by anyone, real or mock)?
    const [existing] = await sql`
      SELECT u.email, u.name, ura.id AS assignment_id
      FROM user_role_assignments ura
      JOIN users u ON u.id = ura.user_id
      WHERE ura.role_id = ${role.id}
        AND ura.scope_branch_id = ${branch.id}
        AND (ura.effective_to IS NULL OR ura.effective_to >= CURRENT_DATE)
      LIMIT 1
    `;
    if (existing) {
      console.log(`= ${code.padEnd(24)} already held by ${existing.name} (${existing.email})`);
      usedUserIds.add(existing.assignment_id); // ensure we don't re-use the user
      already++;
      continue;
    }

    // Pick the next mock MCM user we haven't used yet.
    const candidate = mcmHolders.find((u) => !usedUserIds.has(u.id));
    if (!candidate) {
      console.error(`✗ Ran out of unique MCM holders before reaching ${code}. Increase the mock seed pool.`);
      break;
    }
    usedUserIds.add(candidate.id);

    await sql`
      INSERT INTO user_role_assignments
        (user_id, role_id, scope_branch_id, effective_from)
      VALUES
        (${candidate.id}, ${role.id}, ${branch.id}, CURRENT_DATE)
    `;
    console.log(`+ ${code.padEnd(24)} → ${candidate.name} (${candidate.email})`);
    filled++;
  }

  console.log(`\n→ Branch officers: ${filled} new assignment${filled === 1 ? "" : "s"}, ${already} already in place.`);

  // ─── 5. Committee Chairmen ────────────────────────────────────────────
  // One per committee. Each chairman must hold an active `mcm` role (DB
  // trigger), which our pool satisfies. We don't reuse a user across two
  // committee chairs — branches are small enough that one person = one
  // committee.
  const committees = await sql`SELECT id, code, name FROM committees WHERE active = true ORDER BY name`;
  const ccRole = await sql`SELECT id FROM roles WHERE code = 'committee_chairman'`;
  if (!ccRole[0]) {
    console.warn("⚠ committee_chairman role missing — skipping committee chair seeding.");
  } else if (committees.length === 0) {
    console.warn("⚠ No active committees found — run `node scripts/seed-committees-nagpur.mjs` first.");
  } else {
    let ccFilled = 0;
    let ccAlready = 0;
    for (const committee of committees) {
      // Slot already filled?
      const [existing] = await sql`
        SELECT u.name, u.email
        FROM user_role_assignments ura
        JOIN users u ON u.id = ura.user_id
        WHERE ura.role_id = ${ccRole[0].id}
          AND ura.scope_committee_id = ${committee.id}
          AND (ura.effective_to IS NULL OR ura.effective_to >= CURRENT_DATE)
        LIMIT 1
      `;
      if (existing) {
        console.log(`= ${committee.code.padEnd(14)} chairman already: ${existing.name}`);
        ccAlready++;
        continue;
      }

      const candidate = mcmHolders.find((u) => !usedUserIds.has(u.id));
      if (!candidate) {
        console.warn(`⚠ Out of unique MCM holders before ${committee.code}. Re-run \`npm run seed:mock\` with a larger pool.`);
        break;
      }
      usedUserIds.add(candidate.id);

      try {
        await sql`
          INSERT INTO user_role_assignments
            (user_id, role_id, scope_committee_id, effective_from)
          VALUES
            (${candidate.id}, ${ccRole[0].id}, ${committee.id}, CURRENT_DATE)
        `;
        console.log(`+ ${committee.code.padEnd(14)} → ${candidate.name} (Committee Chairman)`);
        ccFilled++;
      } catch (e) {
        // Trigger / FK guards may reject some combinations; report and continue.
        console.warn(`⚠ ${committee.code}: ${e.message}`);
      }
    }
    console.log(`\n→ Committee chairmen: ${ccFilled} new, ${ccAlready} already in place.`);
  }

  console.log("\n✓ Done. These users will now appear in the checklist filler / approver pickers");
  console.log("  with their officer-role badge (Branch Chairman, Treasurer, Committee Chairman, etc.).");
  void mcmRole; // referenced for readability above; ESLint-friendly noop
} catch (err) {
  console.error("✗ Failed:", err.message);
  process.exitCode = 1;
} finally {
  await sql.end();
}
