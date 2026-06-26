// Quick inspection — dump every treasurer assignment with the dates the
// trigger looks at, so we can see whether the "old" one was really ended.
//
// Usage:  node scripts/check-treasurer.mjs

import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) { console.error("DATABASE_URL missing"); process.exit(1); }

const sql = postgres(url, { max: 1, prepare: false });

try {
  const rows = await sql`
    SELECT
      ura.id              AS assignment_id,
      u.email,
      u.name,
      r.code              AS role_code,
      r.singleton_per_scope,
      ura.scope_branch_id,
      b.code              AS branch_code,
      ura.effective_from,
      ura.effective_to,
      CASE
        WHEN ura.effective_to IS NULL OR ura.effective_to >= CURRENT_DATE
          THEN 'ACTIVE — blocks the slot'
        ELSE 'ended — should NOT block'
      END                 AS trigger_view,
      CURRENT_DATE        AS today
    FROM user_role_assignments ura
    JOIN roles r        ON r.id = ura.role_id
    JOIN users u        ON u.id = ura.user_id
    LEFT JOIN branches b ON b.id = ura.scope_branch_id
    WHERE r.code = 'branch_treasurer'
    ORDER BY ura.effective_from DESC
  `;

  if (rows.length === 0) {
    console.log("\nNo treasurer assignments at all — assignment should succeed.\n");
  } else {
    console.log(`\nFound ${rows.length} treasurer assignment(s):\n`);
    for (const r of rows) {
      console.log(`  • ${r.email} (${r.name})`);
      console.log(`      assignment: ${r.assignment_id}`);
      console.log(`      branch: ${r.branch_code ?? '(none)'}`);
      console.log(`      from: ${r.effective_from}   to: ${r.effective_to ?? 'NULL (open-ended)'}`);
      console.log(`      today: ${r.today}`);
      console.log(`      trigger view: ${r.trigger_view}\n`);
    }
  }
} catch (err) {
  console.error("✗", err.message);
} finally {
  await sql.end();
}
