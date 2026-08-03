// Audit + version-history helpers.
//
// Two writes live here:
//
//   logAudit()   — append-only firehose. Every write should call this
//                  after the DB mutation succeeds. Cheap and non-fatal:
//                  a failed audit insert is logged but does NOT roll back
//                  the caller's transaction. This is deliberate — we'd
//                  rather have a missing audit row than reject a valid
//                  business write because the audit table is down.
//
//   saveVersion() — full-snapshot rows for entities that want queryable
//                   history (checklists, site content, events, etc.).
//                   Version numbering is monotonic per (entity_type,
//                   entity_id); we look up the current max and add 1 in
//                   the same round-trip via a UNIQUE index conflict
//                   fallback. Also non-fatal.
//
// Both helpers accept an `actor` object rather than pulling from a global
// so callers stay explicit about who's doing what — no thread-local
// magic. Every route already has `req.user` from the auth middleware; we
// just pass it in.
//
// Design note: this file has zero dependency on Express — routes call it
// after they've done their business logic. Cron jobs / background workers
// use it the same way, passing `actor_user_id = null` for system writes.

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { auditLog, entityVersions } from "../../schema/index.js";

export type AuditAction =
  | "created"
  | "updated"
  | "deleted"
  | "status_changed"
  | "reassigned"
  | (string & {}); // allow custom actions ("recommended_firms", "cancelled", …)

export interface AuditActor {
  user_id: string | null;
  ip?: string | null;
  role_code?: string | null;
}

export interface LogAuditInput {
  entity_type: string;
  entity_id: string | null;
  action: AuditAction;
  actor: AuditActor;
  before?: unknown;   // prior state — null / undefined on 'created'
  after?: unknown;    // new state   — null / undefined on 'deleted'
  changed_fields?: string[]; // caller can pass explicit list, or we'll compute
  note?: string | null;
}

/**
 * Append an audit-log row. Never throws — failures are logged and swallowed
 * so a broken audit table can't take down business writes.
 */
