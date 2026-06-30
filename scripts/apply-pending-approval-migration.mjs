import "dotenv/config";
import fs from "node:fs";
import postgres from "postgres";

const url = process.env.DATABASE_URL || process.env.SUPABASE_URL;
const sql = postgres(url, { ssl: url.includes("supabase") ? "require" : undefined });

const stmt = fs.readFileSync("drizzle/0069_pending_approval_status.sql", "utf8");
await sql.unsafe(stmt);
const r = await sql`SELECT unnest(enum_range(NULL::user_status)) AS v`;
console.log("user_status enum values:", r.map((x) => x.v).join(", "));
await sql.end();
