import { Router } from "express";
import { aliasedTable, and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import {
  checklistInstanceApprovals,
  checklistInstances,
  checklistTemplates,
  events,
  committees,
  users,
} from "../../../schema/index.js";
import { loadUserPermissions } from "../../auth/permissions.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { handleApiError, trim } from "../../lib/apiError.js";

export const approvalsAdminRouter = Router();

// ─── GET /api/admin/approvals ────────────────────────────────────────────
// Cross-cutting approval list. Used by the new /admin/approvals page.
//
// Each row is one stage on one event-bound checklist instance. The list
// is scoped server-side so each viewer sees only what they're entitled to:
//   - admin / branch_chairman / VC / secretary: every stage on every
//     event (filterable by ?committee_id=…)
//   - branch_treasurer: every event's stages (so the treasurer sees the
//     other approvers' status too — read-only)
//   - committee_chairman: only stages on events from their committees
//
// Filters:
//   ?stage=branch_chairman|treasurer_iut|vc_agenda
//   ?status=pending|approved|rejected
//   ?committee_id=<uuid>
//
// Returns a shape compatible with InboxCard.jsx so the frontend can reuse
// it without bespoke styling.
approvalsAdminRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const perms = await loadUserPermissions(req.user!.id);
    const isBranchLevel = perms.isAdmin
      || perms.codes.has("branch_chairman")
      || perms.codes.has("branch_vice_chairman")
      || perms.codes.has("branch_secretary")
      || perms.codes.has("branch_treasurer")
      || perms.codes.has("branch_manager");

    const stageFilter = trim(req.query.stage);
    const statusFilter = trim(req.query.status);
    const committeeFilter = trim(req.query.committee_id);

    const conds: any[] = [
      isNull(checklistInstances.deleted_at),
    ];
    if (stageFilter)  conds.push(eq(checklistInstanceApprovals.stage_code, stageFilter));
    if (statusFilter) conds.push(eq(checklistInstanceApprovals.status, statusFilter));
    if (committeeFilter) conds.push(eq(events.committee_id, committeeFilter));

    // Committee chairman scoping: only their committees' events.
    if (!isBranchLevel) {
      if (perms.committeeChairmanOf.length === 0) {
        return res.json({ rows: [], total: 0 });
      }
      conds.push(sql`${events.committee_id} = ANY(${perms.committeeChairmanOf})`);
    }

    const deciderU = aliasedTable(users, "decider_u");

    const rows = await db
      .select({
        // Stage identifiers
        approval_id:        checklistInstanceApprovals.id,
        stage_code:         checklistInstanceApprovals.stage_code,
        stage_label:        checklistInstanceApprovals.stage_label,
        required_role_code: checklistInstanceApprovals.required_role_code,
        status:             checklistInstanceApprovals.status,
        decided_by_name:    deciderU.name,
        decided_at:         checklistInstanceApprovals.decided_at,
        note:               checklistInstanceApprovals.note,
        escalated_at:       checklistInstanceApprovals.escalated_at,
        // Parent instance + event
        instance_id:        checklistInstances.id,
        instance_status:    checklistInstances.status,
        submitted_at:       checklistInstances.submitted_at,
        template_name:      checklistTemplates.name,
        event_id:           events.id,
        event_title:        events.title,
        event_starts_at:    events.starts_at,
        event_ends_at:      events.ends_at,
        committee_id:       committees.id,
        committee_code:     committees.code,
        committee_name:     committees.name,
      })
      .from(checklistInstanceApprovals)
      .innerJoin(checklistInstances, eq(checklistInstances.id, checklistInstanceApprovals.instance_id))
      .leftJoin(checklistTemplates, eq(checklistTemplates.id, checklistInstances.template_id))
      .leftJoin(events, eq(events.id, checklistInstances.event_id))
      .leftJoin(committees, eq(committees.id, events.committee_id))
      .leftJoin(deciderU, eq(deciderU.id, checklistInstanceApprovals.decided_by))
      .where(and(...conds))
      .orderBy(
        // Pending first (so the inbox shows actionable items at the top),
        // then by event start so post-event stages bubble up over upcoming.
        sql`CASE WHEN ${checklistInstanceApprovals.status} = 'pending' THEN 0
                 WHEN ${checklistInstanceApprovals.status} = 'rejected' THEN 1
                 ELSE 2 END`,
        asc(events.starts_at),
      )
      .limit(200);

    res.json({ rows, total: rows.length });
  } catch (err) { handleApiError(err, res, next); }
});
