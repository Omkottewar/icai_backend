import "dotenv/config";
import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL ?? process.env.SUPABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL (or SUPABASE_URL) must be set in .env");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url },
  // Surface diffs in the console when generating; remove if too chatty.
  verbose: true,
  // Always ask before destructive changes (drop column, drop table).
  strict: true,
});
