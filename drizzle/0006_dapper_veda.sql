-- 0006_dapper_veda.sql
--
-- Drizzle generated this file with several "missing" tables (forum, site_*)
-- that actually exist in the live DB — drizzle's migration journal had drifted
-- because earlier schema changes were applied directly via Supabase SQL Editor.
--
-- Manually trimmed to keep ONLY the genuinely new objects: the announcements
-- table + its two indexes. CREATE … IF NOT EXISTS makes the file idempotent
-- so re-running is harmless.

CREATE TABLE IF NOT EXISTS "announcements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid,
	"title" text NOT NULL,
	"body" text,
	"link_url" text,
	"audience" text DEFAULT 'all' NOT NULL,
	"starts_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'announcements_branch_id_branches_id_fk'
  ) THEN
    ALTER TABLE "announcements"
      ADD CONSTRAINT "announcements_branch_id_branches_id_fk"
      FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id")
      ON DELETE cascade ON UPDATE no action;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'announcements_created_by_users_id_fk'
  ) THEN
    ALTER TABLE "announcements"
      ADD CONSTRAINT "announcements_created_by_users_id_fk"
      FOREIGN KEY ("created_by") REFERENCES "public"."users"("id")
      ON DELETE set null ON UPDATE no action;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "announcements_window_idx" ON "announcements" USING btree ("starts_at","ends_at");
CREATE INDEX IF NOT EXISTS "announcements_branch_idx" ON "announcements" USING btree ("branch_id");
