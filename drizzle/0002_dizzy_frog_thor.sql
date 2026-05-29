DROP TABLE "magic_links" CASCADE;--> statement-breakpoint
DROP TABLE "mfa_devices" CASCADE;--> statement-breakpoint
DROP TABLE "sessions" CASCADE;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "password_hash";--> statement-breakpoint
DROP TYPE "public"."mfa_type";