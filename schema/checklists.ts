import {
  pgTable, uuid, text, integer, timestamp, boolean, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import {
  checklistQuestionTypeEnum,
  checklistInstanceStatusEnum,
  checklistInstanceActionEnum,
} from "./enums";
import { users } from "./identity";
import { events } from "./events";

// ─── Generic Checklist Engine ────────────────────────────────────────────────
//
// Two-layer model:
//   templates + template_questions → reusable form definitions
//   instances + responses + reviews → filled copies tied to a context
//
// Templates are immutable once published. Editing a published template forks
// a new version row that shares the same family_id. In-flight instances stay
// pinned to the version they started on, so their question set never shifts.

export const checklistTemplates = pgTable("checklist_templates", {
  id:           uuid("id").primaryKey().defaultRandom(),
  family_id:    uuid("family_id").notNull(),
  version:      integer("version").notNull().default(1),
  name:         text("name").notNull(),
  description:  text("description"),
  category:     text("category"),
  is_published: boolean("is_published").notNull().default(false),
  // Curated, system-supplied template surfaced in the "+ New template"
  // gallery (CPE Seminar, Workshop, Study Circle, Post-Event Bills). Hidden
  // from the main templates list; only readable via /starters, clonable
  // into a user-owned draft. Added in migration 0034.
  is_starter:   boolean("is_starter").notNull().default(false),
  fill_role:    text("fill_role"),
  review_role:  text("review_role"),
  // When non-empty, every released event-bound instance from this template
  // gets one approval stage per listed role code (multi-stage flow). Empty
  // array (default) = original single-reviewer flow, no multi-stage panel.
  // See migration 0065 + ensureApprovalStages() in routes/checklistInstances.ts.
  approver_role_codes: text("approver_role_codes").array().notNull().default(sql`'{}'::text[]`),
  created_by:   uuid("created_by").references(() => users.id),
  created_at:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  published_at: timestamp("published_at", { withTimezone: true }),
  deleted_at:   timestamp("deleted_at", { withTimezone: true }),
}, (t) => ({
  familyVersionIdx: uniqueIndex("ux_checklist_templates_family_version").on(t.family_id, t.version),
  publishedIdx:     index("idx_checklist_templates_published").on(t.is_published),
}));

export const checklistTemplateQuestions = pgTable("checklist_template_questions", {
  id:          uuid("id").primaryKey().defaultRandom(),
  template_id: uuid("template_id").notNull().references(() => checklistTemplates.id, { onDelete: "cascade" }),
  sort_order:  integer("sort_order").notNull().default(0),
  type:        checklistQuestionTypeEnum("type").notNull(),
  label:       text("label").notNull(),
  help_text:   text("help_text"),
  required:    boolean("required").notNull().default(true),
  config:      jsonb("config").notNull().default({}),
  // Only meaningful on 'section_heading' rows. Says "everything between
  // this heading and the next is editable only by users holding this role
  // code". NULL = no restriction (anyone with fill rights can edit).
  // Added in migration 0027.
  section_owner_role: text("section_owner_role"),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  templateSortIdx: index("idx_checklist_template_questions_template_sort").on(t.template_id, t.sort_order),
}));

export const checklistInstances = pgTable("checklist_instances", {
  id:                       uuid("id").primaryKey().defaultRandom(),
  template_id:              uuid("template_id").notNull().references(() => checklistTemplates.id, { onDelete: "restrict" }),
  title:                    text("title").notNull(),
  event_id:                 uuid("event_id").references(() => events.id, { onDelete: "set null" }),
  status:                   checklistInstanceStatusEnum("status").notNull().default("awaiting_fill"),
  assigned_fill_user_id:    uuid("assigned_fill_user_id").references(() => users.id, { onDelete: "set null" }),
  assigned_review_user_id:  uuid("assigned_review_user_id").references(() => users.id, { onDelete: "set null" }),
  notes:                    text("notes"),
  created_by:               uuid("created_by").references(() => users.id),
  created_at:               timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:               timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  submitted_at:             timestamp("submitted_at", { withTimezone: true }),
  reviewed_at:              timestamp("reviewed_at", { withTimezone: true }),
  deleted_at:               timestamp("deleted_at", { withTimezone: true }),
}, (t) => ({
  templateIdx: index("idx_checklist_instances_template").on(t.template_id),
  eventIdx:    index("idx_checklist_instances_event").on(t.event_id),
  statusIdx:   index("idx_checklist_instances_status").on(t.status),
  fillIdx:     index("idx_checklist_instances_fill_user").on(t.assigned_fill_user_id),
}));

