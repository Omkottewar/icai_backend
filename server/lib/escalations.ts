// Escalation cron — sweeps checklist_instance_approvals rows where:
//   - stage status is still 'pending'
//   - the linked event ended more than 3 days ago (ends_at + 3d < now)
//   - escalated_at IS NULL (so we don't double-send)
//
// For each match, we fire notification template S.11
// ('checklist_pending_approval') addressed to the branch chairperson —
// the person who's accountable for closing out post-event paperwork.
//
// Implementation choice: simple setInterval on the Node process. For a
// branch with ~100 events/year and a 3-day window, the working set is
// tiny (single-digit rows on a typical day). No queue / job-scheduler
// dependency needed.
//
// Idempotency: the escalated_at column is set after a successful notify
// dispatch, so the same row won't be picked up twice. If notify fails the
// timestamp isn't set, and the next tick retries.

import { and, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  checklistInstanceApprovals,
  checklistInstances,
  events,
  roles,
  userRoleAssignments,
} from "../../schema/index.js";
import { notify } from "./notify.js";

const ESCALATION_AFTER_DAYS = 3;
// Polling interval. Hourly is fine for a 3-day window — even if we miss the
// first hour after a row becomes eligible, the chairman is only "1 hour late
// out of 72". Don't go shorter without a reason (DB load is cheap but mail
// rate-limits aren't).
const TICK_INTERVAL_MS = 60 * 60 * 1000;

type EscalationCandidate = {
  approval_id: string;
  instance_id: string;
  stage_code: string;
  stage_label: string;
  event_id: string | null;
  event_title: string | null;
};

/**
 * Find escalation candidates — pending stages on events that ended ≥3 days
 * ago and haven't been escalated yet.
 */
async function findCandidates(): Promise<EscalationCandidate[]> {
  return db
    .select({
      approval_id:  checklistInstanceApprovals.id,
      instance_id:  checklistInstances.id,
      stage_code:   checklistInstanceApprovals.stage_code,
      stage_label:  checklistInstanceApprovals.stage_label,
      event_id:     events.id,
      event_title:  events.title,
    })
    .from(checklistInstanceApprovals)
    .innerJoin(checklistInstances, eq(checklistInstances.id, checklistInstanceApprovals.instance_id))
    .innerJoin(events, eq(events.id, checklistInstances.event_id))
    .where(and(
      eq(checklistInstanceApprovals.status, "pending"),
      isNull(checklistInstanceApprovals.escalated_at),
      // ends_at + N days < now → ends_at < now - N days
      lt(events.ends_at, sql`NOW() - INTERVAL '${sql.raw(String(ESCALATION_AFTER_DAYS))} days'`),
    ));
}

/** Currently active branch chairperson (the escalation target). */
async function findChairperson(): Promise<string | null> {
  const today = new Date().toISOString().slice(0, 10);
  const [row] = await db
    .select({ user_id: userRoleAssignments.user_id })
    .from(userRoleAssignments)
    .innerJoin(roles, eq(roles.id, userRoleAssignments.role_id))
    .where(and(
      eq(roles.code, "branch_chairman"),
      sql`(${userRoleAssignments.effective_to} IS NULL OR ${userRoleAssignments.effective_to} >= ${today})`,
    ))
    .limit(1);
  return row?.user_id ?? null;
}

/** Run one sweep. Exported so the test harness / admin trigger can call it. */
export async function runEscalationSweep(): Promise<{ checked: number; escalated: number }> {
  const candidates = await findCandidates();
  if (candidates.length === 0) return { checked: 0, escalated: 0 };

  const chairperson = await findChairperson();
  if (!chairperson) {
    // No chairperson assigned yet — bail. We don't escalate to a non-target;
    // the next tick will retry once one is assigned.
    return { checked: candidates.length, escalated: 0 };
  }

  let escalated = 0;
  for (const c of candidates) {
    // Fire S.11 ('checklist_pending_approval') — the template was seeded in
    // migration 0016. Vars match the placeholders in that template body.
    const result = await notify({
      user_id: chairperson,
      template_key: "checklist_pending_approval",
      vars: {
        approver_name: "Chairperson",
        event_title:   c.event_title ?? c.stage_label,
        event_date:    "post-event",
        checklist_link: `${process.env.APP_URL ?? ""}/#/my-checklists?id=${c.instance_id}`,
        sla_days:      ESCALATION_AFTER_DAYS,
      },
    });
    if (result) {
      // Mark this row escalated so the next tick skips it. We do this even
      // if some channel (email) failed — the row was attempted; spamming
      // every hour is worse than missing one specific channel.
      await db.update(checklistInstanceApprovals)
        .set({ escalated_at: new Date() })
        .where(eq(checklistInstanceApprovals.id, c.approval_id));
      escalated++;
    }
  }
  return { checked: candidates.length, escalated };
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/** Start the cron. Called once from server/index.ts at boot. */
export function startEscalationCron() {
  if (intervalHandle) return;
  // Fire a first sweep ~30s after boot so the dev workflow shows activity
  // without waiting an hour. The setInterval handles the steady cadence.
  setTimeout(() => {
    runEscalationSweep().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[escalations] initial sweep failed", err);
    });
  }, 30_000);

  intervalHandle = setInterval(() => {
    runEscalationSweep().catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[escalations] sweep failed", err);
    });
  }, TICK_INTERVAL_MS);
}

/** Stop the cron — useful for test teardown. */
export function stopEscalationCron() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
