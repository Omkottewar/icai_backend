import { pgTable, uuid, text, timestamp, uniqueIndex, index, integer } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { checklistInstances } from "./checklists";

// ─── Checklist Instance Approval Stages ──────────────────────────────────────
//
// A checklist_instance can require multiple parallel approvals before its
// status flips to 'approved' (which in turn auto-publishes the linked event).
// Each row here is one named stage — e.g. "branch_chairman", "treasurer_iut",
// "vc_agenda" — that must be approved by a holder of the role.
//
// This implements Section R of the requirements:
//   "admin will prepare the checklist - committee chairman → branch chairman
//    for overall + treasurer for IUT + VC for agenda"
//
// Rules:
//   - Stages are created when an event-bound instance is released (status
//     transitions from 'draft' to 'awaiting_fill'). For non-event instances
//     no stages are created and the single-reviewer model still applies.
//   - Any user holding the `required_role_code` (with branch scope) can
//     decide a stage. Branch chairman can decide ANY stage (override).
//   - Approve / reject is recorded immediately.
//   - The instance status flips to 'approved' only when ALL stages are
//     'approved'. Any 'rejected' stage flips the instance to 'rejected'
//     immediately (matches the "any single approver can send back" rule).
//
// `stage_code` is intentionally text not enum so we can add new stage types
// (e.g. legal review) without a migration. The seed stage codes are:
//   branch_chairman   — overall sign-off
//   treasurer_iut     — budget / IUT review
//   vc_agenda         — agenda review

export const checklistInstanceApprovals = pgTable(
  "checklist_instance_approvals",
  {
    id:                  uuid("id").primaryKey().defaultRandom(),
    instance_id:         uuid("instance_id").notNull().references(() => checklistInstances.id, { onDelete: "cascade" }),
    stage_code:          text("stage_code").notNull(),
    stage_label:         text("stage_label").notNull(),           // human label for the UI
    required_role_code:  text("required_role_code").notNull(),    // e.g. 'branch_chairman'
    sort_order:          integer("sort_order").notNull().default(0),
    status:              text("status").notNull().default("pending"), // pending | approved | rejected
    decided_by:          uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decided_at:          timestamp("decided_at", { withTimezone: true }),
    note:                text("note"),
    created_at:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Set by the escalation cron when it has notified the chairperson about
    // this still-pending stage; NULL = not yet escalated. Lets the cron be
    // idempotent without a separate sent-table.
    escalated_at:        timestamp("escalated_at", { withTimezone: true }),
  },
  (t) => ({
    // One stage per (instance, stage_code) — re-creating the same stage on
    // the same instance is a no-op via ON CONFLICT.
    instanceStageIdx: uniqueIndex("ux_checklist_instance_stage").on(t.instance_id, t.stage_code),
    statusIdx:        index("idx_checklist_instance_approvals_status").on(t.status),
  }),
);
