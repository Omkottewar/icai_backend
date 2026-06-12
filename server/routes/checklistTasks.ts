import { Router } from "express";
import { aliasedTable, and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  checklistTaskAssignments,
  checklistInstanceResponses,
  checklistInstances,
  checklistTemplates,
  checklistTemplateQuestions,
  events,
  users,
} from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { loadUserPermissions } from "../auth/permissions.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";

// ─── Task assignment endpoints ────────────────────────────────────────────
//
// These let the assignee (not the checklist owner) act on their own task
// without needing fill-rights on the parent checklist. Use cases:
//
//   • Sanju, after designing the banner, marks his banner-design task done
//     even though he's not the committee chair.
//   • The committee chair cancels a task that's no longer needed.
//
// We keep the canonical task list inside the response JSON; these endpoints
// only sync the dedicated table's status fields. The next PUT /responses
// from the chair will overwrite — but if she didn't touch the row, the
// status changes here survive.

export const checklistTasksRouter = Router();
checklistTasksRouter.use(requireUser);

async function loadTask(id: string) {
  const [row] = await db
    .select({
      task:         checklistTaskAssignments,
      response_id:  checklistInstanceResponses.id,
      instance_id:  checklistInstances.id,
      instance_status: checklistInstances.status,
      template_fill_role: checklistTemplates.fill_role,
      assigned_fill_user_id: checklistInstances.assigned_fill_user_id,
    })
    .from(checklistTaskAssignments)
    .innerJoin(checklistInstanceResponses, eq(checklistInstanceResponses.id, checklistTaskAssignments.response_id))
    .innerJoin(checklistInstances, eq(checklistInstances.id, checklistInstanceResponses.instance_id))
    .leftJoin(checklistTemplates, eq(checklistTemplates.id, checklistInstances.template_id))
    .where(eq(checklistTaskAssignments.id, id))
    .limit(1);
  if (!row) throw new ApiError(404, "Task not found");
  return row;
}

// Who can act on a task?
//   - the assignee (mark done / cancel their own)
//   - admin
//   - the checklist's filler / fill_role holder (the committee chair who
//     set it up can also cancel / mark done in case the assignee never logs in)
async function canActOnTask(
  task: Awaited<ReturnType<typeof loadTask>>,
  userId: string,
): Promise<boolean> {
  if (task.task.assignee_id === userId) return true;
  const perms = await loadUserPermissions(userId);
  if (perms.isAdmin) return true;
  if (task.assigned_fill_user_id === userId) return true;
  if (task.template_fill_role && perms.codes.has(task.template_fill_role)) return true;
  return false;
}

// ─── GET /api/checklist-tasks/_users ──────────────────────────────────────
// Lightweight user lookup for the assignee picker. Any authenticated user
// can call this — they need to be able to assign work to anyone. Returns
// active users only; supports a free-text ?q= over name + email.
checklistTasksRouter.get("/_users", async (req: AuthedRequest, res, next) => {
  try {
    const q = trim(req.query.q);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 50));
    const conds: any[] = [isNull(users.deleted_at), eq(users.status, "active")];
    if (q) {
      conds.push(or(
        sql`lower(${users.name}) LIKE lower(${"%" + q + "%"})`,
        sql`lower(${users.email}) LIKE lower(${"%" + q + "%"})`,
      ));
    }
    const rows = await db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(and(...conds))
      .orderBy(asc(users.name))
      .limit(limit);
    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/checklist-tasks/mine ────────────────────────────────────────
// All open tasks assigned to the calling user. Powers a future "My tasks"
// dashboard card (held for now per user). Already useful for testing.
checklistTasksRouter.get("/mine", async (req: AuthedRequest, res, next) => {
  try {
    const status = trim(req.query.status) || "pending";
    const rows = await db
      .select({
        id:            checklistTaskAssignments.id,
        description:   checklistTaskAssignments.description,
        due_date:      checklistTaskAssignments.due_date,
        status:        checklistTaskAssignments.status,
        notes:         checklistTaskAssignments.notes,
        created_at:    checklistTaskAssignments.created_at,
        // Parent event context — what's this task for?
        instance_id:   checklistInstances.id,
        instance_title: checklistInstances.title,
        event_id:      events.id,
        event_title:   events.title,
      })
      .from(checklistTaskAssignments)
      .innerJoin(checklistInstanceResponses, eq(checklistInstanceResponses.id, checklistTaskAssignments.response_id))
      .innerJoin(checklistInstances, eq(checklistInstances.id, checklistInstanceResponses.instance_id))
      .leftJoin(events, eq(events.id, checklistInstances.event_id))
      .where(and(
        eq(checklistTaskAssignments.assignee_id, req.user!.id),
        eq(checklistTaskAssignments.status, status),
      ))
      .orderBy(
        sql`CASE WHEN ${checklistTaskAssignments.due_date} IS NULL THEN 1 ELSE 0 END`,
        asc(checklistTaskAssignments.due_date),
        desc(checklistTaskAssignments.created_at),
      )
      .limit(100);
    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/checklist-tasks/:id/done ───────────────────────────────────
checklistTasksRouter.post("/:id/done", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const task = await loadTask(id);
    if (!await canActOnTask(task, req.user!.id)) {
      throw new ApiError(403, "Only the assignee or checklist owner can mark this done");
    }
    if (task.task.status !== "pending") throw new ApiError(400, `Task is already ${task.task.status}`);

    const [updated] = await db.update(checklistTaskAssignments)
      .set({
        status: "done",
        done_at: new Date(),
        done_by: req.user!.id,
        updated_at: new Date(),
        notes: trim(req.body?.notes) || task.task.notes,
      })
      .where(eq(checklistTaskAssignments.id, id))
      .returning();
    res.json({ task: updated });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/checklist-tasks/:id/reopen ─────────────────────────────────
// Undo a "done" — useful if marked done by mistake.
checklistTasksRouter.post("/:id/reopen", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const task = await loadTask(id);
    if (!await canActOnTask(task, req.user!.id)) {
      throw new ApiError(403, "Only the assignee or checklist owner can reopen this");
    }
    const [updated] = await db.update(checklistTaskAssignments)
      .set({ status: "pending", done_at: null, done_by: null, updated_at: new Date() })
      .where(eq(checklistTaskAssignments.id, id))
      .returning();
    res.json({ task: updated });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/checklist-tasks/:id/cancel ─────────────────────────────────
// Terminal cancellation (task no longer needed). The committee chair
// typically cancels; assignees can too (acknowledges "I can't do it").
checklistTasksRouter.post("/:id/cancel", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const note = trim(req.body?.notes) || null;
    const task = await loadTask(id);
    if (!await canActOnTask(task, req.user!.id)) {
      throw new ApiError(403, "Only the assignee or checklist owner can cancel this");
    }
    const [updated] = await db.update(checklistTaskAssignments)
      .set({ status: "cancelled", notes: note ?? task.task.notes, updated_at: new Date() })
      .where(eq(checklistTaskAssignments.id, id))
      .returning();
    res.json({ task: updated });
  } catch (err) { handleApiError(err, res, next); }
});
