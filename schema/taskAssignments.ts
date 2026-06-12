import { pgTable, uuid, text, integer, timestamp, date, index } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { checklistInstanceResponses } from "./checklists";

// ─── Checklist Task Assignments ──────────────────────────────────────────────
//
// One row per task inside a 'task_list' question. The committee chairman
// (or whoever owns the section containing the task_list) adds tasks and
// assigns each to a user; the assignee receives a notification + can mark
// it done independently of the parent checklist's approval flow.
//
// Why a dedicated table when the same data is in the response JSON?
//   1. Query — "show me all open tasks assigned to me" is two indexes away.
//   2. Notifications — we fire 'task_assigned' on insert/update without
//      having to diff JSON blobs.
//   3. Status tracking — the assignee can mark done WITHOUT touching the
//      parent response (which they may not have edit rights on).
//
// The response JSON stays as the canonical "template-shaped" representation
// (preserves order, captures all UI state). Reconciliation happens in the
// PUT /responses endpoint: each save tears down + recreates the task rows
// for that response, so the table reflects current intent.

export const checklistTaskAssignments = pgTable(
  "checklist_task_assignments",
  {
    id:            uuid("id").primaryKey().defaultRandom(),
    response_id:   uuid("response_id").notNull().references(() => checklistInstanceResponses.id, { onDelete: "cascade" }),
    description:   text("description").notNull(),
    assignee_id:   uuid("assignee_id").references(() => users.id, { onDelete: "set null" }),
    due_date:      date("due_date"),
    status:        text("status").notNull().default("pending"),  // pending | done | cancelled
    done_at:       timestamp("done_at", { withTimezone: true }),
    done_by:       uuid("done_by").references(() => users.id, { onDelete: "set null" }),
    notes:         text("notes"),
    sort_order:    integer("sort_order").notNull().default(0),
    created_at:    timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at:    timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("checklist_task_assignments_response_idx").on(t.response_id),
    index("checklist_task_assignments_assignee_idx").on(t.assignee_id),
    index("checklist_task_assignments_status_idx").on(t.status),
  ],
);
