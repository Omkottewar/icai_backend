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
// session-level state; the burst-safe ceiling in prod was bumped from 15
// to 40 so a 100-concurrent-registration surge (25th midnight, viral
// event) doesn't queue on the pool. Supabase pooler default cap is ~200,
// so 40 leaves plenty of headroom.
//
// `connection.statement_timeout` (in milliseconds) makes Postgres cancel
// any single statement that runs longer than 15 seconds. This is
// deliberately *shorter* than Supabase's default pooler timeout so we
// own the cancel behaviour — the rejection lands cleanly on the awaiting
// promise inside our request handler's try/catch, rather than arriving
// asynchronously after the socket has been abandoned and becoming an
// unhandledRejection. 15s is well above every legitimate query on this
// codebase (biggest is ~2s for cohort analytics on cold cache) and well
// below Express's 30s request timeout.
const queryClient = postgres(url, {
  max: process.env.NODE_ENV === "production" ? 40 : 10,
  prepare: false, // Supabase transaction pooler does not support prepared statements
  idle_timeout: 20,
  connect_timeout: 10,
  connection: {
    statement_timeout: "15000",
  },
});

// Query logging is opt-in via DEBUG_SQL=1 — by default we stay quiet and
// let errors propagate to the [api error] handler. The per-query "Query:
// ..." spam was drowning out genuine signal in the dev console.
export const db = drizzle(queryClient, { schema, logger: process.env.DEBUG_SQL === "1" });
export type DB = typeof db;
export { schema };
