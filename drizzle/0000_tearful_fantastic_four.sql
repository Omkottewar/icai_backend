CREATE TYPE "public"."application_status" AS ENUM('applied', 'shortlisted', 'interview', 'offered', 'hired', 'rejected', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."approval_stage" AS ENUM('mcm', 'chairman');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."approval_target" AS ENUM('event', 'newsletter', 'circular', 'gallery_album', 'paper_presentation', 'kb_source', 'forum_thread');--> statement-breakpoint
CREATE TYPE "public"."chat_role" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "public"."circular_source" AS ENUM('icai_head', 'branch', 'wirc');--> statement-breakpoint
CREATE TYPE "public"."consultation_kind" AS ENUM('women_counseling', 'career_counseling', 'mentorship');--> statement-breakpoint
CREATE TYPE "public"."consultation_status" AS ENUM('requested', 'confirmed', 'completed', 'cancelled', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."cop_status" AS ENUM('active', 'surrendered', 'restored', 'none');--> statement-breakpoint
CREATE TYPE "public"."cpe_type" AS ENUM('structured', 'unstructured');--> statement-breakpoint
CREATE TYPE "public"."dignitary_role" AS ENUM('president', 'vice_president', 'ccm', 'rcm', 'mc_member');--> statement-breakpoint
CREATE TYPE "public"."dispute_status" AS ENUM('open', 'under_review', 'won', 'lost', 'accepted');--> statement-breakpoint
CREATE TYPE "public"."doc_locker_type" AS ENUM('membership_letter', 'cop_certificate', 'cpe_certificate', 'firm_registration', 'udin_certificate', 'other');--> statement-breakpoint
CREATE TYPE "public"."employer_user_role" AS ENUM('owner', 'poster', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."event_audience" AS ENUM('members', 'students', 'all');--> statement-breakpoint
CREATE TYPE "public"."event_mode" AS ENUM('in_person', 'online', 'hybrid');--> statement-breakpoint
CREATE TYPE "public"."event_status" AS ENUM('draft', 'pending_approval', 'approved', 'published', 'cancelled', 'completed');--> statement-breakpoint
CREATE TYPE "public"."file_scan_status" AS ENUM('pending', 'clean', 'infected', 'error');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('male', 'female', 'other', 'unspecified');--> statement-breakpoint
CREATE TYPE "public"."grievance_status" AS ENUM('open', 'in_review', 'resolved', 'closed');--> statement-breakpoint
CREATE TYPE "public"."home_slot_kind" AS ENUM('banner', 'mc_group_photo', 'branch_premises_photo', 'chairman_photo', 'dignitary_rolling', 'announcement', 'useful_link', 'quick_link', 'upcoming_event_pin');--> statement-breakpoint
CREATE TYPE "public"."kb_ingest_status" AS ENUM('pending', 'chunking', 'embedded', 'indexed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."kb_scope" AS ENUM('public', 'member', 'student', 'employer', 'internal');--> statement-breakpoint
CREATE TYPE "public"."kb_source_type" AS ENUM('uploaded_pdf', 'url', 'internal_doc', 'event_material', 'newsletter', 'circular');--> statement-breakpoint
CREATE TYPE "public"."locale" AS ENUM('en', 'hi', 'mr');--> statement-breakpoint
CREATE TYPE "public"."mfa_type" AS ENUM('totp', 'sms');--> statement-breakpoint
CREATE TYPE "public"."newsletter_status" AS ENUM('draft', 'pending_mcm', 'pending_chairman', 'published');--> statement-breakpoint
CREATE TYPE "public"."notification_channel" AS ENUM('email', 'sms', 'push', 'inapp');--> statement-breakpoint
CREATE TYPE "public"."payment_purpose" AS ENUM('event_registration', 'cop_renewal', 'firm_registration', 'job_posting', 'assignment_posting', 'cabf_donation', 'consultation', 'room_booking', 'other');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('created', 'pending', 'success', 'failed', 'refunded', 'partially_refunded');--> statement-breakpoint
CREATE TYPE "public"."posting_status" AS ENUM('draft', 'pending_payment', 'active', 'filled', 'expired', 'closed');--> statement-breakpoint
CREATE TYPE "public"."posting_type" AS ENUM('job', 'articleship', 'assignment');--> statement-breakpoint
CREATE TYPE "public"."question_status" AS ENUM('pending', 'approved', 'hidden');--> statement-breakpoint
CREATE TYPE "public"."refund_status" AS ENUM('pending', 'processed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."registration_status" AS ENUM('registered', 'waitlisted', 'cancelled', 'attended', 'no_show');--> statement-breakpoint
CREATE TYPE "public"."room_booking_status" AS ENUM('requested', 'confirmed', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."service_request_status" AS ENUM('submitted', 'in_review', 'approved', 'rejected', 'completed');--> statement-breakpoint
CREATE TYPE "public"."service_request_type" AS ENUM('cop_renewal', 'cop_restore', 'cop_surrender', 'firm_registration', 'membership_transfer', 'certificate', 'other');--> statement-breakpoint
CREATE TYPE "public"."standard_family" AS ENUM('AS', 'SA', 'IndAS', 'SQC', 'other');--> statement-breakpoint
CREATE TYPE "public"."student_level" AS ENUM('foundation', 'intermediate', 'final');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('member', 'student', 'employer', 'employee', 'mcm', 'chairman', 'admin');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'inactive', 'suspended');--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"city" text NOT NULL,
	"state" text NOT NULL,
	"region_code" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branches_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "employer_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employer_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "employer_user_role" DEFAULT 'poster' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_name" text NOT NULL,
	"gstin" text,
	"pan" text,
	"verified" boolean DEFAULT false NOT NULL,
	"website" text,
	"address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "magic_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"user_id" uuid,
	"scope_type" text,
	"scope_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "magic_links_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "member_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"mrn" text NOT NULL,
	"is_fca" boolean DEFAULT false NOT NULL,
	"cop_status" "cop_status" DEFAULT 'none' NOT NULL,
	"cop_number" text,
	"is_practising" boolean DEFAULT false NOT NULL,
	"gender" "gender" DEFAULT 'unspecified' NOT NULL,
	"member_since" date,
	"areas_of_practice" text[],
	"address" text,
	"city" text,
	"pincode" text,
	"kym_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "member_profiles_mrn_unique" UNIQUE("mrn")
);
--> statement-breakpoint
CREATE TABLE "mfa_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "mfa_type" NOT NULL,
	"secret_encrypted" text,
	"phone" text,
	"label" text,
	"verified" boolean DEFAULT false NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"user_agent" text,
	"ip" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "student_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"srn" text NOT NULL,
	"level" "student_level" NOT NULL,
	"articleship_status" text,
	"articleship_start" date,
	"principal_member_id" uuid,
	"exam_attempts" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "student_profiles_srn_unique" UNIQUE("srn")
);
--> statement-breakpoint
CREATE TABLE "user_role_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"scope_committee_id" uuid,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"phone" text,
	"primary_role" "user_role" NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"locale" "locale" DEFAULT 'en' NOT NULL,
	"avatar_id" uuid,
	"branch_id" uuid,
	"password_hash" text,
	"last_login_at" timestamp with time zone,
	"notify_email" boolean DEFAULT true NOT NULL,
	"notify_sms" boolean DEFAULT false NOT NULL,
	"notify_push" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invoice_no" text NOT NULL,
	"payment_id" uuid NOT NULL,
	"payer_user_id" uuid,
	"amount_paise" integer NOT NULL,
	"taxable_amount_paise" integer NOT NULL,
	"gst_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"cgst_paise" integer DEFAULT 0 NOT NULL,
	"sgst_paise" integer DEFAULT 0 NOT NULL,
	"igst_paise" integer DEFAULT 0 NOT NULL,
	"billing_name" text NOT NULL,
	"billing_address" text,
	"billing_gstin" text,
	"pan" text,
	"financial_year" text NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cancelled_at" timestamp with time zone,
	"cancellation_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_invoice_no_unique" UNIQUE("invoice_no")
);
--> statement-breakpoint
CREATE TABLE "payment_disputes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"razorpay_dispute_id" text NOT NULL,
	"amount_paise" integer NOT NULL,
	"reason" text NOT NULL,
	"status" "dispute_status" DEFAULT 'open' NOT NULL,
	"respond_by" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"response_note" text,
	"resolution" text,
	"assigned_to" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_disputes_razorpay_dispute_id_unique" UNIQUE("razorpay_dispute_id")
);
--> statement-breakpoint
CREATE TABLE "payment_refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"razorpay_refund_id" text,
	"amount_paise" integer NOT NULL,
	"reason" text,
	"status" "refund_status" DEFAULT 'pending' NOT NULL,
	"initiated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "payment_refunds_razorpay_refund_id_unique" UNIQUE("razorpay_refund_id")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payer_user_id" uuid,
	"amount_paise" integer NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" "payment_status" DEFAULT 'created' NOT NULL,
	"purpose" "payment_purpose" NOT NULL,
	"ref_type" text,
	"ref_id" uuid,
	"razorpay_order_id" text,
	"razorpay_payment_id" text,
	"razorpay_signature" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "payments_razorpay_order_id_unique" UNIQUE("razorpay_order_id")
);
--> statement-breakpoint
CREATE TABLE "cpe_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_id" uuid,
	"hours" numeric(4, 1) NOT NULL,
	"type" "cpe_type" NOT NULL,
	"year" integer NOT NULL,
	"source" text,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"certificate_file_id" uuid,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "event_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "registration_status" DEFAULT 'registered' NOT NULL,
	"payment_id" uuid,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attended_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"committee_id" uuid NOT NULL,
	"branch_id" uuid,
	"audience" "event_audience" DEFAULT 'members' NOT NULL,
	"mode" "event_mode" DEFAULT 'in_person' NOT NULL,
	"venue" text,
	"online_url" text,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"cpe_hours" numeric(4, 1) DEFAULT '0' NOT NULL,
	"fee_paise" integer DEFAULT 0 NOT NULL,
	"capacity" integer,
	"registered_count" integer DEFAULT 0 NOT NULL,
	"status" "event_status" DEFAULT 'draft' NOT NULL,
	"banner_id" uuid,
	"recurrence_parent_id" uuid,
	"recurrence_rrule" text,
	"highlights" text[],
	"program_type" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "events_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "firms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"registration_no" text NOT NULL,
	"email" text,
	"phone" text,
	"website" text,
	"address" text,
	"city" text,
	"pincode" text,
	"gstin" text,
	"partners_count" integer DEFAULT 0 NOT NULL,
	"areas_of_expertise" text[],
	"verified" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "firms_registration_no_unique" UNIQUE("registration_no")
);
--> statement-breakpoint
CREATE TABLE "job_postings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "posting_type" NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"poster_user_id" uuid NOT NULL,
	"employer_id" uuid,
	"firm_id" uuid,
	"seat_count" integer DEFAULT 1 NOT NULL,
	"experience_required" text,
	"location" text,
	"fee_paise" integer DEFAULT 0 NOT NULL,
	"payment_id" uuid,
	"status" "posting_status" DEFAULT 'draft' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" "approval_target" NOT NULL,
	"target_id" uuid NOT NULL,
	"stage" "approval_stage" NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"submitted_by" uuid,
	"reviewed_by" uuid,
	"comments" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "room_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"room_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"slot_start" timestamp with time zone NOT NULL,
	"slot_end" timestamp with time zone NOT NULL,
	"purpose" text,
	"status" "room_booking_status" DEFAULT 'requested' NOT NULL,
	"payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cabf_assistance_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"member_user_id" uuid NOT NULL,
	"category" text NOT NULL,
	"amount_requested_paise" integer NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"reviewer_user_id" uuid,
	"decision_note" text,
	"disbursed_amount_paise" integer,
	"disbursed_at" timestamp with time zone,
	"disbursement_payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consultations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"counselor_id" uuid NOT NULL,
	"client_user_id" uuid NOT NULL,
	"kind" "consultation_kind" NOT NULL,
	"slot_start" timestamp with time zone NOT NULL,
	"slot_end" timestamp with time zone NOT NULL,
	"status" "consultation_status" DEFAULT 'requested' NOT NULL,
	"medium" text DEFAULT 'video' NOT NULL,
	"notes_encrypted" text,
	"feedback_rating" integer,
	"payment_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employer_users" ADD CONSTRAINT "employer_users_employer_id_employers_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."employers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employer_users" ADD CONSTRAINT "employer_users_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "magic_links" ADD CONSTRAINT "magic_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_profiles" ADD CONSTRAINT "member_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mfa_devices" ADD CONSTRAINT "mfa_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_links" ADD CONSTRAINT "oauth_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_profiles" ADD CONSTRAINT "student_profiles_principal_member_id_users_id_fk" FOREIGN KEY ("principal_member_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role_assignments" ADD CONSTRAINT "user_role_assignments_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_refunds" ADD CONSTRAINT "payment_refunds_initiated_by_users_id_fk" FOREIGN KEY ("initiated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_payer_user_id_users_id_fk" FOREIGN KEY ("payer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cpe_credits" ADD CONSTRAINT "cpe_credits_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cpe_credits" ADD CONSTRAINT "cpe_credits_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_registrations" ADD CONSTRAINT "event_registrations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_poster_user_id_users_id_fk" FOREIGN KEY ("poster_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_employer_id_employers_id_fk" FOREIGN KEY ("employer_id") REFERENCES "public"."employers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_firm_id_firms_id_fk" FOREIGN KEY ("firm_id") REFERENCES "public"."firms"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_bookings" ADD CONSTRAINT "room_bookings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "room_bookings" ADD CONSTRAINT "room_bookings_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cabf_assistance_requests" ADD CONSTRAINT "cabf_assistance_requests_member_user_id_users_id_fk" FOREIGN KEY ("member_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cabf_assistance_requests" ADD CONSTRAINT "cabf_assistance_requests_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cabf_assistance_requests" ADD CONSTRAINT "cabf_assistance_requests_disbursement_payment_id_payments_id_fk" FOREIGN KEY ("disbursement_payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_client_user_id_users_id_fk" FOREIGN KEY ("client_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consultations" ADD CONSTRAINT "consultations_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE set null ON UPDATE no action;