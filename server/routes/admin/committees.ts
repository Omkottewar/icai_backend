import { Router } from "express";
import { and, asc, eq, ilike, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { committees, events, userRoleAssignments } from "../../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const committeesAdminRouter = Router();

// â”€â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Code is uppercased + stripped to alphanumerics + underscores. Letters
// like "CPE", "DIRECT_TAX", "WICASA". Keeps the URL/log identifiers clean.
function normCode(v: unknown): string {
  return String(v ?? "").toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 32);
}

function rethrowDbError(err: unknown): never {
  if (err && typeof err === "object" && "code" in err) {
    const e = err as { code: string; detail?: string; message?: string };
    if (e.code === "23505") throw new ApiError(409, "A committee with that code already exists");
    if (e.code === "23503") throw new ApiError(400, "Referenced record does not exist");
  }
  throw err;
}

// â”€â”€â”€ GET /api/admin/committees â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
committeesAdminRouter.get("/", async (req, res, next) => {
  try {
    const q = trim(req.query.q);
    const includeInactive = trim(req.query.include_inactive) === "1";

    const conds = [] as any[];
    if (!includeInactive) conds.push(eq(committees.active, true));
    if (q) conds.push(ilike(committees.name, `%${q}%`));

    // Pull events_count + active_role_count per committee in a single query.
    const rows = await db
      .select({
        id: committees.id,
        code: committees.code,
        name: committees.name,
        description: committees.description,
        active: committees.active,
        created_at: committees.createdAt,
        events_count: sql<number>`(
          SELECT COUNT(*)::int FROM ${events}
          WHERE ${events}.committee_id = ${committees}.id
            AND ${events}.deleted_at IS NULL
        )`.as("events_count"),
        active_role_count: sql<number>`(
          SELECT COUNT(*)::int FROM ${userRoleAssignments}
          WHERE ${userRoleAssignments}.scope_committee_id = ${committees}.id
            AND (${userRoleAssignments}.effective_to IS NULL
                 OR ${userRoleAssignments}.effective_to >= CURRENT_DATE)
        )`.as("active_role_count"),
      })
      .from(committees)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(committees.name));

    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ GET /api/admin/committees/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
committeesAdminRouter.get("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [row] = await db.select().from(committees).where(eq(committees.id, id)).limit(1);
    if (!row) throw new ApiError(404, "Committee not found");

    const [{ events_count }] = await db
      .select({ events_count: sql<number>`count(*)::int`.as("events_count") })
      .from(events)
      .where(and(eq(events.committee_id, id), isNull(events.deleted_at)));

    const [{ active_role_count }] = await db
      .select({ active_role_count: sql<number>`count(*)::int`.as("active_role_count") })
      .from(userRoleAssignments)
      .where(and(
        eq(userRoleAssignments.scope_committee_id, id),
        sql`(${userRoleAssignments.effective_to} IS NULL OR ${userRoleAssignments.effective_to} >= CURRENT_DATE)`,
      ));

    res.json({ ...row, events_count, active_role_count });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ POST /api/admin/committees â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
committeesAdminRouter.post("/", async (req, res, next) => {
  try {
    const name = need(trim(req.body.name), "Name");
    const code = need(normCode(req.body.code) || normCode(name), "Code");
    const description = trim(req.body.description) || null;
    const active = req.body.active === false ? false : true;

    try {
      const [created] = await db
        .insert(committees)
        .values({ code, name, description, active })
        .returning();
      res.status(201).json(created);
    } catch (e) { rethrowDbError(e); }
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ PATCH /api/admin/committees/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
committeesAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [existing] = await db.select().from(committees).where(eq(committees.id, id)).limit(1);
    if (!existing) throw new ApiError(404, "Committee not found");

    const patch: Record<string, any> = {};
    if (req.body.name !== undefined)        patch.name = need(trim(req.body.name), "Name");
    if (req.body.code !== undefined)        patch.code = need(normCode(req.body.code), "Code");
    if (req.body.description !== undefined) patch.description = trim(req.body.description) || null;
    if (req.body.active !== undefined)      patch.active = !!req.body.active;

    try {
      const [row] = await db.update(committees).set(patch).where(eq(committees.id, id)).returning();
      res.json(row);
    } catch (e) { rethrowDbError(e); }
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ DELETE /api/admin/committees/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Hard delete is refused if any events or role assignments still reference
// the committee (FK is ON DELETE RESTRICT). Admin should disable instead.
committeesAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const [{ events_count }] = await db
      .select({ events_count: sql<number>`count(*)::int`.as("events_count") })
      .from(events)
      .where(and(eq(events.committee_id, id), isNull(events.deleted_at)));
    if (events_count > 0) {
      throw new ApiError(409, `Cannot delete â€” ${events_count} event(s) still reference this committee. Disable it instead.`);
    }

    const [{ role_count }] = await db
      .select({ role_count: sql<number>`count(*)::int`.as("role_count") })
      .from(userRoleAssignments)
      .where(eq(userRoleAssignments.scope_committee_id, id));
    if (role_count > 0) {
      throw new ApiError(409, `Cannot delete â€” ${role_count} role assignment(s) reference this committee. Disable it instead.`);
    }

    const [row] = await db.delete(committees).where(eq(committees.id, id)).returning();
    if (!row) throw new ApiError(404, "Committee not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