// ─── Per-instance questions (migration 0053) ────────────────────────────────
// Each instance gets its own private copy of the question list at creation
// time (cloned from the template). Branch staff can then add / remove /
// re-order / edit questions on this specific instance without affecting the
// template or any other instance. `source_template_question_id` preserves
// the lineage for the legacy backfill and lets the UI tag template-sourced
// items vs event-specific additions.
export const checklistInstanceQuestions = pgTable("checklist_instance_questions", {
  id:                          uuid("id").primaryKey().defaultRandom(),
  instance_id:                 uuid("instance_id").notNull().references(() => checklistInstances.id, { onDelete: "cascade" }),
  sort_order:                  integer("sort_order").notNull().default(0),
  type:                        checklistQuestionTypeEnum("type").notNull(),
  label:                       text("label").notNull(),
  help_text:                   text("help_text"),
  required:                    boolean("required").notNull().default(true),
  config:                      jsonb("config").notNull().default({}),
  section_owner_role:          text("section_owner_role"),
  source_template_question_id: uuid("source_template_question_id").references(() => checklistTemplateQuestions.id, { onDelete: "set null" }),
  created_at:                  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:                  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  instanceSortIdx: index("idx_checklist_instance_questions_instance_sort").on(t.instance_id, t.sort_order),
}));

export const checklistInstanceResponses = pgTable("checklist_instance_responses", {
  id:                   uuid("id").primaryKey().defaultRandom(),
  instance_id:          uuid("instance_id").notNull().references(() => checklistInstances.id, { onDelete: "cascade" }),
  // Legacy column — kept nullable for backward compat during the transition
  // to per-instance questions. New code paths write only instance_question_id.
  question_id:          uuid("question_id").references(() => checklistTemplateQuestions.id, { onDelete: "cascade" }),
  instance_question_id: uuid("instance_question_id").references(() => checklistInstanceQuestions.id, { onDelete: "cascade" }),
  value:                jsonb("value"),
  created_at:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:           timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  instanceQuestionIdx:  uniqueIndex("ux_checklist_responses_instance_question").on(t.instance_id, t.question_id),
  instanceIQuestionIdx: uniqueIndex("ux_checklist_responses_instance_iquestion").on(t.instance_id, t.instance_question_id),
}));

// ─── Per-section filler assignments (migration 0035) ────────────────────────
// Optional overlay on top of checklist_instances. Maps each section_heading
// row in the parent template to ONE user who can fill questions inside that
// section. The instance's `assigned_fill_user_id` remains the fallback filler
// and can edit every section regardless — these rows ADD edit rights for
// specific sections, they don't restrict the chairman.
export const checklistInstanceSectionAssignments = pgTable("checklist_instance_section_assignments", {
  id:                           uuid("id").primaryKey().defaultRandom(),
  instance_id:                  uuid("instance_id").notNull().references(() => checklistInstances.id, { onDelete: "cascade" }),
  // Legacy column — kept nullable for backward compat with migration 0053.
  section_question_id:          uuid("section_question_id").references(() => checklistTemplateQuestions.id, { onDelete: "cascade" }),
  instance_section_question_id: uuid("instance_section_question_id").references(() => checklistInstanceQuestions.id, { onDelete: "cascade" }),
  assignee_id:                  uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
  // Per-section approver added in 0079. NULL means "fall back to the
  // checklist-level assigned_review_user_id". Non-NULL takes over sign-off
  // for this section only.
  approver_id:                  uuid("approver_id").references(() => users.id, { onDelete: "set null" }),
  // Per-section approval state added in 0081. Every section on a submitted
  // instance carries its own decision so multiple approvers can sign off
  // different sections independently. Checklist-level status flips to
  // 'approved' only when every section's approval_status is 'approved'.
  approval_status:              text("approval_status").notNull().default("pending"),
  decided_by:                   uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
  decided_at:                   timestamp("decided_at", { withTimezone: true }),
  note:                         text("note"),
  created_at:                   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:                   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  instanceSectionIdx:  uniqueIndex("ux_checklist_section_assignments_instance_section").on(t.instance_id, t.section_question_id),
  instanceISectionIdx: uniqueIndex("ux_checklist_section_assignments_instance_isection").on(t.instance_id, t.instance_section_question_id),
  instanceIdx:         index("idx_checklist_section_assignments_instance").on(t.instance_id),
  assigneeIdx:         index("idx_checklist_section_assignments_assignee").on(t.assignee_id),
  approverIdx:         index("idx_checklist_section_assignments_approver").on(t.approver_id),
  approvalStatusIdx:   index("idx_checklist_section_assignments_status").on(t.instance_id, t.approval_status),
}));

export const checklistInstanceReviews = pgTable("checklist_instance_reviews", {
  id:          uuid("id").primaryKey().defaultRandom(),
  instance_id: uuid("instance_id").notNull().references(() => checklistInstances.id, { onDelete: "cascade" }),
  actor_id:    uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  action:      checklistInstanceActionEnum("action").notNull(),
  note:        text("note"),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  instanceCreatedIdx: index("idx_checklist_instance_reviews_instance_created").on(t.instance_id, t.created_at),
}));
