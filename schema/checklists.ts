import {
  pgTable, uuid, text, integer, timestamp, boolean, jsonb, uniqueIndex, index,
} from "drizzle-orm/pg-core";
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

export const checklistInstanceResponses = pgTable("checklist_instance_responses", {
  id:          uuid("id").primaryKey().defaultRandom(),
  instance_id: uuid("instance_id").notNull().references(() => checklistInstances.id, { onDelete: "cascade" }),
  question_id: uuid("question_id").notNull().references(() => checklistTemplateQuestions.id, { onDelete: "cascade" }),
  value:       jsonb("value"),
  created_at:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  instanceQuestionIdx: uniqueIndex("ux_checklist_responses_instance_question").on(t.instance_id, t.question_id),
}));

// ─── Per-section filler assignments (migration 0035) ────────────────────────
// Optional overlay on top of checklist_instances. Maps each section_heading
// row in the parent template to ONE user who can fill questions inside that
// section. The instance's `assigned_fill_user_id` remains the fallback filler
// and can edit every section regardless — these rows ADD edit rights for
// specific sections, they don't restrict the chairman.
export const checklistInstanceSectionAssignments = pgTable("checklist_instance_section_assignments", {
  id:                   uuid("id").primaryKey().defaultRandom(),
  instance_id:          uuid("instance_id").notNull().references(() => checklistInstances.id, { onDelete: "cascade" }),
  section_question_id:  uuid("section_question_id").notNull().references(() => checklistTemplateQuestions.id, { onDelete: "cascade" }),
  assignee_id:          uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
  created_at:           timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updated_at:           timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  instanceSectionIdx: uniqueIndex("ux_checklist_section_assignments_instance_section").on(t.instance_id, t.section_question_id),
  instanceIdx:        index("idx_checklist_section_assignments_instance").on(t.instance_id),
  assigneeIdx:        index("idx_checklist_section_assignments_assignee").on(t.assignee_id),
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
