CREATE TYPE "public"."checklist_instance_action" AS ENUM('created', 'assigned', 'submitted', 'approved', 'rejected', 'reopened');--> statement-breakpoint
CREATE TYPE "public"."checklist_instance_status" AS ENUM('awaiting_fill', 'awaiting_review', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."checklist_question_type" AS ENUM('short_text', 'long_text', 'number', 'money', 'date', 'datetime', 'radio', 'dropdown', 'yes_no', 'checkbox', 'rating', 'file', 'section_heading');--> statement-breakpoint
CREATE TABLE "checklist_instance_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"value" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_instance_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" "checklist_instance_action" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"title" text NOT NULL,
	"event_id" uuid,
	"status" "checklist_instance_status" DEFAULT 'awaiting_fill' NOT NULL,
	"assigned_fill_user_id" uuid,
	"assigned_review_user_id" uuid,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"reviewed_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "checklist_template_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"template_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"type" "checklist_question_type" NOT NULL,
	"label" text NOT NULL,
	"help_text" text,
	"required" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"family_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"is_published" boolean DEFAULT false NOT NULL,
	"fill_role" text,
	"review_role" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "checklist_instance_responses" ADD CONSTRAINT "checklist_instance_responses_instance_id_checklist_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."checklist_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_instance_responses" ADD CONSTRAINT "checklist_instance_responses_question_id_checklist_template_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."checklist_template_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_instance_reviews" ADD CONSTRAINT "checklist_instance_reviews_instance_id_checklist_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."checklist_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_instance_reviews" ADD CONSTRAINT "checklist_instance_reviews_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_instances" ADD CONSTRAINT "checklist_instances_template_id_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."checklist_templates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_instances" ADD CONSTRAINT "checklist_instances_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_instances" ADD CONSTRAINT "checklist_instances_assigned_fill_user_id_users_id_fk" FOREIGN KEY ("assigned_fill_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_instances" ADD CONSTRAINT "checklist_instances_assigned_review_user_id_users_id_fk" FOREIGN KEY ("assigned_review_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_instances" ADD CONSTRAINT "checklist_instances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_template_questions" ADD CONSTRAINT "checklist_template_questions_template_id_checklist_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."checklist_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ux_checklist_responses_instance_question" ON "checklist_instance_responses" USING btree ("instance_id","question_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_instance_reviews_instance_created" ON "checklist_instance_reviews" USING btree ("instance_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_checklist_instances_template" ON "checklist_instances" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_instances_event" ON "checklist_instances" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_instances_status" ON "checklist_instances" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_checklist_instances_fill_user" ON "checklist_instances" USING btree ("assigned_fill_user_id");--> statement-breakpoint
CREATE INDEX "idx_checklist_template_questions_template_sort" ON "checklist_template_questions" USING btree ("template_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "ux_checklist_templates_family_version" ON "checklist_templates" USING btree ("family_id","version");--> statement-breakpoint
CREATE INDEX "idx_checklist_templates_published" ON "checklist_templates" USING btree ("is_published");