// One-shot pre-flight check before the 0014 / 0015 migrations.
// Reports row counts and orphan FK candidates so we know what we're touching.
import "dotenv/config";
import postgres from "postgres";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) { console.error("DATABASE_URL missing"); process.exit(1); }
const sql = postgres(url, { max: 1, prepare: false });

const q = (label, text) => sql.unsafe(text).then((rows) => ({ label, rows }));

try {
  const checks = await Promise.all([
    q("consultations rows", "SELECT COUNT(*)::int AS n FROM consultations"),
    q("user_role_assignments scoped to committees", "SELECT COUNT(*)::int AS n FROM user_role_assignments WHERE scope_committee_id IS NOT NULL"),
    q("URA committee orphans (would block FK)",
      "SELECT COUNT(*)::int AS n FROM user_role_assignments ura WHERE ura.scope_committee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM committees c WHERE c.id = ura.scope_committee_id)"),
    q("consultation counselor orphans (would block FK)",
      "SELECT COUNT(*)::int AS n FROM consultations c WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = c.counselor_id)"),
    q("invoices",          "SELECT COUNT(*)::int AS n FROM invoices"),
    q("payment_refunds",   "SELECT COUNT(*)::int AS n FROM payment_refunds"),
    q("payment_disputes",  "SELECT COUNT(*)::int AS n FROM payment_disputes"),
    q("approvals",         "SELECT COUNT(*)::int AS n FROM approvals"),
    q("student_profiles articleship_status distinct values",
      "SELECT articleship_status, COUNT(*)::int AS n FROM student_profiles GROUP BY 1 ORDER BY 1"),
    q("payments with negative amount",
      "SELECT COUNT(*)::int AS n FROM payments WHERE amount_paise < 0"),
  ]);
  for (const c of checks) {
    console.log(c.label.padEnd(60), JSON.stringify(c.rows));
  }
} finally {
  await sql.end();
}
