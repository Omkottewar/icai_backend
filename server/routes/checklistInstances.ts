import { Router } from "express";
import { aliasedTable, and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  checklistTemplates, checklistTemplateQuestions,
  checklistInstances, checklistInstanceResponses, checklistInstanceReviews,
  checklistInstanceApprovals,
  checklistTaskAssignments,
  events, users, roles, userRoleAssignments,
} from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { isAdmin, loadUserPermissions } from "../auth/permissions.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { validateResponseValue, type QuestionType, type TaskItem } from "../lib/checklistQuestions.js";
import { notifyAsync } from "../lib/notify.js";

export const checklistInstancesRouter = Router();
checklistInstancesRouter.use(requireUser);

// ─── permission helpers ───────────────────────────────────────────────────
//
// Permission model:
//   • admin can do everything
//   • the assigned fill user can fill + submit
//   • the assigned review user can approve/reject (after submission)
//   • if `fill_role` / `review_role` is set on the template, ANY user holding
//     that role code can act in that slot (useful for "any committee chair"
//     style assignments)
//
// `assigned_fill_user_id` / `assigned_review_user_id` are optional. Role-only
// assignments leave them null.

async function loadInstance(instanceId: string) {
  const [row] = await db
    .select({
      instance: checklistInstances,
      template: checklistTemplates,
      event_committee_id: events.committee_id,
    })
    .from(checklistInstances)
    .innerJoin(checklistTemplates, eq(checklistTemplates.id, checklistInstances.template_id))
    .leftJoin(events, eq(events.id, checklistInstances.event_id))
    .where(eq(checklistInstances.id, instanceId))
    .limit(1);
  if (!row || row.instance.deleted_at) throw new ApiError(404, "Checklist not found");
  return row;
}

async function authorise(instanceId: string, userId: string) {
  const row = await loadInstance(instanceId);
  const perms = await loadUserPermissions(userId);

  // For event-bound instances the rules are FIXED regardless of what the
  // template says: committee chairman of the event's committee fills, branch
  // chairman reviews. This mirrors the legacy event_checklists flow.
  // For non-event-bound (generic) instances we fall back to whatever roles
  // the template declares.
  const isEventBound = !!row.instance.event_id && !!row.event_committee_id;

  const effectiveFillRole   = isEventBound ? "committee_chairman" : row.template.fill_role;
  const effectiveReviewRole = isEventBound ? "branch_chairman"    : row.template.review_role;

  const roleMatch = (code: string | null | undefined) => {
    if (!code) return false;
    if (!perms.codes.has(code)) return false;
    // committee_chairman is committee-scoped — only the chair of THIS event's
    // committee qualifies for event-bound instances.
    if (isEventBound && code === "committee_chairman") {
      return perms.committeeChairmanOf.includes(row.event_committee_id!);
    }
    return true;
  };

  const isFiller =
    row.instance.assigned_fill_user_id === userId
    || roleMatch(effectiveFillRole);

  const isReviewer =
    row.instance.assigned_review_user_id === userId
    || roleMatch(effectiveReviewRole);

  // SEPARATION OF DUTIES (matches legacy event_checklists behaviour):
  //   • admin CREATES + RELEASES the checklist and can MONITOR + MANAGE
  //     (reassign, reopen, delete) — but cannot fill or approve.
  //   • Only the assigned filler (or holder of the fill_role) can fill +
  //     submit. Admin role does NOT grant fill rights.
  //   • Only the assigned reviewer (or holder of the review_role) can
  //     approve/reject. Admin role does NOT grant review rights.
  //
  // DRAFT visibility:
  //   • While status='draft', only admin can see the instance. Hiding from
  //     the filler/reviewer prevents them from acting on a checklist the
  //     admin hasn't finalised yet (wrong assignee, wrong template, etc.).
  const isDraft = row.instance.status === "draft";
  return {
    row,
    perms: {
      canRead:    perms.isAdmin || (!isDraft && (isFiller || isReviewer)),
      canFill:    !isDraft && isFiller,
      canSubmit:  !isDraft && isFiller,
      canReview:  !isDraft && isReviewer,
      canManage:  perms.isAdmin,
      canRelease: perms.isAdmin && isDraft,
    },
  };
}

