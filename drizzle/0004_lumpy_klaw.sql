CREATE TYPE "public"."event_checklist_action" AS ENUM('created', 'sent_to_committee', 'submitted_for_review', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."event_checklist_item_kind" AS ENUM('money', 'number', 'text', 'date');--> statement-breakpoint
CREATE TYPE "public"."event_checklist_status" AS ENUM('awaiting_committee', 'awaiting_branch_review', 'approved');--> statement-breakpoint
CREATE TABLE "event_checklist_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"checklist_id" uuid NOT NULL,
	"label" text NOT NULL,
	"kind" "event_checklist_item_kind" DEFAULT 'text' NOT NULL,
	"value" text,
	"required" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_checklist_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"checklist_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" "event_checklist_action" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_checklists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"status" "event_checklist_status" DEFAULT 'awaiting_committee' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "event_checklists_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
ALTER TABLE "event_checklist_items" ADD CONSTRAINT "event_checklist_items_checklist_id_event_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."event_checklists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_checklist_reviews" ADD CONSTRAINT "event_checklist_reviews_checklist_id_event_checklists_id_fk" FOREIGN KEY ("checklist_id") REFERENCES "public"."event_checklists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_checklist_reviews" ADD CONSTRAINT "event_checklist_reviews_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_checklists" ADD CONSTRAINT "event_checklists_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_checklists" ADD CONSTRAINT "event_checklists_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;