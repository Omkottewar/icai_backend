// Admin read endpoints for the audit-log + entity-versions tables.
//
// GET /api/admin/audit-log
//   Filterable firehose. Filters: entity_type, entity_id, actor_user_id,
//   action, since (ISO), until (ISO), page, pageSize. Paginated. Joined
//   with users so the UI can render "changed_by: [Name]" without a
//   second lookup.
//
// GET /api/admin/entity-versions/:entity_type/:entity_id
//   Version list for a specific entity — newest first. Powers per-entity
//   History tabs on admin drawers. Full snapshot_json is included so the
//   client can diff or preview a version without another round-trip.

import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { auditLog, entityVersions, users } from "../../../schema/index.js";
import { handleApiError, trim } from "../../lib/apiError.js";
import { aliasedTable } from "drizzle-orm";

export const auditAdminRouter = Router();

// ─── GET /api/admin/audit-log ─────────────────────────────────────────────
auditAdminRouter.get("/", async (req, res, next) => {
  try {
    const page     = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(5, Number(req.query.pageSize) || 50));
    const offset   = (page - 1) * pageSize;

    const entity_type   = trim(req.query.entity_type);
    const entity_id     = trim(req.query.entity_id);
    const actor_user_id = trim(req.query.actor_user_id);
    const action        = trim(req.query.action);
    const since         = trim(req.query.since);
    const until         = trim(req.query.until);

    const conds: any[] = [];
    if (entity_type)   conds.push(eq(auditLog.entity_type, entity_type));
    if (entity_id)     conds.push(eq(auditLog.entity_id, entity_id));
    if (actor_user_id) conds.push(eq(auditLog.actor_user_id, actor_user_id));
    if (action)        conds.push(eq(auditLog.action, action));
    if (since)         conds.push(sql`${auditLog.occurred_at} >= ${since}::timestamptz`);
    if (until)         conds.push(sql`${auditLog.occurred_at} <= ${until}::timestamptz`);

    const whereExpr = conds.length ? and(...conds) : sql`true`;

    const actorU = aliasedTable(users, "actor_u");

    const rows = await db.select({
      id:              auditLog.id,
      occurred_at:     auditLog.occurred_at,
      actor_user_id:   auditLog.actor_user_id,
      actor_name:      actorU.name,
      actor_email:     actorU.email,
      actor_ip:        auditLog.actor_ip,
      actor_role_code: auditLog.actor_role_code,
      entity_type:     auditLog.entity_type,
      entity_id:       auditLog.entity_id,
      action:          auditLog.action,
      changed_fields:  auditLog.changed_fields,
      before_json:     auditLog.before_json,
      after_json:      auditLog.after_json,
      note:            auditLog.note,
    })
      .from(auditLog)
      .leftJoin(actorU, eq(actorU.id, auditLog.actor_user_id))
      .where(whereExpr)
      .orderBy(desc(auditLog.occurred_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db.select({
      total: sql<number>`count(*)::int`.as("total"),
    }).from(auditLog).where(whereExpr);

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/entity-versions/:entity_type/:entity_id ───────────────
// Version list for a single entity. Snapshot_json is included so the
// frontend History tab can render each row inline without another fetch.
auditAdminRouter.get("/versions/:entity_type/:entity_id", async (req, res, next) => {
  try {
    const entity_type = trim(req.params.entity_type);
    const entity_id   = trim(req.params.entity_id);
    if (!entity_type || !entity_id) {
      return res.json({ items: [] });
    }

    const savedByU = aliasedTable(users, "saved_by_u");

    const items = await db.select({
      id:               entityVersions.id,
      version_number:   entityVersions.version_number,
      saved_at:         entityVersions.saved_at,
      saved_by_user_id: entityVersions.saved_by_user_id,
      saved_by_name:    savedByU.name,
      change_note:      entityVersions.change_note,
      snapshot_json:    entityVersions.snapshot_json,
    })
      .from(entityVersions)
      .leftJoin(savedByU, eq(savedByU.id, entityVersions.saved_by_user_id))
      .where(and(
        eq(entityVersions.entity_type, entity_type),
        eq(entityVersions.entity_id, entity_id),
      ))
      .orderBy(desc(entityVersions.version_number));

    res.json({ items });
  } catch (err) { handleApiError(err, res, next); }
});