// ─── GET /api/checklist-instances ─────────────────────────────────────────
// Lists instances the requester can see (filler or reviewer or admin).
checklistInstancesRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const perms = await loadUserPermissions(userId);

    const codes = Array.from(perms.codes);
    const orConds: any[] = [];

    if (perms.isAdmin) orConds.push(sql`TRUE`);
    orConds.push(eq(checklistInstances.assigned_fill_user_id,   userId));
    orConds.push(eq(checklistInstances.assigned_review_user_id, userId));

    // Event-bound instances follow a fixed rule (mirrors authorise()):
    //   committee chairman of the event's committee can fill
    //   branch chairman can review
    // — regardless of what fill_role/review_role the template declares.
    if (perms.committeeChairmanOf.length > 0) {
      orConds.push(and(
        sql`${checklistInstances.event_id} IS NOT NULL`,
        inArray(events.committee_id, perms.committeeChairmanOf),
      ));
    }
    if (perms.isBranchChairman) {
      orConds.push(sql`${checklistInstances.event_id} IS NOT NULL`);
    }

    // Non-event-bound (generic) instances respect the template's role hints.
    // committee_chairman is committee-scoped, so it doesn't qualify a user
    // for ANY committee_chairman-flagged generic instance — only their own.
    const nonScopedCodes = codes.filter((c) => c !== "committee_chairman");
    if (nonScopedCodes.length > 0) {
      orConds.push(and(
        isNull(checklistInstances.event_id),
        or(
          inArray(checklistTemplates.fill_role,   nonScopedCodes),
          inArray(checklistTemplates.review_role, nonScopedCodes),
        ),
      ));
    }

    const status = typeof req.query.status === "string" ? req.query.status : null;

    // Filler/reviewer must NOT see drafts — admin hasn't released them yet.
    // Admins can see everything (and can pass ?status=draft to filter).
    const hideDrafts = !perms.isAdmin
      ? sql`${checklistInstances.status} <> 'draft'`
      : undefined;

    const where = and(
      isNull(checklistInstances.deleted_at),
      or(...orConds),
      hideDrafts,
      status ? eq(checklistInstances.status, status as any) : undefined,
    );

    const rows = await db
      .select({
        id: checklistInstances.id,
        title: checklistInstances.title,
        status: checklistInstances.status,
        template_id: checklistInstances.template_id,
        template_name: checklistTemplates.name,
        template_version: checklistTemplates.version,
        event_id: checklistInstances.event_id,
        event_title: events.title,
        fill_role: checklistTemplates.fill_role,
        review_role: checklistTemplates.review_role,
        assigned_fill_user_id: checklistInstances.assigned_fill_user_id,
        assigned_review_user_id: checklistInstances.assigned_review_user_id,
        created_at: checklistInstances.created_at,
        updated_at: checklistInstances.updated_at,
      })
      .from(checklistInstances)
      .innerJoin(checklistTemplates, eq(checklistTemplates.id, checklistInstances.template_id))
      .leftJoin(events, eq(events.id, checklistInstances.event_id))
      .where(where)
      .orderBy(desc(checklistInstances.updated_at));

    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/checklist-instances/:id ─────────────────────────────────────
checklistInstancesRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { row, perms } = await authorise(id, req.user!.id);
    if (!perms.canRead) throw new ApiError(403, "Forbidden");

    const questions = await db
      .select()
      .from(checklistTemplateQuestions)
      .where(eq(checklistTemplateQuestions.template_id, row.template.id))
      .orderBy(asc(checklistTemplateQuestions.sort_order));

    const responses = await db
      .select()
      .from(checklistInstanceResponses)
      .where(eq(checklistInstanceResponses.instance_id, id));

    const reviews = await db
      .select({
        id: checklistInstanceReviews.id,
        actor_id: checklistInstanceReviews.actor_id,
        actor_name: users.name,
        action: checklistInstanceReviews.action,
        note: checklistInstanceReviews.note,
        created_at: checklistInstanceReviews.created_at,
      })
      .from(checklistInstanceReviews)
      .leftJoin(users, eq(users.id, checklistInstanceReviews.actor_id))
      .where(eq(checklistInstanceReviews.instance_id, id))
      .orderBy(desc(checklistInstanceReviews.created_at));

    // Flatten responses into a map keyed by question_id for the frontend.
    const responseMap: Record<string, unknown> = {};
    for (const r of responses) responseMap[r.question_id] = r.value;

    // For task_list questions, pull the dedicated task rows so the
    // renderer knows the DB id of each task (needed to call /done /
    // /cancel without a save round-trip). Joined with the assignee user
    // to get a display name.
    const taskQuestionIds = questions.filter((q) => q.type === "task_list").map((q) => q.id);
    const tasksByQuestion: Record<string, any[]> = {};
    if (taskQuestionIds.length > 0) {
      const taskAssigneeU = aliasedTable(users, "task_assignee_u");
      const taskRows = await db
        .select({
          id:           checklistTaskAssignments.id,
          response_id:  checklistTaskAssignments.response_id,
          question_id:  checklistInstanceResponses.question_id,
          description:  checklistTaskAssignments.description,
          assignee_id:  checklistTaskAssignments.assignee_id,
          assignee_name: taskAssigneeU.name,
          assignee_email: taskAssigneeU.email,
          due_date:     checklistTaskAssignments.due_date,
          status:       checklistTaskAssignments.status,
          notes:        checklistTaskAssignments.notes,
          sort_order:   checklistTaskAssignments.sort_order,
        })
        .from(checklistTaskAssignments)
        .innerJoin(checklistInstanceResponses, eq(checklistInstanceResponses.id, checklistTaskAssignments.response_id))
        .leftJoin(taskAssigneeU, eq(taskAssigneeU.id, checklistTaskAssignments.assignee_id))
        .where(and(
          eq(checklistInstanceResponses.instance_id, id),
          inArray(checklistInstanceResponses.question_id, taskQuestionIds),
        ))
        .orderBy(asc(checklistTaskAssignments.sort_order));
      for (const t of taskRows) {
        if (!tasksByQuestion[t.question_id]) tasksByQuestion[t.question_id] = [];
        tasksByQuestion[t.question_id].push(t);
      }
    }

    // Look up the assigned filler + reviewer so the admin sees who got
    // pinned (or that nobody did — important for the release decision).
    const assigneeIds = [row.instance.assigned_fill_user_id, row.instance.assigned_review_user_id]
      .filter((x): x is string => !!x);
    const assigneeRows = assigneeIds.length === 0 ? [] :
      await db.select({ id: users.id, name: users.name, email: users.email })
        .from(users).where(inArray(users.id, assigneeIds));
    const byId = new Map(assigneeRows.map((u) => [u.id, u]));
    const filler   = row.instance.assigned_fill_user_id   ? byId.get(row.instance.assigned_fill_user_id)   ?? null : null;
    const reviewer = row.instance.assigned_review_user_id ? byId.get(row.instance.assigned_review_user_id) ?? null : null;

    // Approval stages (for event-bound instances). May be empty for
    // legacy / non-event instances — the frontend treats an empty array
    // as "single-reviewer mode".
    const stages = await loadStages(id);

    res.json({
      instance: row.instance,
      template: row.template,
      questions,
      responses: responseMap,
      tasks: tasksByQuestion,
      reviews,
      assignees: { filler, reviewer },
      stages,
      perms,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/checklist-instances ────────────────────────────────────────
// Admin creates an instance from a published template. ALWAYS starts in
// 'draft' status — admin must explicitly release before the filler can see it.
// Body: { template_id, title?, event_id?, assigned_fill_user_id?, assigned_review_user_id?, notes? }
checklistInstancesRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    if (!(await isAdmin(req.user!.id))) throw new ApiError(403, "Admin only");

    const template_id = need(trim(req.body.template_id), "template_id");
    const [tpl] = await db.select().from(checklistTemplates).where(eq(checklistTemplates.id, template_id)).limit(1);
    if (!tpl || tpl.deleted_at) throw new ApiError(404, "Template not found");
    if (!tpl.is_published) throw new ApiError(400, "Template must be published before it can be used");

    const title = trim(req.body.title) || tpl.name;
    const event_id = trim(req.body.event_id) || null;
    const notes = trim(req.body.notes) || null;
    let fill = trim(req.body.assigned_fill_user_id) || null;
    let reviewer = trim(req.body.assigned_review_user_id) || null;

    let event_committee_id: string | null = null;
    if (event_id) {
      const [e] = await db.select({ id: events.id, committee_id: events.committee_id })
        .from(events).where(eq(events.id, event_id)).limit(1);
      if (!e) throw new ApiError(400, "Event not found");
      event_committee_id = e.committee_id;
    }

    // For event-bound instances we ALWAYS pin the committee chairman + branch
    // chairman, regardless of what the template's fill_role/review_role says.
    // The event flow has a fixed expectation: "committee chair fills, branch
    // chair approves". Templates can be reused outside events with different
    // role hints, but event-bound creation overrides those hints.
    //
    // Admin can pre-empt this by passing assigned_fill_user_id in the body.
    if (event_id && event_committee_id) {
      if (!fill) {
        fill = await findActiveRoleHolder("committee_chairman", { committeeId: event_committee_id });
      }
      if (!reviewer) {
        reviewer = await findActiveRoleHolder("branch_chairman");
      }
    } else {
      // Non-event-bound: fall back to whatever the template suggests.
      if (!fill && tpl.fill_role) {
        fill = await findActiveRoleHolder(tpl.fill_role);
      }
      if (!reviewer && tpl.review_role) {
        reviewer = await findActiveRoleHolder(tpl.review_role);
      }
    }

    const created = await db.transaction(async (tx) => {
      const [row] = await tx.insert(checklistInstances).values({
        template_id: tpl.id,
        title,
        event_id,
        notes,
        assigned_fill_user_id: fill,
        assigned_review_user_id: reviewer,
        created_by: req.user!.id,
        status: "draft",  // <-- not visible to filler until admin releases
      }).returning();
      await tx.insert(checklistInstanceReviews).values({
        instance_id: row.id, actor_id: req.user!.id, action: "created",
      });
      return row;
    });

    res.status(201).json(created);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/checklist-instances/:id/release ────────────────────────────
// Admin confirms the draft is ready. Flips status → awaiting_fill, which
// makes the instance visible to the assigned filler. Requires at least a
// filler to exist (assignee OR template fill_role) — otherwise nobody could
// act on the released checklist.
checklistInstancesRouter.post("/:id/release", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { row, perms } = await authorise(id, req.user!.id);
    if (!perms.canRelease) throw new ApiError(403, "Admin only");
    if (row.instance.status !== "draft") throw new ApiError(400, "Already released");

    const hasFiller = !!row.instance.assigned_fill_user_id || !!row.template.fill_role;
    if (!hasFiller) {
      throw new ApiError(400,
        "Cannot release — no filler assigned. Set assigned_fill_user_id (or set a fill_role on the template) first.",
      );
    }

    const [updated] = await db.update(checklistInstances)
      .set({ status: "awaiting_fill" })
      .where(eq(checklistInstances.id, id))
      .returning();
    await db.insert(checklistInstanceReviews).values({
      instance_id: id, actor_id: req.user!.id, action: "released",
      note: trim(req.body?.note) || null,
    });

    // Auto-create the chairman / treasurer / VC approval stages for
    // event-bound instances. Non-event instances continue to use the
    // single-reviewer model.
    await ensureApprovalStages(id, !!row.instance.event_id && !!row.event_committee_id);

    res.json(updated);
  } catch (err) { handleApiError(err, res, next); }
});

