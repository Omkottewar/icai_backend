import { Router } from "express";
import { aliasedTable, and, asc, desc, eq, gte, inArray, isNull, isNotNull, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  checklistTemplates, checklistTemplateQuestions,
  checklistInstances, checklistInstanceQuestions,
  checklistInstanceResponses, checklistInstanceReviews,
  checklistInstanceApprovals, checklistInstanceSectionAssignments,
  checklistTaskAssignments,
  events, users, roles, userRoleAssignments,
} from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { isAdmin, loadUserPermissions } from "../auth/permissions.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import { validateResponseValue, type QuestionType, type TaskItem } from "../lib/checklistQuestions.js";
import { notifyAsync } from "../lib/notify.js";

// ─── Notification helpers (used by create / release / submit / reassign) ──
// Centralised so all five lifecycle points dispatch with the same shape and
// link URL. Keeping it here (rather than in lib/) so the local imports of
// users/events/etc are reused.

const checklistLink = (id: string) => `/my-checklists?id=${id}`;

/**
 * Fire `checklist_assigned` to one user. `sections` is the optional list of
 * section labels they're responsible for (used to render the body); pass
 * empty when the user is the primary filler (whole checklist).
 */
function notifyChecklistAssigned(opts: {
  user_id: string;
  assigner_name: string;
  checklist_title: string;
  event_title: string | null;
  sections: string[];
  instance_id: string;
}) {
  const sectionClause = opts.sections.length > 0
    ? ` (section${opts.sections.length === 1 ? '' : 's'}: ${opts.sections.join(', ')})`
    : "";
  const sectionSummary = opts.sections.length > 0
    ? `You're responsible for: ${opts.sections.join(', ')}`
    : "The whole checklist is yours to fill.";
  const eventClause = opts.event_title ? `Event: ${opts.event_title}.\n\n` : "";
  notifyAsync({
    user_id: opts.user_id,
    template_key: "checklist_assigned",
    vars: {
      assigner_name:   opts.assigner_name,
      checklist_title: opts.checklist_title,
      event_title:     opts.event_title ?? "",
      event_clause:    eventClause,
      section_clause:  sectionClause,
      section_summary: sectionSummary,
      checklist_link:  `${process.env.APP_URL ?? ""}${checklistLink(opts.instance_id)}`,
    },
    link_url: checklistLink(opts.instance_id),
  });
}

/**
 * Fan-out: notify the primary filler + every distinct section assignee. We
 * dedupe by user_id so the chairman doesn't get two emails when they're both
 * the primary filler AND assigned to a section.
 *
 * sectionsByUser[user_id] is the list of section labels they own. Empty
 * array if the user has no section assignment (they're the primary filler).
 */
async function notifyChecklistAssignees(opts: {
  instance_id: string;
  assigner_name: string;
  checklist_title: string;
  event_title: string | null;
  primary_filler_id: string | null;
  sectionsByUser: Map<string, string[]>;
  // user_ids to skip (e.g. user who just acted — don't notify yourself)
  skip?: Set<string>;
}) {
  const skip = opts.skip ?? new Set();
  const seen = new Set<string>();

  // Primary filler first.
  if (opts.primary_filler_id && !skip.has(opts.primary_filler_id)) {
    seen.add(opts.primary_filler_id);
    notifyChecklistAssigned({
      user_id:         opts.primary_filler_id,
      assigner_name:   opts.assigner_name,
      checklist_title: opts.checklist_title,
      event_title:     opts.event_title,
      sections:        opts.sectionsByUser.get(opts.primary_filler_id) ?? [],
      instance_id:     opts.instance_id,
    });
  }
  // Then every section assignee not already covered.
  for (const [user_id, sections] of opts.sectionsByUser.entries()) {
    if (seen.has(user_id) || skip.has(user_id)) continue;
    seen.add(user_id);
    notifyChecklistAssigned({
      user_id,
      assigner_name:   opts.assigner_name,
      checklist_title: opts.checklist_title,
      event_title:     opts.event_title,
      sections,
      instance_id:     opts.instance_id,
    });
  }
}

/** Build sectionsByUser for an instance by joining section_assignments with
 *  the instance's question rows. Reads the instance-question label; rows
 *  that pre-date migration 0053 are picked up by their backfilled
 *  instance_section_question_id, so the legacy template-question join is
 *  no longer required. */
async function loadSectionsByUser(instance_id: string): Promise<Map<string, string[]>> {
  const rows = await db
    .select({
      assignee_id: checklistInstanceSectionAssignments.assignee_id,
      label:       checklistInstanceQuestions.label,
    })
    .from(checklistInstanceSectionAssignments)
    .innerJoin(
      checklistInstanceQuestions,
      eq(checklistInstanceQuestions.id, checklistInstanceSectionAssignments.instance_section_question_id),
    )
    .where(eq(checklistInstanceSectionAssignments.instance_id, instance_id));
  const m = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.assignee_id) continue;
    const list = m.get(r.assignee_id) ?? [];
    list.push(r.label);
    m.set(r.assignee_id, list);
  }
  return m;
}

/** Look up the actor's display name for the {{assigner_name}} / {{filler_name}} vars. */
async function actorName(user_id: string): Promise<string> {
  const [u] = await db.select({ name: users.name }).from(users).where(eq(users.id, user_id)).limit(1);
  return u?.name ?? "The team";
}

/** Look up the event title bound to an instance, or null for non-event-bound. */
async function instanceEventTitle(instance_id: string): Promise<string | null> {
  const [row] = await db
    .select({ title: events.title })
    .from(checklistInstances)
    .leftJoin(events, eq(events.id, checklistInstances.event_id))
    .where(eq(checklistInstances.id, instance_id))
    .limit(1);
  return row?.title ?? null;
}

/**
 * Notify every filler of a checklist after a review outcome (approve /
 * reject). Recipients:
 *   • row.instance.assigned_fill_user_id (checklist-level primary filler)
 *   • template's fill_role holder as fallback when no primary filler
 *   • every per-section assignee (assignee_id from section_assignments)
 *
 * Uses the shared `checklist_approved` / `checklist_rejected` templates
 * (0080) and skips the reviewer themselves so the actor doesn't ping
 * themselves.
 */
