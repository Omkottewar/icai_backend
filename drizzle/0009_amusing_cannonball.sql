ALTER TABLE "invoices" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_disputes" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "payment_refunds" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "approvals" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "invoices" CASCADE;--> statement-breakpoint
DROP TABLE "payment_disputes" CASCADE;--> statement-breakpoint
DROP TABLE "payment_refunds" CASCADE;--> statement-breakpoint
DROP TABLE "approvals" CASCADE;--> statement-breakpoint
ALTER TABLE "student_profiles" ALTER COLUMN "articleship_status" SET DATA TYPE articleship_status;--> statement-breakpoint
ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_scope_committee_id_committees_id_fk" FOREIGN KEY ("scope_committee_id") REFERENCES "public"."committees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_avatar_id_files_id_fk" FOREIGN KEY ("avatar_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cpe_credits" ADD CONSTRAINT "cpe_credits_certificate_file_id_files_id_fk" FOREIGN KEY ("certificate_file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_banner_id_files_id_fk" FOREIGN KEY ("banner_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_bookings" ADD CONSTRAINT "room_bookings_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_counselor_id_users_id_fk" FOREIGN KEY ("counselor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
DROP TYPE "public"."approval_stage";--> statement-breakpoint
DROP TYPE "public"."approval_status";--> statement-breakpoint
DROP TYPE "public"."approval_target";--> statement-breakpoint
DROP TYPE "public"."dispute_status";--> statement-breakpoint
DROP TYPE "public"."refund_status";