// Look up the current active holder of a role code, optionally scoped to a
// committee. Returns null if nobody currently holds the role. We pick the
// most-recently-assigned holder if more than one exists (defensive — the
// singleton trigger should prevent this for chairman roles).
async function findActiveRoleHolder(
  code: string,
  opts: { committeeId?: string } = {},
): Promise<string | null> {
  const today = new Date().toISOString().slice(0, 10);
  const conds: any[] = [
    eq(roles.code, code),
    or(isNull(userRoleAssignments.effective_to), sql`${userRoleAssignments.effective_to} >= ${today}`),
  ];
  if (opts.committeeId) {
    conds.push(eq(userRoleAssignments.scope_committee_id, opts.committeeId));
  }
  const [row] = await db
    .select({ user_id: userRoleAssignments.user_id })
    .from(userRoleAssignments)
    .innerJoin(roles, eq(roles.id, userRoleAssignments.role_id))
    .where(and(...conds))
    .orderBy(desc(userRoleAssignments.created_at))
    .limit(1);
  return row?.user_id ?? null;
}

// ─── Multi-stage approval stages for event-bound instances ──────────────────
//
// Section R of the requirements describes three parallel approvals:
//   • Branch chairman — overall sign-off
//   • Treasurer       — budget / IUT items
//   • Vice-Chairman   — agenda
//
// We auto-create these stages when an event-bound instance is RELEASED.
// Non-event instances continue to use the original single-reviewer flow.
//
// `cascade_checklist_approval_status` (migration 0025) is the SQL trigger
// that watches these stage rows and flips the parent instance.
const EVENT_APPROVAL_STAGES: Array<{
  stage_code: string;
  stage_label: string;
  required_role_code: string;
  sort_order: number;
}> = [
  { stage_code: "branch_chairman", stage_label: "Branch Chairman — overall approval", required_role_code: "branch_chairman", sort_order: 10 },
  { stage_code: "treasurer_iut",   stage_label: "Treasurer — IUT / budget review",    required_role_code: "branch_treasurer", sort_order: 20 },
  { stage_code: "vc_agenda",       stage_label: "Vice-Chairman — agenda review",      required_role_code: "branch_vice_chairman", sort_order: 30 },
];

async function ensureApprovalStages(instanceId: string, isEventBound: boolean) {
  if (!isEventBound) return;
  // INSERT ... ON CONFLICT keeps re-releases (after reject + reopen)
  // idempotent — existing stage rows are preserved with their statuses
  // so the chairman doesn't have to re-approve work they'd already signed off.
  for (const s of EVENT_APPROVAL_STAGES) {
    await db.insert(checklistInstanceApprovals).values({
      instance_id: instanceId,
      stage_code: s.stage_code,
      stage_label: s.stage_label,
      required_role_code: s.required_role_code,
      sort_order: s.sort_order,
    }).onConflictDoNothing();
  }
}

async function loadStages(instanceId: string) {
  return db.select({
    id:                 checklistInstanceApprovals.id,
    stage_code:         checklistInstanceApprovals.stage_code,
    stage_label:        checklistInstanceApprovals.stage_label,
    required_role_code: checklistInstanceApprovals.required_role_code,
    status:             checklistInstanceApprovals.status,
    sort_order:         checklistInstanceApprovals.sort_order,
    decided_by:         checklistInstanceApprovals.decided_by,
    decider_name:       users.name,
    decided_at:         checklistInstanceApprovals.decided_at,
    note:               checklistInstanceApprovals.note,
  })
    .from(checklistInstanceApprovals)
    .leftJoin(users, eq(users.id, checklistInstanceApprovals.decided_by))
    .where(eq(checklistInstanceApprovals.instance_id, instanceId))
    .orderBy(asc(checklistInstanceApprovals.sort_order));
}