async function notifyChecklistReviewOutcome(opts: {
  instanceId: string;
  row: Awaited<ReturnType<typeof loadInstance>>;
  reviewerId: string;
  templateKey: "checklist_approved" | "checklist_rejected";
  note: string | null;
}) {
  const { instanceId, row, reviewerId, templateKey, note } = opts;
  const reviewerName = await actorName(reviewerId);
  const eventTitle = !!row.instance.event_id ? (await instanceEventTitle(instanceId)) : null;

  const targetIds = new Set<string>();
  if (row.instance.assigned_fill_user_id) targetIds.add(row.instance.assigned_fill_user_id);
  if (!row.instance.assigned_fill_user_id && row.template.fill_role) {
    const uid = await findActiveRoleHolder(row.template.fill_role);
    if (uid) targetIds.add(uid);
  }
  // Per-section fillers — anyone the admin pinned to fill a section.
  const sectionFillerRows = await db
    .select({ assignee_id: checklistInstanceSectionAssignments.assignee_id })
    .from(checklistInstanceSectionAssignments)
    .where(and(
      eq(checklistInstanceSectionAssignments.instance_id, instanceId),
      isNotNull(checklistInstanceSectionAssignments.assignee_id),
    ));
  for (const r of sectionFillerRows) {
    if (r.assignee_id) targetIds.add(r.assignee_id);
  }

  const link = checklistLink(instanceId);
  for (const uid of targetIds) {
    if (uid === reviewerId) continue;
    notifyAsync({
      user_id: uid,
      template_key: templateKey,
      vars: {
        reviewer_name:   reviewerName,
        checklist_title: row.instance.title,
        event_title:     eventTitle ?? "",
        event_clause:    eventTitle ? `Event: ${eventTitle}.\n\n` : "",
        checklist_link:  `${process.env.APP_URL ?? ""}${link}`,
        note:            note ?? "",
      },
      link_url: link,
    });
  }
}

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

  // ALL per-section assignments on this instance — for BOTH the "which
  // sections is this user assigned to" question AND the "which sections
  // already have a specific filler" question (needed so we can DEMOTE the
  // primary filler on sections that were explicitly assigned to someone
  // else). Without that, the primary filler could fill sections that were
  // supposed to be locked to the per-section assignee.
  const allSectionAssignmentRows = await db
    .select({
      section_question_id: sql<string>`COALESCE(${checklistInstanceSectionAssignments.instance_section_question_id}, ${checklistInstanceSectionAssignments.section_question_id})`.as("section_question_id"),
      assignee_id: checklistInstanceSectionAssignments.assignee_id,
      approver_id: checklistInstanceSectionAssignments.approver_id,
    })
    .from(checklistInstanceSectionAssignments)
    .where(eq(checklistInstanceSectionAssignments.instance_id, instanceId));
  const mySectionIds = new Set(
    allSectionAssignmentRows
      .filter((r) => r.assignee_id === userId)
      .map((r) => r.section_question_id)
  );
  const myApproverSectionIds = new Set(
    allSectionAssignmentRows
      .filter((r) => r.approver_id === userId)
      .map((r) => r.section_question_id)
  );
  // Any section with an assignee (regardless of who) is a "specifically
  // assigned" section — the primary filler must be locked out of it.
  const specificallyAssignedSectionIds = new Set(
    allSectionAssignmentRows
      .filter((r) => r.assignee_id)
      .map((r) => r.section_question_id)
  );
  const isSectionAssignee = mySectionIds.size > 0;
  const isSectionApprover = myApproverSectionIds.size > 0;

  const isReviewer =
    row.instance.assigned_review_user_id === userId
    || roleMatch(effectiveReviewRole)
    // Per-section approvers count as reviewers on the instance. They see
    // the review UI and can approve/reject the whole checklist. (Fine-
    // grained per-section approvals would require a bigger data-model
    // change; the current flow approves the whole checklist at once.)
    || isSectionApprover;

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
      canRead:    perms.isAdmin || (!isDraft && (isFiller || isReviewer || isSectionAssignee)),
      // Whole-instance fill rights — the primary filler / role-holder.
      // Kept true even when per-section assignments exist; the PUT
      // /responses gate is where the "primary filler is locked out of
      // explicitly-assigned sections" rule is applied (via lockedSectionIds).
      canFill:    !isDraft && isFiller,
      // Submit is also allowed for per-section assignees: when a checklist
      // is set up with ONLY per-section assignments (no primary filler),
      // the section-owner needs to be able to trigger the state change to
      // awaiting_review after filling their part. The submit route still
      // validates that EVERY required answer is present, so a section
      // assignee can't skip other people's questions.
      canSubmit:  !isDraft && (isFiller || isSectionAssignee),
      canReview:  !isDraft && isReviewer,
      canManage:  perms.isAdmin,
      canRelease: perms.isAdmin && isDraft,
      // Per-section fill rights — the question-level enforcement uses this
      // (PUT /:id/responses checks each question's section against this set).
      canFillSections: !isDraft && isSectionAssignee,
      mySectionIds: Array.from(mySectionIds),
      // Sections that have been ASSIGNED to some specific user. The primary
      // filler is locked OUT of these — only the assignee can fill them.
      // Included here so route handlers can enforce per-section ownership
      // without re-querying the section_assignments table.
      lockedSectionIds: Array.from(specificallyAssignedSectionIds),
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
    // Per-section assignees see instances where they own at least one
    // section. Use EXISTS to avoid duplicating rows by JOINing through the
    // assignments table.
    orConds.push(sql`EXISTS (
      SELECT 1 FROM checklist_instance_section_assignments csa
      WHERE csa.instance_id = ${checklistInstances.id}
        AND csa.assignee_id = ${userId}
    )`);

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

    // Per-instance question list (cloned from the template at creation
    // time; mutable through PUT /:id/questions). Replaces the previous
    // direct read from checklist_template_questions — see migration 0053.
    const questions = await db
      .select()
      .from(checklistInstanceQuestions)
      .where(eq(checklistInstanceQuestions.instance_id, id))
      .orderBy(asc(checklistInstanceQuestions.sort_order));

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

    // Flatten responses into a map keyed by the instance question id for
    // the frontend. New writes use `instance_question_id`; the legacy
    // `question_id` (template-pointed) is kept as a fallback only for any
    // stray rows that pre-date migration 0053 and weren't backfilled.
    const responseMap: Record<string, unknown> = {};
    for (const r of responses) {
      const key = r.instance_question_id ?? r.question_id;
      if (key) responseMap[key as string] = r.value;
    }

    // For task_list questions, pull the dedicated task rows so the
    // renderer knows the DB id of each task (needed to call /done /
    // /cancel without a save round-trip). Joined with the assignee user
    // to get a display name. The grouping key is the instance question id
    // (matching how `responseMap` is keyed above).
    const taskQuestionIds = questions.filter((q) => q.type === "task_list").map((q) => q.id);
    const tasksByQuestion: Record<string, any[]> = {};
    if (taskQuestionIds.length > 0) {
      const taskAssigneeU = aliasedTable(users, "task_assignee_u");
      const taskRows = await db
        .select({
          id:                   checklistTaskAssignments.id,
          response_id:          checklistTaskAssignments.response_id,
          question_id:          checklistInstanceResponses.question_id,
          instance_question_id: checklistInstanceResponses.instance_question_id,
          description:          checklistTaskAssignments.description,
          assignee_id:          checklistTaskAssignments.assignee_id,
          assignee_name:        taskAssigneeU.name,
          assignee_email:       taskAssigneeU.email,
          due_date:             checklistTaskAssignments.due_date,
          status:               checklistTaskAssignments.status,
          notes:                checklistTaskAssignments.notes,
          sort_order:           checklistTaskAssignments.sort_order,
        })
        .from(checklistTaskAssignments)
        .innerJoin(checklistInstanceResponses, eq(checklistInstanceResponses.id, checklistTaskAssignments.response_id))
        .leftJoin(taskAssigneeU, eq(taskAssigneeU.id, checklistTaskAssignments.assignee_id))
        .where(and(
          eq(checklistInstanceResponses.instance_id, id),
          inArray(checklistInstanceResponses.instance_question_id, taskQuestionIds),
        ))
        .orderBy(asc(checklistTaskAssignments.sort_order));
      for (const t of taskRows) {
        const key = (t.instance_question_id ?? t.question_id) as string;
        if (!tasksByQuestion[key]) tasksByQuestion[key] = [];
        tasksByQuestion[key].push(t);
      }
    }

    // Per-section assignment rows + joined assignee names. The frontend
    // expects `section_question_id` keyed to the question id it sees in
    // the questions list — which is now an instance_question id. Migration
    // 0053 backfills the new column for every existing assignment, so the
    // COALESCE here is purely a transitional safety net.
    const sectionAssigneeU = aliasedTable(users, "section_assignee_u");
    const sectionAssignments = await db
      .select({
        id:                            checklistInstanceSectionAssignments.id,
        section_question_id:           sql<string>`COALESCE(${checklistInstanceSectionAssignments.instance_section_question_id}, ${checklistInstanceSectionAssignments.section_question_id})`.as("section_question_id"),
        assignee_id:                   checklistInstanceSectionAssignments.assignee_id,
        assignee_name:                 sectionAssigneeU.name,
        assignee_email:                sectionAssigneeU.email,
      })
      .from(checklistInstanceSectionAssignments)
      .leftJoin(sectionAssigneeU, eq(sectionAssigneeU.id, checklistInstanceSectionAssignments.assignee_id))
      .where(eq(checklistInstanceSectionAssignments.instance_id, id));

    // Look up the assigned filler + reviewer so the admin sees who got
    // pinned (or that nobody did — important for the release decision).
    // We also pull the section assignee IDs into the same lookup so the
    // assignees panel can render names without an extra round-trip.
    const assigneeIds = [
      row.instance.assigned_fill_user_id,
      row.instance.assigned_review_user_id,
      ...sectionAssignments.map((s) => s.assignee_id),
    ].filter((x): x is string => !!x);
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
      section_assignments: sectionAssignments,
      stages,
      perms,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/checklist-instances ────────────────────────────────────────
