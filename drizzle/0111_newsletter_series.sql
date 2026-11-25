-- Newsletter series (branch / wicasa) and part number, so the WICASA
-- student newsletter and weekly parts can sit alongside the Branch issue
-- for the same month. Also applied on first use by server/lib/newsletterSeries.ts.
ALTER TABLE "branch_newsletters" ADD COLUMN IF NOT EXISTS "series" text NOT NULL DEFAULT 'branch';
ALTER TABLE "branch_newsletters" ADD COLUMN IF NOT EXISTS "part" integer NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS "branch_newsletters_issue_uq";
CREATE UNIQUE INDEX IF NOT EXISTS "branch_newsletters_series_issue_uq"
  ON "branch_newsletters" ("series", "issue_year", "issue_month", "part");