// ─── PATCH /api/checklist-instances/:id ───────────────────────────────────
// Admin updates assignment + title + notes. Cannot change template_id.
checklistInstancesRouter.patch("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { perms } = await authorise(id, req.user!.id);
    if (!perms.canManage) throw new ApiError(403, "Admin only");

    const patch: Record<string, any> = {};
    if (req.body.title                    !== undefined) patch.title                    = need(trim(req.body.title), "Title");
    if (req.body.notes                    !== undefined) patch.notes                    = trim(req.body.notes) || null;
    if (req.body.assigned_fill_user_id    !== undefined) patch.assigned_fill_user_id    = trim(req.body.assigned_fill_user_id) || null;
    if (req.body.assigned_review_user_id  !== undefined) patch.assigned_review_user_id  = trim(req.body.assigned_review_user_id) || null;
    if (Object.keys(patch).length === 0) throw new ApiError(400, "Nothing to update");

    const [row] = await db.update(checklistInstances).set(patch).where(eq(checklistInstances.id, id)).returning();
    if (req.body.assigned_fill_user_id !== undefined || req.body.assigned_review_user_id !== undefined) {
      await db.insert(checklistInstanceReviews).values({
        instance_id: id, actor_id: req.user!.id, action: "assigned",
      });
    }
    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// Compute per-question section owner. Questions inherit `section_owner_role`
// from the closest preceding section_heading; questions before any section
// heading have no owner restriction (null).
function computeSectionOwners<T extends { id: string; type: string; sort_order: number; section_owner_role: string | null }>(
  questions: T[],
): Map<string, string | null> {
  const sorted = [...questions].sort((a, b) => a.sort_order - b.sort_order);
  const out = new Map<string, string | null>();
  let current: string | null = null;
  for (const q of sorted) {
    if (q.type === "section_heading") {
      current = q.section_owner_role ?? null;
    }
    out.set(q.id, current);
  }
  return out;
}

// ─── PUT /api/checklist-instances/:id/responses ───────────────────────────
// Bulk upsert all answers. Body: { responses: { [question_id]: value } }
// Allowed while status is awaiting_fill OR rejected (re-fill after reject).
//
// Section ownership: each question may belong to a section that's owned by
// a specific role (via the closest preceding section_heading's
// `section_owner_role`). If a question has an owner role, the caller must
// either hold that role OR be the assigned filler / admin. This is what
// lets the treasurer edit "Budget & IUT" without owning the whole
// checklist; conversely it stops the committee chair from editing the
// budget if it's not theirs.
//
// Task lists: when a question of type `task_list` is saved, we reconcile
// the response value into the dedicated `checklist_task_assignments`
// table — tear down + recreate the rows for that response. New assignees
// get an email + in-app notification via the existing notify() dispatcher.
checklistInstancesRouter.put("/:id/responses", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { row, perms } = await authorise(id, req.user!.id);
    if (!perms.canFill) throw new ApiError(403, "You can't fill this checklist");
    if (!["awaiting_fill", "rejected"].includes(row.instance.status)) {
      throw new ApiError(400, "Checklist is not editable in its current state");
    }

    const incoming = (req.body && typeof req.body.responses === "object") ? req.body.responses : {};
    const questions = await db
      .select()
      .from(checklistTemplateQuestions)
      .where(eq(checklistTemplateQuestions.template_id, row.template.id));

    // Section-ownership lookup: question_id → required role code (or null
    // for "anyone with fill rights").
    const sectionOwners = computeSectionOwners(questions.map((q) => ({
      id: q.id, type: q.type as string, sort_order: q.sort_order,
      section_owner_role: q.section_owner_role,
    })));
    const callerPerms = await loadUserPermissions(req.user!.id);

    // Build (question, cleanedValue) pairs. Validation is "best effort"
    // here — required checking happens at /submit so save-progress works.
    const pairs: { question: typeof questions[number]; value: unknown }[] = [];
    for (const q of questions) {
      const has = Object.prototype.hasOwnProperty.call(incoming, q.id);
      if (!has) continue;

      // Enforce per-section ownership. The committee chair filling the
      // whole checklist can still touch sections with no owner restriction.
      const owner = sectionOwners.get(q.id);
      if (owner) {
        const allowed = callerPerms.isAdmin || callerPerms.codes.has(owner);
        if (!allowed) {
          throw new ApiError(403, `Only ${owner.replace(/_/g, " ")} can edit this section`);
        }
      }

      const cleaned = validateResponseValue(q.type as QuestionType, false, q.config, incoming[q.id]);
      pairs.push({ question: q, value: cleaned });
    }

    // Collect newly-assigned tasks for post-commit notification. We can
    // only know "new" by diffing against existing rows inside the tx.
    const newAssignments: Array<{
      assignee_id: string;
      description: string;
      due_date: string | null;
    }> = [];

    await db.transaction(async (tx) => {
      for (const p of pairs) {
        // Upsert the response row.
        const [resp] = await tx
          .insert(checklistInstanceResponses)
          .values({ instance_id: id, question_id: p.question.id, value: p.value as any })
          .onConflictDoUpdate({
            target: [checklistInstanceResponses.instance_id, checklistInstanceResponses.question_id],
            set: { value: p.value as any, updated_at: new Date() },
          })
          .returning();

        // For task_list questions, reconcile the task_assignments rows.
        if (p.question.type === "task_list") {
          const tasks = (Array.isArray(p.value) ? p.value : []) as TaskItem[];

          // Existing rows for this response so we can detect "newly
          // assigned to user X" vs "already assigned to user X".
          const existing = await tx
            .select({ id: checklistTaskAssignments.id, assignee_id: checklistTaskAssignments.assignee_id })
            .from(checklistTaskAssignments)
            .where(eq(checklistTaskAssignments.response_id, resp.id));
          const existingAssignees = new Set(
            existing.map((e) => e.assignee_id).filter((x): x is string => !!x),
          );

          // Wipe + recreate. Simpler than trying to diff client cids
          // across saves; the row count per task_list is tiny (< 50).
          await tx.delete(checklistTaskAssignments)
            .where(eq(checklistTaskAssignments.response_id, resp.id));

          for (let i = 0; i < tasks.length; i++) {
            const t = tasks[i];
            await tx.insert(checklistTaskAssignments).values({
              response_id: resp.id,
              description: t.description,
              assignee_id: t.assignee_id ?? null,
              due_date: t.due_date ?? null,
              status: t.status ?? "pending",
              notes: t.notes ?? null,
              sort_order: i,
            });
            // Newly-assigned-to-this-user means the assignee wasn't in
            // the previous row set for this response.
            if (t.assignee_id && !existingAssignees.has(t.assignee_id)) {
              newAssignments.push({
                assignee_id: t.assignee_id,
                description: t.description,
                due_date: t.due_date ?? null,
              });
            }
          }
        }
      }
      // Touch parent so updated_at advances. Drizzle refuses an empty set(),
      // so we explicitly bump updated_at (the trigger would do this anyway,
      // but giving drizzle a value to set keeps the ORM happy).
      await tx.update(checklistInstances)
        .set({ updated_at: new Date() })
        .where(eq(checklistInstances.id, id));
    });

    // Fire notifications outside the txn so DB writes don't roll back on
    // mail failures. Use notifyAsync — fire-and-forget; errors logged.
    const [assignerRow] = await db
      .select({ name: users.name }).from(users)
      .where(eq(users.id, req.user!.id)).limit(1);
    const eventTitle = row.event_committee_id
      ? (await db.select({ title: events.title }).from(events)
          .where(eq(events.id, row.instance.event_id!)).limit(1))[0]?.title ?? row.instance.title
      : row.instance.title;

    for (const a of newAssignments) {
      notifyAsync({
        user_id: a.assignee_id,
        template_key: "task_assigned",
        vars: {
          assigner_name: assignerRow?.name ?? "The team",
          event_title: eventTitle,
          task_description: a.description,
          due_date: a.due_date ?? "(no due date)",
          checklist_link: `${process.env.APP_URL ?? ""}/#/my-checklists?id=${id}`,
        },
        link_url: `/#/my-checklists?id=${id}`,
      });
    }

    res.json({ ok: true, saved: pairs.length, new_assignments: newAssignments.length });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/checklist-instances/:id/submit ─────────────────────────────
// Lock-in: validates every required answer, flips status → awaiting_review.
checklistInstancesRouter.post("/:id/submit", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { row, perms } = await authorise(id, req.user!.id);
    if (!perms.canSubmit) throw new ApiError(403, "You can't submit this checklist");
    if (!["awaiting_fill", "rejected"].includes(row.instance.status)) {
      throw new ApiError(400, "Checklist already submitted");
    }

    const questions = await db
      .select()
      .from(checklistTemplateQuestions)
      .where(eq(checklistTemplateQuestions.template_id, row.template.id));

    const stored = await db
      .select()
      .from(checklistInstanceResponses)
      .where(eq(checklistInstanceResponses.instance_id, id));
    const byQ: Record<string, unknown> = {};
    for (const r of stored) byQ[r.question_id] = r.value;

    const missing: string[] = [];
    for (const q of questions) {
      if (q.type === "section_heading") continue;
      try {
        validateResponseValue(q.type as QuestionType, q.required, q.config, byQ[q.id] ?? null);
      } catch {
        missing.push(q.label);
      }
    }
    if (missing.length > 0) {
      const preview = missing.slice(0, 3).join(", ");
      throw new ApiError(400, `Fill all required items first (${missing.length} missing: ${preview}${missing.length > 3 ? "…" : ""})`);
    }

    const [updated] = await db.update(checklistInstances)
      .set({ status: "awaiting_review", submitted_at: new Date() })
      .where(eq(checklistInstances.id, id))
      .returning();
    await db.insert(checklistInstanceReviews).values({
      instance_id: id, actor_id: req.user!.id, action: "submitted",
      note: trim(req.body?.note) || null,
    });
    res.json(updated);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/checklist-instances/:id/approve ────────────────────────────
// Single-reviewer approve. For event-bound instances with stage rows this
// is BLOCKED — the user must call /approve-stage instead. The block forces
// the multi-stage flow where it applies and prevents the chairman from
// accidentally short-circuiting the treasurer / VC stages.
checklistInstancesRouter.post("/:id/approve", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { row, perms } = await authorise(id, req.user!.id);
    if (!perms.canReview) throw new ApiError(403, "You can't review this checklist");
    if (row.instance.status !== "awaiting_review") throw new ApiError(400, "Not awaiting review");

    const stages = await loadStages(id);
    if (stages.length > 0) {
      throw new ApiError(400,
        "This checklist uses multi-stage approval. Approve your own stage via /approve-stage instead.",
      );
    }

    const [updated] = await db.update(checklistInstances)
      .set({ status: "approved", reviewed_at: new Date() })
      .where(eq(checklistInstances.id, id))
      .returning();
    await db.insert(checklistInstanceReviews).values({
      instance_id: id, actor_id: req.user!.id, action: "approved",
      note: trim(req.body?.note) || null,
    });
    res.json(updated);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/checklist-instances/:id/approve-stage ──────────────────────
// Decide a single approval stage. The DB trigger cascades the instance
// status when ALL stages are approved (or any is rejected).
//
// The user must hold the stage's `required_role_code`. Branch chairman is
// allowed to approve ANY stage (override path — Section R.5 "plain approve").
checklistInstancesRouter.post("/:id/approve-stage", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const stage_code = need(trim(req.body?.stage_code), "Stage code");
    const note = trim(req.body?.note) || null;

    const { row } = await authorise(id, req.user!.id);
    if (row.instance.status !== "awaiting_review") throw new ApiError(400, "Not awaiting review");

    const [stage] = await db.select().from(checklistInstanceApprovals)
      .where(and(
        eq(checklistInstanceApprovals.instance_id, id),
        eq(checklistInstanceApprovals.stage_code, stage_code),
      )).limit(1);
    if (!stage) throw new ApiError(404, "Stage not found on this instance");
    if (stage.status !== "pending") throw new ApiError(400, `Stage already ${stage.status}`);

    const perms = await loadUserPermissions(req.user!.id);
    // STRICT rule: each stage can only be approved by the role that owns
    // it. The branch chairman approves the chairman stage, the treasurer
    // approves the treasurer stage, the VC approves the VC stage. Admin
    // is the only super-admin escape hatch — every other override path
    // (publish without checklist, etc.) lives on the events router, not
    // here.
    const canDecideStage = perms.isAdmin || perms.codes.has(stage.required_role_code);
    if (!canDecideStage) {
      throw new ApiError(403,
        `This stage requires the ${stage.required_role_code} role.`,
      );
    }

    const [updated] = await db.update(checklistInstanceApprovals)
      .set({
        status: "approved",
        decided_by: req.user!.id,
        decided_at: new Date(),
        note,
      })
      .where(eq(checklistInstanceApprovals.id, stage.id))
      .returning();

    // The cascade trigger will flip the instance to 'approved' if this was
    // the last pending stage. Return the latest instance + stages so the
    // frontend can reflect the new state without a follow-up GET.
    const [instanceRow] = await db.select().from(checklistInstances).where(eq(checklistInstances.id, id)).limit(1);
    const stages = await loadStages(id);
    res.json({ stage: updated, instance: instanceRow, stages });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/checklist-instances/:id/reject-final ───────────────────────
// Terminal reject — distinct from /reject-stage. Whereas /reject-stage
// sends the checklist back to the filler (who can fix and resubmit),
// /reject-final closes the door:
//   - the instance status becomes 'rejected'
//   - the linked event (if any) is cancelled
//   - the action is recorded with type 'rejected_final' in the review log
//
// Use case: an event idea isn't viable at all (date conflict with WIRC,
// regulatory concern, etc.) and shouldn't sit in someone's inbox waiting
// for a re-fill that's never going to happen. Per Section R.5.
//
// Strict per-role gate (same as /reject-stage): only the stage owner or
// admin can call this. Note is required so there's always a paper trail.
checklistInstancesRouter.post("/:id/reject-final", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const stage_code = need(trim(req.body?.stage_code), "Stage code");
    const note = need(trim(req.body?.note), "Reason");

    const { row } = await authorise(id, req.user!.id);
    if (row.instance.status !== "awaiting_review") throw new ApiError(400, "Not awaiting review");

    const [stage] = await db.select().from(checklistInstanceApprovals)
      .where(and(
        eq(checklistInstanceApprovals.instance_id, id),
        eq(checklistInstanceApprovals.stage_code, stage_code),
      )).limit(1);
    if (!stage) throw new ApiError(404, "Stage not found on this instance");
    if (stage.status !== "pending") throw new ApiError(400, `Stage already ${stage.status}`);

    const perms = await loadUserPermissions(req.user!.id);
    const canDecideStage = perms.isAdmin || perms.codes.has(stage.required_role_code);
    if (!canDecideStage) {
      throw new ApiError(403, `This stage requires the ${stage.required_role_code} role.`);
    }

    // Cancel the linked event + close the instance + write the audit row,
    // all in a transaction so a partial state can't leak.
    const result = await db.transaction(async (tx) => {
      // 1. Mark the stage as rejected (the cascade trigger from 0025 will
      //    flip the instance to rejected — but that path leaves the event
      //    in pending_approval. We want a stronger "cancelled" end state).
      await tx.update(checklistInstanceApprovals)
        .set({ status: "rejected", decided_by: req.user!.id, decided_at: new Date(), note })
        .where(eq(checklistInstanceApprovals.id, stage.id));

      // 2. Force-set the instance to 'rejected' (in case the trigger
      //    didn't fire fast enough; idempotent).
      await tx.update(checklistInstances)
        .set({ status: "rejected", reviewed_at: new Date(), updated_at: new Date() })
        .where(eq(checklistInstances.id, id));

      // 3. Cancel the linked event if there is one.
      if (row.instance.event_id) {
        await tx.update(events)
          .set({ status: "cancelled", updated_at: new Date() })
          .where(eq(events.id, row.instance.event_id));
      }

      // 4. Record the action in the review log.
      await tx.insert(checklistInstanceReviews).values({
        instance_id: id,
        actor_id: req.user!.id,
        action: "rejected_final",
        note,
      });

      const [instanceRow] = await tx.select().from(checklistInstances).where(eq(checklistInstances.id, id)).limit(1);
      return instanceRow;
    });

    const stages = await loadStages(id);
    res.json({ instance: result, stages });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/checklist-instances/:id/reject-stage ───────────────────────
// Any approver can reject — the trigger cascades the instance to 'rejected'.
// The note is required so the chairman / filler knows what to fix.
checklistInstancesRouter.post("/:id/reject-stage", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const stage_code = need(trim(req.body?.stage_code), "Stage code");
    const note = need(trim(req.body?.note), "Rejection note");

    const { row } = await authorise(id, req.user!.id);
    if (row.instance.status !== "awaiting_review") throw new ApiError(400, "Not awaiting review");

    const [stage] = await db.select().from(checklistInstanceApprovals)
      .where(and(
        eq(checklistInstanceApprovals.instance_id, id),
        eq(checklistInstanceApprovals.stage_code, stage_code),
      )).limit(1);
    if (!stage) throw new ApiError(404, "Stage not found on this instance");
    if (stage.status !== "pending") throw new ApiError(400, `Stage already ${stage.status}`);

    const perms = await loadUserPermissions(req.user!.id);
    // Same STRICT rule as approve-stage: only the role that owns the stage
    // (or admin) can decide it. The chairman can't reject the treasurer's
    // stage on the treasurer's behalf.
    const canDecideStage = perms.isAdmin || perms.codes.has(stage.required_role_code);
    if (!canDecideStage) {
      throw new ApiError(403,
        `This stage requires the ${stage.required_role_code} role.`,
      );
    }

    const [updated] = await db.update(checklistInstanceApprovals)
      .set({
        status: "rejected",
        decided_by: req.user!.id,
        decided_at: new Date(),
        note,
      })
      .where(eq(checklistInstanceApprovals.id, stage.id))
      .returning();

    const [instanceRow] = await db.select().from(checklistInstances).where(eq(checklistInstances.id, id)).limit(1);
    const stages = await loadStages(id);
    res.json({ stage: updated, instance: instanceRow, stages });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/checklist-instances/:id/reject ─────────────────────────────
checklistInstancesRouter.post("/:id/reject", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { row, perms } = await authorise(id, req.user!.id);
    if (!perms.canReview) throw new ApiError(403, "You can't review this checklist");
    if (row.instance.status !== "awaiting_review") throw new ApiError(400, "Not awaiting review");
    const note = need(trim(req.body?.note), "Rejection note");

    const [updated] = await db.update(checklistInstances)
      .set({ status: "rejected", reviewed_at: new Date() })
      .where(eq(checklistInstances.id, id))
      .returning();
    await db.insert(checklistInstanceReviews).values({
      instance_id: id, actor_id: req.user!.id, action: "rejected", note,
    });
    res.json(updated);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/checklist-instances/:id/reopen ─────────────────────────────
// Admin escape hatch: drop an approved/rejected instance back to fill state.
checklistInstancesRouter.post("/:id/reopen", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { row, perms } = await authorise(id, req.user!.id);
    if (!perms.canManage) throw new ApiError(403, "Admin only");
    if (row.instance.status === "awaiting_fill") return res.json(row.instance);

    const [updated] = await db.update(checklistInstances)
      .set({ status: "awaiting_fill", submitted_at: null, reviewed_at: null })
      .where(eq(checklistInstances.id, id))
      .returning();
    await db.insert(checklistInstanceReviews).values({
      instance_id: id, actor_id: req.user!.id, action: "reopened",
      note: trim(req.body?.note) || null,
    });
    // Reset any approval stages back to 'pending' so the chairman /
    // treasurer / VC have to act again after the filler resubmits.
    await db.update(checklistInstanceApprovals)
      .set({ status: "pending", decided_by: null, decided_at: null, note: null })
      .where(eq(checklistInstanceApprovals.instance_id, id));
    res.json(updated);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/checklist-instances/:id ──────────────────────────────────
checklistInstancesRouter.delete("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { perms } = await authorise(id, req.user!.id);
    if (!perms.canManage) throw new ApiError(403, "Admin only");

    const [row] = await db.update(checklistInstances)
      .set({ deleted_at: new Date() })
      .where(eq(checklistInstances.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
