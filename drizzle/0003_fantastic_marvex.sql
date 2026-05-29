CREATE TYPE "public"."role_scope" AS ENUM('global', 'branch', 'committee');--> statement-breakpoint
ALTER TYPE "public"."user_role" ADD VALUE 'staff';--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "scope" "role_scope" DEFAULT 'global' NOT NULL;--> statement-breakpoint
ALTER TABLE "roles" ADD COLUMN "singleton_per_scope" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_role_assignments" ADD COLUMN "scope_branch_id" uuid;--> statement-breakpoint
ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_scope_branch_id_branches_id_fk" FOREIGN KEY ("scope_branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;