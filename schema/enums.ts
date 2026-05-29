import { pgEnum } from "drizzle-orm/pg-core";

export const userRoleEnum = pgEnum("user_role", [
  "member", "student", "employer", "employee", "mcm", "chairman", "admin", "staff",
]);

export const roleScopeEnum = pgEnum("role_scope", [
  "global", "branch", "committee",
]);

export const eventChecklistStatusEnum = pgEnum("event_checklist_status", [
  "awaiting_committee", "awaiting_branch_review", "approved",
]);

export const eventChecklistItemKindEnum = pgEnum("event_checklist_item_kind", [
  "money", "number", "text", "date",
]);

export const eventChecklistActionEnum = pgEnum("event_checklist_action", [
  "created", "sent_to_committee", "submitted_for_review", "approved", "rejected",
]);

export const forumThreadTagEnum = pgEnum("forum_thread_tag", [
  "doubt", "suggestion", "announcement", "discussion", "resource_request",
]);

export const userStatusEnum = pgEnum("user_status", [
  "active", "inactive", "suspended",
]);

export const localeEnum = pgEnum("locale", ["en", "hi", "mr"]);

export const genderEnum = pgEnum("gender", [
  "male", "female", "other", "unspecified",
]);

export const studentLevelEnum = pgEnum("student_level", [
  "foundation", "intermediate", "final",
]);

export const copStatusEnum = pgEnum("cop_status", [
  "active", "surrendered", "restored", "none",
]);

export const employerUserRoleEnum = pgEnum("employer_user_role", [
  "owner", "poster", "viewer",
]);

export const approvalStageEnum = pgEnum("approval_stage", ["mcm", "chairman"]);

export const approvalStatusEnum = pgEnum("approval_status", [
  "pending", "approved", "rejected",
]);

export const approvalTargetEnum = pgEnum("approval_target", [
  "event", "newsletter", "circular", "gallery_album",
  "paper_presentation", "kb_source", "forum_thread",
]);

export const refundStatusEnum = pgEnum("refund_status", [
  "pending", "processed", "failed",
]);

export const disputeStatusEnum = pgEnum("dispute_status", [
  "open", "under_review", "won", "lost", "accepted",
]);

export const paymentStatusEnum = pgEnum("payment_status", [
  "created", "pending", "success", "failed", "refunded", "partially_refunded",
]);

export const paymentPurposeEnum = pgEnum("payment_purpose", [
  "event_registration", "cop_renewal", "firm_registration", "job_posting",
  "assignment_posting", "cabf_donation", "consultation", "room_booking", "other",
]);

export const eventAudienceEnum = pgEnum("event_audience", [
  "members", "students", "all",
]);

export const eventModeEnum = pgEnum("event_mode", [
  "in_person", "online", "hybrid",
]);

export const eventStatusEnum = pgEnum("event_status", [
  "draft", "pending_approval", "approved", "published", "cancelled", "completed",
]);

export const registrationStatusEnum = pgEnum("registration_status", [
  "registered", "waitlisted", "cancelled", "attended", "no_show",
]);

export const cpeTypeEnum = pgEnum("cpe_type", ["structured", "unstructured"]);

export const postingTypeEnum = pgEnum("posting_type", [
  "job", "articleship", "assignment",
]);

export const postingStatusEnum = pgEnum("posting_status", [
  "draft", "pending_payment", "active", "filled", "expired", "closed",
]);

export const applicationStatusEnum = pgEnum("application_status", [
  "applied", "shortlisted", "interview", "offered", "hired", "rejected", "withdrawn",
]);

export const newsletterStatusEnum = pgEnum("newsletter_status", [
  "draft", "pending_mcm", "pending_chairman", "published",
]);

export const circularSourceEnum = pgEnum("circular_source", [
  "icai_head", "branch", "wirc",
]);

export const standardFamilyEnum = pgEnum("standard_family", [
  "AS", "SA", "IndAS", "SQC", "other",
]);

export const serviceRequestTypeEnum = pgEnum("service_request_type", [
  "cop_renewal", "cop_restore", "cop_surrender", "firm_registration",
  "membership_transfer", "certificate", "other",
]);

export const serviceRequestStatusEnum = pgEnum("service_request_status", [
  "submitted", "in_review", "approved", "rejected", "completed",
]);

export const grievanceStatusEnum = pgEnum("grievance_status", [
  "open", "in_review", "resolved", "closed",
]);

export const docLockerTypeEnum = pgEnum("doc_locker_type", [
  "membership_letter", "cop_certificate", "cpe_certificate",
  "firm_registration", "udin_certificate", "other",
]);

export const consultationKindEnum = pgEnum("consultation_kind", [
  "women_counseling", "career_counseling", "mentorship",
]);

export const consultationStatusEnum = pgEnum("consultation_status", [
  "requested", "confirmed", "completed", "cancelled", "no_show",
]);

export const roomBookingStatusEnum = pgEnum("room_booking_status", [
  "requested", "confirmed", "completed", "cancelled",
]);

export const notificationChannelEnum = pgEnum("notification_channel", [
  "email", "sms", "push", "inapp",
]);

export const questionStatusEnum = pgEnum("question_status", [
  "pending", "approved", "hidden",
]);

export const kbSourceTypeEnum = pgEnum("kb_source_type", [
  "uploaded_pdf", "url", "internal_doc", "event_material", "newsletter", "circular",
]);

export const kbScopeEnum = pgEnum("kb_scope", [
  "public", "member", "student", "employer", "internal",
]);

export const kbIngestStatusEnum = pgEnum("kb_ingest_status", [
  "pending", "chunking", "embedded", "indexed", "failed",
]);

export const chatRoleEnum = pgEnum("chat_role", ["user", "assistant", "system"]);

export const fileScanStatusEnum = pgEnum("file_scan_status", [
  "pending", "clean", "infected", "error",
]);

export const homeSlotKindEnum = pgEnum("home_slot_kind", [
  "banner", "mc_group_photo", "branch_premises_photo", "chairman_photo",
  "dignitary_rolling", "announcement", "useful_link", "quick_link",
  "upcoming_event_pin",
]);

export const dignitaryRoleEnum = pgEnum("dignitary_role", [
  "president", "vice_president", "ccm", "rcm", "mc_member",
]);