export async function logAudit(input: LogAuditInput): Promise<void> {
  try {
    const changed = input.changed_fields ?? diffKeys(input.before, input.after);
    await db.insert(auditLog).values({
      actor_user_id:   input.actor.user_id,
      actor_ip:        input.actor.ip ?? null,
      actor_role_code: input.actor.role_code ?? null,
      entity_type:     input.entity_type,
      entity_id:       input.entity_id,
      action:          input.action,
      changed_fields:  changed,
      before_json:     input.before == null ? null : (input.before as any),
      after_json:      input.after  == null ? null : (input.after  as any),
      note:            input.note ?? null,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[audit] logAudit failed", { entity_type: input.entity_type, entity_id: input.entity_id, err });
  }
}

export interface SaveVersionInput {
  entity_type: string;
  entity_id: string;
  snapshot: unknown;
  actor: AuditActor;
  change_note?: string | null;
}

/**
 * Persist a full snapshot of an entity as the next version. Version
 * numbers are monotonic per (entity_type, entity_id) — we look up the
 * current max and increment. Concurrent versioning on the same entity is
 * rare in practice; the UNIQUE index guarantees safety even under a
 * race (the second writer will conflict and retry).
 */
export async function saveVersion(input: SaveVersionInput): Promise<void> {
  try {
    // 3 retries — the constraint conflict on (entity_type, entity_id,
    // version_number) is essentially impossible with normal admin
    // concurrency, but we're defensive because a stuck retry loop would
    // block a legitimate write.
    for (let attempt = 0; attempt < 3; attempt++) {
      const [{ max }] = await db.select({
        max: sql<number>`COALESCE(MAX(${entityVersions.version_number}), 0)`.as("max"),
      })
        .from(entityVersions)
        .where(and(
          eq(entityVersions.entity_type, input.entity_type),
          eq(entityVersions.entity_id, input.entity_id),
        ));
      const nextVersion = Number(max) + 1;
      try {
        await db.insert(entityVersions).values({
          entity_type:      input.entity_type,
          entity_id:        input.entity_id,
          version_number:   nextVersion,
          saved_by_user_id: input.actor.user_id,
          change_note:      input.change_note ?? null,
          snapshot_json:    input.snapshot as any,
        });
        return;
      } catch (err: any) {
        // 23505 — unique_violation. Another writer beat us to the
        // version number; loop and try nextVersion+1.
        if (err?.code === "23505" && attempt < 2) continue;
        throw err;
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[audit] saveVersion failed", { entity_type: input.entity_type, entity_id: input.entity_id, err });
  }
}

/**
 * Convenience — for routes that both mutate and want a full version
 * snapshot in one go. Fires logAudit AND saveVersion. Order: audit
 * first (cheap), then version (more expensive). Both non-fatal.
 */
export async function auditAndVersion(input: LogAuditInput & { snapshot: unknown }): Promise<void> {
  await logAudit(input);
  if (input.entity_id) {
    await saveVersion({
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      snapshot: input.snapshot,
      actor: input.actor,
      change_note: input.note ?? null,
    });
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────

/**
 * Given the before/after snapshots, return the list of top-level keys
 * whose values actually changed. Shallow compare — deep objects are
 * compared by reference equality, which is fine for the flat DB row
 * shapes we typically snapshot.
 */
function diffKeys(before: unknown, after: unknown): string[] {
  if (before == null || after == null) return [];
  if (typeof before !== "object" || typeof after !== "object") return [];
  const a = before as Record<string, unknown>;
  const b = after  as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const changed: string[] = [];
  for (const k of keys) {
    const before_v = a[k];
    const after_v  = b[k];
    if (before_v instanceof Date && after_v instanceof Date) {
      if (before_v.getTime() !== after_v.getTime()) changed.push(k);
      continue;
    }
    // Cheap deep-equal via JSON — good enough for shallow row objects.
    if (JSON.stringify(before_v) !== JSON.stringify(after_v)) changed.push(k);
  }
  return changed;
}

/**
 * Extract an AuditActor from an Express request's user object. Convenience
 * for `req.user`-shaped inputs — routes that don't set req.user (public
 * endpoints, background jobs) should build the actor themselves.
 */
export function actorFromReq(req: { user?: { id?: string; primary_role?: string } | null; ip?: string }): AuditActor {
  return {
    user_id:   req.user?.id ?? null,
    ip:        req.ip ?? null,
    role_code: req.user?.primary_role ?? null,
  };
}

// ─── Read side (used by /api/admin/audit-log and /entity-versions) ────────

export interface ListAuditFilters {
  entity_type?: string;
  entity_id?: string;
  actor_user_id?: string;
  action?: string;
  since?: Date;
  until?: Date;
  page?: number;
  pageSize?: number;
}

/**
 * Read side for the admin audit-log page. Filters compose (all ANDed).
 * Ordered newest-first. Paginated.
 */
export async function listAudit(filters: ListAuditFilters) {
  const page = Math.max(1, filters.page ?? 1);
  const pageSize = Math.min(200, Math.max(5, filters.pageSize ?? 50));
  const offset = (page - 1) * pageSize;

  const conds: any[] = [];
  if (filters.entity_type)   conds.push(eq(auditLog.entity_type, filters.entity_type));
  if (filters.entity_id)     conds.push(eq(auditLog.entity_id, filters.entity_id));
  if (filters.actor_user_id) conds.push(eq(auditLog.actor_user_id, filters.actor_user_id));
  if (filters.action)        conds.push(eq(auditLog.action, filters.action));
  if (filters.since)         conds.push(sql`${auditLog.occurred_at} >= ${filters.since.toISOString()}::timestamptz`);
  if (filters.until)         conds.push(sql`${auditLog.occurred_at} <= ${filters.until.toISOString()}::timestamptz`);

  const whereExpr = conds.length ? and(...conds) : sql`true`;

  const rows = await db.select().from(auditLog)
    .where(whereExpr)
    .orderBy(desc(auditLog.occurred_at))
    .limit(pageSize)
    .offset(offset);

  const [{ total }] = await db.select({
    total: sql<number>`count(*)::int`.as("total"),
  }).from(auditLog).where(whereExpr);

  return { rows, total, page, pageSize };
}

/**
 * Version list for a specific entity — newest first. Used by the History
 * tab on admin drawers.
 */
export async function listVersions(entity_type: string, entity_id: string) {
  return db.select().from(entityVersions)
    .where(and(
      eq(entityVersions.entity_type, entity_type),
      eq(entityVersions.entity_id, entity_id),
    ))
    .orderBy(desc(entityVersions.version_number));
}