// Admin creates an instance from a published template. The instance is
// auto-released (status = 'awaiting_fill') immediately so the committee
// chairman / treasurer / branch chairman dashboards see it without the
// admin having to dig into the detail page and click 'Release'. This is
// the right tradeoff for a small branch — the explicit two-step flow was
// confusing non-tech admins and silently hiding all newly-created
// checklists from everyone except admins.
//
// Fall-back: if no filler can be resolved (template has no fill_role and
// no committee chairman is assigned), we keep the instance in 'draft' and
// return it as-is so the admin can fix the assignment, then hit the
// existing release endpoint manually.
//
// Body: {
//   template_id, title?, event_id?, notes?,
//   assigned_fill_user_id?, assigned_review_user_id?,
//   section_assignments?: [{
//     section_question_id: uuid,
//     assignee_id: uuid|null,   // per-section filler (nullable)
//     approver_id: uuid|null,   // per-section approver (nullable, since 0079)
//   }]
// }
//
// section_assignments lets the admin pin specific users to a specific
// section of the checklist (e.g. treasurer fills Budget, VC approves
// Speakers). It's an OVERLAY: the checklist-level assigned_fill_user_id +
// assigned_review_user_id are the fallback filler / approver, and per-
// section entries take over ONLY for that section.
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

    // Validate section_assignments shape + ownership. Each section_question_id
    // must (a) belong to THIS template and (b) be of type 'section_heading'.
    // We resolve the user IDs at the same time so we can fail fast on garbage
    // input instead of inserting and then erroring with an FK violation.
    const rawAssignments: Array<{ section_question_id: string; assignee_id: string | null; approver_id: string | null }> =
      Array.isArray(req.body.section_assignments)
        ? req.body.section_assignments.map((a: any) => ({
            section_question_id: trim(a?.section_question_id),
            assignee_id: trim(a?.assignee_id) || null,
            approver_id: trim(a?.approver_id) || null,
          })).filter((a: any) => a.section_question_id)
        : [];
    let validAssignments: Array<{ section_question_id: string; assignee_id: string | null; approver_id: string | null }> = [];
    if (rawAssignments.length > 0) {
      const sectionIds = rawAssignments.map((a) => a.section_question_id);
      const sections = await db
        .select({ id: checklistTemplateQuestions.id, type: checklistTemplateQuestions.type })
        .from(checklistTemplateQuestions)
        .where(and(
          eq(checklistTemplateQuestions.template_id, tpl.id),
          inArray(checklistTemplateQuestions.id, sectionIds),
        ));
      const sectionIdSet = new Set(sections.filter((s) => s.type === "section_heading").map((s) => s.id));
      validAssignments = rawAssignments.filter((a) => sectionIdSet.has(a.section_question_id));
      if (validAssignments.length !== rawAssignments.length) {
        throw new ApiError(400, "One or more section_question_id values don't belong to this template or aren't section headings");
      }
    }

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

    // Decide whether we can skip the manual-release step. We can iff there
    // is *some* way for the filler stage to resolve — an assigned user, a
    // template-level fill_role the filler page can match on, OR at least
    // one per-section assignment (in which case the assignees handle their
    // sections directly).
    const hasFiller = !!fill || !!tpl.fill_role || validAssignments.some((a) => a.assignee_id);
    const isEventBound = !!event_id && !!event_committee_id;

    const created = await db.transaction(async (tx) => {
      const [row] = await tx.insert(checklistInstances).values({
        template_id: tpl.id,
        title,
        event_id,
        notes,
        assigned_fill_user_id: fill,
        assigned_review_user_id: reviewer,
        created_by: req.user!.id,
        status: hasFiller ? "awaiting_fill" : "draft",
      }).returning();
      await tx.insert(checklistInstanceReviews).values({
        instance_id: row.id, actor_id: req.user!.id, action: "created",
      });
      if (hasFiller) {
        // Log the auto-release as a separate audit row so the timeline
        // doesn't lie about a missing transition.
        await tx.insert(checklistInstanceReviews).values({
          instance_id: row.id, actor_id: req.user!.id, action: "released",
          note: "Auto-released on creation",
        });
      }

      // Clone the template's current question list into the new instance's
      // private question table. From this point on, edits to this instance's
      // questions stay on the instance — they will not affect the parent
      // template or any sibling instance. (See migration 0053 + F19.)
      const tplQuestions = await tx
        .select()
        .from(checklistTemplateQuestions)
        .where(eq(checklistTemplateQuestions.template_id, tpl.id))
        .orderBy(asc(checklistTemplateQuestions.sort_order));
      const templateToInstanceQid = new Map<string, string>();
      if (tplQuestions.length > 0) {
        const clonedRows = await tx.insert(checklistInstanceQuestions).values(
          tplQuestions.map((q) => ({
            instance_id:                 row.id,
            sort_order:                  q.sort_order,
            type:                        q.type,
            label:                       q.label,
            help_text:                   q.help_text,
            required:                    q.required,
            config:                      q.config,
            section_owner_role:          q.section_owner_role,
            source_template_question_id: q.id,
          })),
        ).returning({ id: checklistInstanceQuestions.id, source: checklistInstanceQuestions.source_template_question_id });
        for (const c of clonedRows) {
          if (c.source) templateToInstanceQid.set(c.source, c.id);
        }
      }

      // Persist per-section filler + approver assignments (if the admin
      // chose any). Skip rows where BOTH assignee_id and approver_id are
      // null — those just mean "no override, fall back to the checklist-
      // level filler/reviewer" so there's no value in storing them. Each
      // row carries the legacy template-question id AND the new instance-
      // question id (mapped via the clone table above) so existing code
      // paths reading the legacy column keep working.
      const toInsert = validAssignments.filter((a) => a.assignee_id || a.approver_id);
      if (toInsert.length > 0) {
        await tx.insert(checklistInstanceSectionAssignments).values(
          toInsert.map((a) => ({
            instance_id:                  row.id,
            section_question_id:          a.section_question_id,
            instance_section_question_id: templateToInstanceQid.get(a.section_question_id) ?? null,
            assignee_id:                  a.assignee_id,
            approver_id:                  a.approver_id,
          })),
        );
      }
      return row;
    });

    // Stage rows live outside the create transaction because
    // ensureApprovalStages uses the top-level `db` handle (it's also called
    // from /release). Only event-bound, auto-released instances get stages.
    if (hasFiller && isEventBound) {
      await ensureApprovalStages(created.id, true);
    }

    // Notify everyone the admin just assigned. Fire-and-forget so a slow
    // SMTP call doesn't delay the create response. Skip in draft status —
    // the dedicated /release endpoint sends the notification instead so the
    // filler doesn't see a checklist that's still being set up.
    if (hasFiller) {
      const sectionsByUser = new Map<string, string[]>();
      if (validAssignments.length > 0) {
        // Resolve section_question_id → label for the body string.
        const headings = await db
          .select({ id: checklistTemplateQuestions.id, label: checklistTemplateQuestions.label })
          .from(checklistTemplateQuestions)
          .where(and(
            eq(checklistTemplateQuestions.template_id, tpl.id),
            inArray(checklistTemplateQuestions.id, validAssignments.map((a) => a.section_question_id)),
          ));
        const byId = new Map(headings.map((h) => [h.id, h.label]));
        for (const a of validAssignments) {
          if (!a.assignee_id) continue;
          const list = sectionsByUser.get(a.assignee_id) ?? [];
          list.push(byId.get(a.section_question_id) ?? "a section");
          sectionsByUser.set(a.assignee_id, list);
        }
      }
      const assignerName = await actorName(req.user!.id);
      const eventTitle = isEventBound ? (await instanceEventTitle(created.id)) : null;
      void notifyChecklistAssignees({
        instance_id:       created.id,
        assigner_name:     assignerName,
        checklist_title:   title,
        event_title:       eventTitle,
        primary_filler_id: fill,
        sectionsByUser,
        skip:              new Set([req.user!.id]),
      });
    }

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

    // Section assignees count toward "has a filler" too — if at least one
    // section is assigned, the instance is actionable.
    const [{ section_count }] = await db
      .select({ section_count: sql<number>`COUNT(*)::int`.as("section_count") })
      .from(checklistInstanceSectionAssignments)
      .where(and(
        eq(checklistInstanceSectionAssignments.instance_id, id),
        sql`${checklistInstanceSectionAssignments.assignee_id} IS NOT NULL`,
      ));
    const hasFiller = !!row.instance.assigned_fill_user_id || !!row.template.fill_role || (section_count ?? 0) > 0;
    if (!hasFiller) {
      throw new ApiError(400,
        "Cannot release — no filler assigned. Set a primary filler or at least one section assignment first.",
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

    // Notify assignees that the draft is now live and they can start.
    // The create endpoint deliberately skipped this for drafts; release
    // is when the filler is meant to see it for the first time.
    const sectionsByUser = await loadSectionsByUser(id);
    const assignerName = await actorName(req.user!.id);
    const eventTitle = !!row.instance.event_id ? (await instanceEventTitle(id)) : null;
    void notifyChecklistAssignees({
      instance_id:       id,
      assigner_name:     assignerName,
      checklist_title:   row.instance.title,
      event_title:       eventTitle,
      primary_filler_id: row.instance.assigned_fill_user_id,
      sectionsByUser,
      skip:              new Set([req.user!.id]),
    });

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
// Multi-stage approval is OPTIONAL per template (migration 0065). When an
// admin lists role codes in `checklist_templates.approver_role_codes`,
// every released event-bound instance from that template gets one approval
// stage per listed role. When the list is empty (the default), the
// instance uses the original single-reviewer flow and no Multi-stage panel
// renders on the UI.
//
// `cascade_checklist_approval_status` (migration 0025) is the SQL trigger
// that watches these stage rows and flips the parent instance.

// Human-readable labels for the role codes most commonly used as branch
// approvers. Anything not in this map falls back to a Title-Cased version
// of the role code so admins can experiment with custom roles without code
// changes.
const APPROVER_ROLE_LABELS: Record<string, string> = {
  branch_chairman:      "Branch Chairman — overall approval",
  branch_vice_chairman: "Vice-Chairman — agenda review",
  branch_secretary:     "Branch Secretary — final review",
  branch_treasurer:     "Treasurer — IUT / budget review",
};

function approverLabelFor(roleCode: string): string {
  if (APPROVER_ROLE_LABELS[roleCode]) return APPROVER_ROLE_LABELS[roleCode];
  // Fallback — turn "some_custom_role" → "Some Custom Role"
  return roleCode
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function ensureApprovalStages(instanceId: string, isEventBound: boolean) {
  if (!isEventBound) return;

  // Read the parent template's approver_role_codes. Empty array (the
  // default for every existing and new template) = single-reviewer flow,
  // so we return early without inserting any stage rows.
  const [inst] = await db
    .select({ template_id: checklistInstances.template_id })
    .from(checklistInstances)
    .where(eq(checklistInstances.id, instanceId))
    .limit(1);
  if (!inst) return;

  const [tmpl] = await db
    .select({ approver_role_codes: checklistTemplates.approver_role_codes })
    .from(checklistTemplates)
    .where(eq(checklistTemplates.id, inst.template_id))
    .limit(1);
  const roleCodes = (tmpl?.approver_role_codes ?? []).filter(Boolean);
  if (roleCodes.length === 0) return; // single-reviewer flow

  // INSERT ... ON CONFLICT keeps re-releases (after reject + reopen)
  // idempotent — existing stage rows are preserved with their statuses
  // so the chairman doesn't have to re-approve work they'd already signed off.
  for (let i = 0; i < roleCodes.length; i++) {
    const roleCode = roleCodes[i];
    await db.insert(checklistInstanceApprovals).values({
      instance_id:        instanceId,
      // Use the role code as the stage code so the trigger + admin
      // approve/reject endpoints can route to the right row.
      stage_code:         roleCode,
      stage_label:        approverLabelFor(roleCode),
      required_role_code: roleCode,
      sort_order:         (i + 1) * 10,
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
    const { row: before, perms } = await authorise(id, req.user!.id);
    if (!perms.canManage) throw new ApiError(403, "Admin only");

    const patch: Record<string, any> = {};
    if (req.body.title                    !== undefined) patch.title                    = need(trim(req.body.title), "Title");
    if (req.body.notes                    !== undefined) patch.notes                    = trim(req.body.notes) || null;
    if (req.body.assigned_fill_user_id    !== undefined) patch.assigned_fill_user_id    = trim(req.body.assigned_fill_user_id) || null;
    if (req.body.assigned_review_user_id  !== undefined) patch.assigned_review_user_id  = trim(req.body.assigned_review_user_id) || null;
    if (Object.keys(patch).length === 0) throw new ApiError(400, "Nothing to update");

    // ── Auto-release on filler assignment ───────────────────────────────
    // If the instance is still a draft and this PATCH gives it a filler
    // for the first time, transition it to 'awaiting_fill' (the same
    // status the dedicated /release endpoint sets). Without this, an
    // admin who creates a draft with no filler and later patches in an
    // assignee leaves the checklist invisible to that assignee — they
    // can't see drafts. The status mirrors what create-time does for the
    // same input: `hasFiller ? "awaiting_fill" : "draft"`.
    //
    // We only auto-release when transitioning from "no filler" to
    // "has filler". If a draft already had a filler (e.g. via template
    // fill_role or section assignments) the admin presumably wants the
    // explicit /release step.
    let willAutoRelease = false;
    if (before.instance.status === "draft" && patch.assigned_fill_user_id) {
      const beforeHadFiller = !!before.instance.assigned_fill_user_id
        || !!before.template.fill_role;
      if (!beforeHadFiller) {
        // Confirm there were no prior section assignments either —
        // those also count as "has a filler" per the /release endpoint.
        const [{ section_count }] = await db
          .select({ section_count: sql<number>`COUNT(*)::int`.as("section_count") })
          .from(checklistInstanceSectionAssignments)
          .where(and(
            eq(checklistInstanceSectionAssignments.instance_id, id),
            sql`${checklistInstanceSectionAssignments.assignee_id} IS NOT NULL`,
          ));
        if ((section_count ?? 0) === 0) {
          willAutoRelease = true;
          patch.status = "awaiting_fill";
        }
      }
    }

    const [row] = await db.update(checklistInstances).set(patch).where(eq(checklistInstances.id, id)).returning();
    if (req.body.assigned_fill_user_id !== undefined || req.body.assigned_review_user_id !== undefined) {
      await db.insert(checklistInstanceReviews).values({
        instance_id: id, actor_id: req.user!.id, action: "assigned",
      });
    }
    if (willAutoRelease) {
      await db.insert(checklistInstanceReviews).values({
        instance_id: id, actor_id: req.user!.id, action: "released",
        note: "Auto-released on filler assignment",
      });
      // Stage rows are only meaningful for event-bound instances.
      await ensureApprovalStages(id, !!before.instance.event_id && !!before.event_committee_id);
    }

    // Notify the NEW primary filler if they changed and it's not a draft.
    // (After an auto-release the status is no longer 'draft', so the
    // notification fires from the same gate as a normal PATCH on an
    // already-released instance.)
    const fillerChanged = req.body.assigned_fill_user_id !== undefined
      && patch.assigned_fill_user_id
      && patch.assigned_fill_user_id !== before.instance.assigned_fill_user_id
      && patch.assigned_fill_user_id !== req.user!.id
      && (before.instance.status !== "draft" || willAutoRelease);
    if (fillerChanged) {
      const assignerName = await actorName(req.user!.id);
      const eventTitle = !!before.instance.event_id ? (await instanceEventTitle(id)) : null;
      notifyChecklistAssigned({
        user_id:         patch.assigned_fill_user_id,
        assigner_name:   assignerName,
        checklist_title: row.title,
        event_title:     eventTitle,
        sections:        [],
        instance_id:     id,
      });
    }

    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PUT /api/checklist-instances/:id/questions ───────────────────────────
// Replace-all editor for the instance's question list. Admin-only — the
// branch staff who manage events use this to add event-specific items
// ("Speaker travel booking confirmed?"), remove inapplicable template
// items, or reword anything mid-prep. Edits stay on the instance and do
// NOT propagate back to the template.
//
// Body:
//   { questions: [{
//       id?: uuid,                         // present = update existing row
//       type: 'section_heading' | 'short_text' | 'long_text' | 'checkbox' |
//             'single_select' | 'multi_select' | 'date' | 'number' |
//             'file' | 'task_list' | …                (matches enum)
//       label: string,
//       help_text?: string|null,
//       required: boolean,
//       config: object,
//       sort_order: number,
//       section_owner_role?: string|null   // only meaningful on section_heading
//   }] }
//
// Behaviour:
//   • Questions with an id matching an existing row → UPDATE in place
//     (preserves any stored answers in checklist_instance_responses since
//     the FK is keyed to this question's id).
//   • Questions without an id → INSERT new (gets a fresh UUID).
//   • Existing questions whose id is absent from the body → DELETE
//     (cascades into responses + section_assignments).
//
// Allowed only while the instance is editable (awaiting_fill / rejected /
// draft). Once submitted or approved, the question set is locked.
checklistInstancesRouter.put("/:id/questions", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { row, perms } = await authorise(id, req.user!.id);
    if (!perms.canManage) throw new ApiError(403, "Admin only");
    if (!["awaiting_fill", "rejected", "draft"].includes(row.instance.status)) {
      throw new ApiError(400, "Questions can only be edited while the checklist is awaiting fill, rejected, or in draft");
    }

    const incoming: Array<{
      id?: string;
      type: string;
      label: string;
      help_text?: string | null;
      required: boolean;
      config: Record<string, unknown>;
      sort_order: number;
      section_owner_role?: string | null;
    }> = Array.isArray(req.body?.questions) ? req.body.questions : [];

    if (incoming.length === 0) {
      throw new ApiError(400, "A checklist must have at least one question");
    }
    for (const q of incoming) {
      if (!q.label || typeof q.label !== "string" || !q.label.trim()) {
        throw new ApiError(400, "Every question needs a label");
      }
      if (!q.type || typeof q.type !== "string") {
        throw new ApiError(400, "Every question needs a type");
      }
    }

    // Snapshot existing rows so we can compute the delete set.
    const existing = await db
      .select({ id: checklistInstanceQuestions.id })
      .from(checklistInstanceQuestions)
      .where(eq(checklistInstanceQuestions.instance_id, id));
    const existingIds = new Set(existing.map((r) => r.id));
    const keptIds = new Set(incoming.filter((q) => q.id).map((q) => q.id as string));
    const toDelete: string[] = [...existingIds].filter((eid) => !keptIds.has(eid));

    await db.transaction(async (tx) => {
      // 1) Delete removed rows first. Cascading FK on responses +
      // section_assignments takes care of their dependent rows.
      if (toDelete.length > 0) {
        await tx.delete(checklistInstanceQuestions)
          .where(and(
            eq(checklistInstanceQuestions.instance_id, id),
            inArray(checklistInstanceQuestions.id, toDelete),
          ));
      }

      // 2) Update existing + insert new.
      for (const q of incoming) {
        const payload = {
          sort_order:         q.sort_order ?? 0,
          type:               q.type as any,
          label:              q.label.trim(),
          help_text:          q.help_text ?? null,
          required:           !!q.required,
          config:             (q.config ?? {}) as any,
          section_owner_role: q.type === "section_heading" ? (q.section_owner_role ?? null) : null,
          updated_at:         new Date(),
        };
        if (q.id && existingIds.has(q.id)) {
          await tx.update(checklistInstanceQuestions)
            .set(payload)
            .where(and(
              eq(checklistInstanceQuestions.id, q.id),
              eq(checklistInstanceQuestions.instance_id, id),
            ));
        } else {
          await tx.insert(checklistInstanceQuestions).values({
            instance_id: id,
            ...payload,
          });
        }
      }

      // 3) Touch parent so updated_at advances + audit row.
      await tx.update(checklistInstances)
        .set({ updated_at: new Date() })
        .where(eq(checklistInstances.id, id));
      await tx.insert(checklistInstanceReviews).values({
        instance_id: id, actor_id: req.user!.id, action: "edited",
        note: `Question list updated (${incoming.length} item${incoming.length === 1 ? "" : "s"}${
          toDelete.length > 0 ? `, ${toDelete.length} removed` : ""
        })`,
      });
    });

    res.json({ ok: true, count: incoming.length, removed: toDelete.length });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PUT /api/checklist-instances/:id/section-assignments ─────────────────
// Replace-all reassignment of per-section fillers. Body:
//   { assignments: [{ section_question_id, assignee_id|null }] }
// Rows with assignee_id=null are dropped (no-assignment is the default).
//
// Admin-only — section assignment is part of "managing" the instance.
checklistInstancesRouter.put("/:id/section-assignments", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { row, perms } = await authorise(id, req.user!.id);
    if (!perms.canManage) throw new ApiError(403, "Admin only");

    const incoming: Array<{ section_question_id: string; assignee_id: string | null }> =
      Array.isArray(req.body?.assignments)
        ? req.body.assignments.map((a: any) => ({
            section_question_id: trim(a?.section_question_id),
            assignee_id: trim(a?.assignee_id) || null,
          })).filter((a: any) => a.section_question_id)
        : [];

    if (incoming.length > 0) {
      // section_question_id values now refer to instance question rows
      // (per migration 0053). Validate against this instance's question
      // list rather than the template.
      const sectionIds = incoming.map((a) => a.section_question_id);
      const sections = await db
        .select({ id: checklistInstanceQuestions.id, type: checklistInstanceQuestions.type })
        .from(checklistInstanceQuestions)
        .where(and(
          eq(checklistInstanceQuestions.instance_id, id),
          inArray(checklistInstanceQuestions.id, sectionIds),
        ));
      const validSet = new Set(sections.filter((s) => s.type === "section_heading").map((s) => s.id));
      if (incoming.some((a) => !validSet.has(a.section_question_id))) {
        throw new ApiError(400, "One or more section_question_id values aren't section headings on this instance");
      }
    }

    const toInsert = incoming.filter((a) => a.assignee_id);

    // Snapshot the previous assignments so we can fire notifications ONLY
    // for users who are newly assigned (or newly assigned to a section
    // they didn't own before). Querying inside the txn keeps it consistent
    // with the wipe+recreate below. We snapshot the new instance_question
    // id so the prevKey matches the incoming format.
    const previous = await db
      .select({
        assignee_id:         checklistInstanceSectionAssignments.assignee_id,
        section_question_id: sql<string>`COALESCE(${checklistInstanceSectionAssignments.instance_section_question_id}, ${checklistInstanceSectionAssignments.section_question_id})`.as("section_question_id"),
      })
      .from(checklistInstanceSectionAssignments)
      .where(eq(checklistInstanceSectionAssignments.instance_id, id));
    const prevKey = new Set(previous.map((p) => `${p.assignee_id}:${p.section_question_id}`));

    await db.transaction(async (tx) => {
      // Wipe + recreate. Row count per instance is tiny (one per section,
      // typically 3-7); avoiding a complex diff keeps the path obvious.
      await tx.delete(checklistInstanceSectionAssignments)
        .where(eq(checklistInstanceSectionAssignments.instance_id, id));
      if (toInsert.length > 0) {
        await tx.insert(checklistInstanceSectionAssignments).values(
          toInsert.map((a) => ({
            instance_id:                  id,
            instance_section_question_id: a.section_question_id,
            assignee_id:                  a.assignee_id!,
          })),
        );
      }
      await tx.insert(checklistInstanceReviews).values({
        instance_id: id, actor_id: req.user!.id, action: "assigned",
        note: `Section assignments updated (${toInsert.length} section${toInsert.length === 1 ? '' : 's'} assigned)`,
      });
    });

    // Notify users who gained a new section assignment. Re-assigning the
    // same user to the same section is silent (they already know).
    const fresh = toInsert.filter((a) => !prevKey.has(`${a.assignee_id}:${a.section_question_id}`));
    if (fresh.length > 0 && row.instance.status !== "draft") {
      // Group new sections per user so each gets ONE notification listing
      // all their new sections, not N separate emails.
      // section_question_id here is now an instance question id, not a
      // template question id, so we look up labels on the instance side.
      const headings = await db
        .select({ id: checklistInstanceQuestions.id, label: checklistInstanceQuestions.label })
        .from(checklistInstanceQuestions)
        .where(inArray(checklistInstanceQuestions.id, fresh.map((a) => a.section_question_id)));
      const labelById = new Map(headings.map((h) => [h.id, h.label]));
      const newSectionsByUser = new Map<string, string[]>();
      for (const a of fresh) {
        const list = newSectionsByUser.get(a.assignee_id!) ?? [];
        list.push(labelById.get(a.section_question_id) ?? "a section");
        newSectionsByUser.set(a.assignee_id!, list);
      }
      const assignerName = await actorName(req.user!.id);
      const eventTitle = !!row.instance.event_id ? (await instanceEventTitle(id)) : null;
      for (const [user_id, sections] of newSectionsByUser) {
        if (user_id === req.user!.id) continue;
        notifyChecklistAssigned({
          user_id,
          assigner_name:   assignerName,
          checklist_title: row.instance.title,
          event_title:     eventTitle,
          sections,
          instance_id:     id,
        });
      }
    }

    res.json({ ok: true, count: toInsert.length });
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
// Section ownership semantics (REVISED): the `section_owner_role` field on
// section_heading rows now denotes "who REVIEWS this section" — it drives
// the multi-stage approval routing (treasurer reviews Budget & IUT, VC
// reviews Speakers & Agenda, etc.). It does NOT restrict who can fill the
// section. The committee chairman fills the ENTIRE checklist; the reviewers
// only see / approve their assigned slice afterwards.
//
// Older logic forced the treasurer (or whichever role owned a section) to
// log in and edit their section themselves — that's not how the branch
// actually works. The committee chairman is the single filler.
//
// Task lists: when a question of type `task_list` is saved, we reconcile
// the response value into the dedicated `checklist_task_assignments`
// table — tear down + recreate the rows for that response. New assignees
// get an email + in-app notification via the existing notify() dispatcher.
checklistInstancesRouter.put("/:id/responses", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { row, perms } = await authorise(id, req.user!.id);
    if (!perms.canFill && !perms.canFillSections) {
      throw new ApiError(403, "You can't fill this checklist");
    }
    if (!["awaiting_fill", "rejected"].includes(row.instance.status)) {
      throw new ApiError(400, "Checklist is not editable in its current state");
    }

    const incoming = (req.body && typeof req.body.responses === "object") ? req.body.responses : {};
    const questions = await db
      .select()
      .from(checklistInstanceQuestions)
      .where(eq(checklistInstanceQuestions.instance_id, id));

    // Build a map from every question id → the section_heading id that
    // precedes it (or null for questions before any heading). Used to:
    //   • block section-only fillers from questions outside their sections
    //   • block the PRIMARY filler from questions inside a section that
    //     was explicitly assigned to someone else (per-section takes
    //     precedence over the checklist-level default)
    const sorted = [...questions].sort((a, b) => a.sort_order - b.sort_order);
    const sectionMap: Map<string, string | null> = new Map();
    let currentSection: string | null = null;
    for (const q of sorted) {
      if (q.type === "section_heading") {
        currentSection = q.id;
        sectionMap.set(q.id, q.id); // a section heading "belongs to itself"
      } else {
        sectionMap.set(q.id, currentSection);
      }
    }
    const allowedSections = new Set(perms.mySectionIds || []);
    const lockedSections = new Set(perms.lockedSectionIds || []);

    // Build (question, cleanedValue) pairs. Validation is "best effort"
    // here — required checking happens at /submit so save-progress works.
    // Access rules per question:
    //   • Section-only filler: allowed only if the question's section is
    //     in their allowedSections set.
    //   • Primary filler (canFill=true): allowed EXCEPT when the section
    //     was explicitly assigned to somebody else (lockedSections) and
    //     the primary isn't also the section's assignee.
    const pairs: { question: typeof questions[number]; value: unknown }[] = [];
    for (const q of questions) {
      const has = Object.prototype.hasOwnProperty.call(incoming, q.id);
      if (!has) continue;
      const sec = sectionMap.get(q.id);
      if (!perms.canFill) {
        // Section-only filler — must own the section.
        if (!sec || !allowedSections.has(sec)) {
          throw new ApiError(403, `You can't edit "${q.label}" — it's outside your assigned section(s).`);
        }
      } else {
        // Primary filler — check for a section-specific lock.
        if (sec && lockedSections.has(sec) && !allowedSections.has(sec)) {
          throw new ApiError(403, `You can't edit "${q.label}" — this section is assigned to another filler.`);
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
        // Upsert the response row. We write to the new
        // `instance_question_id` column (introduced in migration 0053);
        // the legacy `question_id` is left unset on new rows.
        const [resp] = await tx
          .insert(checklistInstanceResponses)
          .values({ instance_id: id, instance_question_id: p.question.id, value: p.value as any })
          .onConflictDoUpdate({
            target: [checklistInstanceResponses.instance_id, checklistInstanceResponses.instance_question_id],
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
          checklist_link: `${process.env.APP_URL ?? ""}/my-checklists?id=${id}`,
        },
        link_url: `/my-checklists?id=${id}`,
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
      .from(checklistInstanceQuestions)
      .where(eq(checklistInstanceQuestions.instance_id, id));

    const stored = await db
      .select()
      .from(checklistInstanceResponses)
      .where(eq(checklistInstanceResponses.instance_id, id));
    const byQ: Record<string, unknown> = {};
    for (const r of stored) {
      const key = r.instance_question_id ?? r.question_id;
      if (key) byQ[key as string] = r.value;
    }

    // Scope the required-check to the caller's fill rights so a section-only
    // filler can submit once THEIR sections are complete, without waiting on
    // other section fillers. The reviewer sees the whole checklist and can
    // send it back if any required question is still empty.
    //   • Primary filler (canFill) with no locked-out sections → validate
    //     everything (original behaviour).
    //   • Primary filler with some sections locked → validate everything
    //     EXCEPT the locked sections' questions.
    //   • Section-only filler → validate only questions in the sections
    //     they own; questions before any section_heading are validated as
    //     well when the caller is the primary.
    const sortedQ = [...questions].sort((a, b) => a.sort_order - b.sort_order);
    const sectionOfQ = new Map<string, string | null>();
    let currentSec: string | null = null;
    for (const q of sortedQ) {
      if (q.type === "section_heading") {
        currentSec = q.id;
        sectionOfQ.set(q.id, q.id);
      } else {
        sectionOfQ.set(q.id, currentSec);
      }
    }
    const myFillerSections = new Set(perms.mySectionIds || []);
    const lockedSections = new Set(perms.lockedSectionIds || []);
    const shouldValidate = (q: typeof questions[number]): boolean => {
      if (q.type === "section_heading") return false;
      const sec = sectionOfQ.get(q.id);
      if (perms.canFill) {
        // Primary filler — validate questions unless they're locked to
        // another user's section.
        if (sec && lockedSections.has(sec) && !myFillerSections.has(sec)) return false;
        return true;
      }
      // Section-only filler — only questions inside their sections.
      if (!sec) return false;
      return myFillerSections.has(sec);
    };

    const missing: string[] = [];
    for (const q of questions) {
      if (!shouldValidate(q)) continue;
      try {
        validateResponseValue(q.type as QuestionType, q.required, q.config, byQ[q.id] ?? null);
      } catch {
        missing.push(q.label);
      }
    }
    if (missing.length > 0) {
      const scope = perms.canFill ? "" : " for your section(s)";
      const preview = missing.slice(0, 3).join(", ");
      throw new ApiError(400, `Fill all required items${scope} first (${missing.length} missing: ${preview}${missing.length > 3 ? "…" : ""})`);
    }

    const [updated] = await db.update(checklistInstances)
      .set({ status: "awaiting_review", submitted_at: new Date() })
      .where(eq(checklistInstances.id, id))
      .returning();
    await db.insert(checklistInstanceReviews).values({
      instance_id: id, actor_id: req.user!.id, action: "submitted",
      note: trim(req.body?.note) || null,
    });

    // Tell the reviewer there's something waiting. For event-bound
    // instances with multi-stage approval, also nudge the treasurer + VC
    // — each stage has its own decider, and waiting for the chairman to
    // forward the work would slow approvals down.
    const fillerName = await actorName(req.user!.id);
    const eventTitle = !!row.instance.event_id ? (await instanceEventTitle(id)) : null;
    const reviewerIds = new Set<string>();
    if (row.instance.assigned_review_user_id) reviewerIds.add(row.instance.assigned_review_user_id);
    // Stage reviewers — multi-stage approval is opt-in per template via
    // checklist_templates.approver_role_codes (migration 0065). When the
    // admin configured it, ping every listed role's active holder so the
    // approvals don't serialise through the chairman. When empty (default),
    // fall back to the template's single review_role.
    const approverRoles = Array.isArray(row.template.approver_role_codes)
      ? row.template.approver_role_codes.filter(Boolean) as string[]
      : [];
    if (!!row.instance.event_id && approverRoles.length > 0) {
      for (const code of approverRoles) {
        const uid = await findActiveRoleHolder(code);
        if (uid) reviewerIds.add(uid);
      }
    } else if (row.template.review_role) {
      const uid = await findActiveRoleHolder(row.template.review_role);
      if (uid) reviewerIds.add(uid);
    }
    // Per-section approvers — the admin can pin a specific reviewer to any
    // section. Notify them too so the person actually assigned by the admin
    // hears about the submission, not just the auto-resolved role holder.
    const sectionApproverRows = await db
      .select({ approver_id: checklistInstanceSectionAssignments.approver_id })
      .from(checklistInstanceSectionAssignments)
      .where(and(
        eq(checklistInstanceSectionAssignments.instance_id, id),
        isNotNull(checklistInstanceSectionAssignments.approver_id),
      ));
    for (const r of sectionApproverRows) {
      if (r.approver_id) reviewerIds.add(r.approver_id);
    }
    for (const uid of reviewerIds) {
      if (uid === req.user!.id) continue; // don't notify yourself
      notifyAsync({
        user_id: uid,
        template_key: "checklist_submitted",
        vars: {
          filler_name:     fillerName,
          checklist_title: row.instance.title,
          event_title:     eventTitle ?? "",
          event_clause:    eventTitle ? `Event: ${eventTitle}.\n\n` : "",
          checklist_link:  `${process.env.APP_URL ?? ""}${checklistLink(id)}`,
        },
        link_url: checklistLink(id),
      });
    }

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

    // Notify the filler(s) so they know their submission cleared without
    // having to log in and check.
    await notifyChecklistReviewOutcome({
      instanceId: id,
      row,
      reviewerId: req.user!.id,
      templateKey: "checklist_approved",
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
      // 0. Guard: if the linked event is already published (e.g. someone
      //    used the override path earlier) or has already happened, refuse.
      //    Silently flipping a published event with paid registrations to
      //    'cancelled' would leave attendees with refund obligations and
      //    no notification. Force the chairman to cancel the event
      //    explicitly first.
      //    Lock the event row to keep the check atomic with the cancel.
      if (row.instance.event_id) {
        const [linkedEvent] = await tx
          .select({ id: events.id, status: events.status })
          .from(events)
          .where(eq(events.id, row.instance.event_id))
          .for("update")
          .limit(1);
        if (linkedEvent && (linkedEvent.status === "published" || linkedEvent.status === "completed")) {
          throw new ApiError(400,
            `Cannot terminally reject this checklist — its event is already ${linkedEvent.status}. ` +
            `Cancel the event first (which will notify registered attendees) before rejecting the checklist.`,
          );
        }
      }

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

    // Notify everyone who filled it. Whole-instance filler + role-holder
    // + every per-section assignee gets the "sent back" ping so they can
    // fix and re-submit without having to hunt for updates.
    await notifyChecklistReviewOutcome({
      instanceId: id,
      row,
      reviewerId: req.user!.id,
      templateKey: "checklist_rejected",
      note,
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
// Soft-delete. Refuses if the linked event is already public-facing —
// deleting a checklist out from under a published/completed event would
// leave it "naked" (visible to members with no audit trail behind it).
// Always writes a review row so the timeline shows the delete + actor.
checklistInstancesRouter.delete("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { row: instanceRow, perms } = await authorise(id, req.user!.id);
    if (!perms.canManage) throw new ApiError(403, "Admin only");

    // Block delete if the linked event is published or completed. Members
    // would still see the event with no checklist backing it — an orphaned
    // state we can't recover from cleanly.
    if (instanceRow.instance.event_id) {
      const [linkedEvent] = await db
        .select({ status: events.status })
        .from(events)
        .where(eq(events.id, instanceRow.instance.event_id))
        .limit(1);
      if (linkedEvent && (linkedEvent.status === "published" || linkedEvent.status === "completed")) {
        throw new ApiError(400,
          `Cannot delete this checklist — its event is ${linkedEvent.status}. ` +
          `Cancel the event first if you really need to remove the checklist.`,
        );
      }
    }

    await db.transaction(async (tx) => {
      const [row] = await tx.update(checklistInstances)
        .set({ deleted_at: new Date() })
        .where(eq(checklistInstances.id, id))
        .returning();
      if (!row) throw new ApiError(404, "Not found");
      await tx.insert(checklistInstanceReviews).values({
        instance_id: id,
        actor_id: req.user!.id,
        action: "deleted",
        note: trim(req.body?.note) || null,
      });
    });
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
