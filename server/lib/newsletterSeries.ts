// Newsletter series: the Branch monthly e-newsletter and the WICASA
// (student wing) newsletter. `part` lets one month hold several issues
// (e.g. WICASA's weekly "Udaan" parts); 0 = a single monthly issue.
// Columns are added on first use (also migration 0111).

import { sql } from "drizzle-orm";
import { db } from "../../db/client.js";

export const NEWSLETTER_SERIES = ["branch", "wicasa"] as const;
export type NewsletterSeries = (typeof NEWSLETTER_SERIES)[number];

let ready: Promise<void> | null = null;
export function ensureNewsletterSeries(): Promise<void> {
  ready ??= db.execute(sql.raw(`
    ALTER TABLE "branch_newsletters" ADD COLUMN IF NOT EXISTS "series" text NOT NULL DEFAULT 'branch';
    ALTER TABLE "branch_newsletters" ADD COLUMN IF NOT EXISTS "part" integer NOT NULL DEFAULT 0;
    DROP INDEX IF EXISTS "branch_newsletters_issue_uq";
    CREATE UNIQUE INDEX IF NOT EXISTS "branch_newsletters_series_issue_uq"
      ON "branch_newsletters" ("series", "issue_year", "issue_month", "part");
  `)).then(() => undefined).catch((e) => { ready = null; throw e; });
  return ready;
}
