import "dotenv/config";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL ?? process.env.SUPABASE_URL, { max: 1, prepare: false });
try {
  const rows = await sql`SELECT code, name FROM committees ORDER BY code`;
  for (const r of rows) console.log(r.code, "—", r.name);
} finally {
  await sql.end();
}
