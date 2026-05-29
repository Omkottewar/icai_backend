import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../schema";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL (or SUPABASE_URL) must be set in .env");
}

// One connection pool per process. Dev gets 10 too — the branch metrics
// endpoint fires ~15 parallel queries and was queuing behind a 5-slot pool.
// Supabase's transaction pooler allows higher concurrency without
// session-level state.
const queryClient = postgres(url, {
  max: process.env.NODE_ENV === "production" ? 15 : 10,
  prepare: false, // Supabase transaction pooler does not support prepared statements
  idle_timeout: 20,
  connect_timeout: 10,
});

export const db = drizzle(queryClient, { schema, logger: process.env.NODE_ENV !== "production" });
export type DB = typeof db;
export { schema };
