import { Router } from "express";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import {
  users, roles, userRoleAssignments, branches, committees,
} from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const usersAdminRouter = Router();

// â”€â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const PRIMARY_ROLES = ["member", "student", "employer", "employee", "mcm", "chairman", "admin", "staff"] as const;
const USER_STATUSES = ["active", "inactive", "suspended"] as const;

function pickPrimaryRole(v: unknown): typeof PRIMARY_ROLES[number] {
  return PRIMARY_ROLES.includes(v as any) ? (v as typeof PRIMARY_ROLES[number]) : "member";
}
function pickStatus(v: unknown): typeof USER_STATUSES[number] {
  return USER_STATUSES.includes(v as any) ? (v as typeof USER_STATUSES[number]) : "active";
}
function normEmail(v: unknown) {
  return trim(v).toLowerCase();
}

// Re-throws DB constraint / trigger errors as friendly ApiErrors so the UI
// can show "Branch chairman already exists" instead of a Postgres stack.
function rethrowDbError(err: unknown): never {
  if (err && typeof err === "object" && "code" in err) {
    const e = err as { code: string; message?: string; detail?: string };
    if (e.code === "23505") throw new ApiError(409, e.detail || "Duplicate value");
    if (e.code === "23503") throw new ApiError(400, "Referenced record does not exist");
    if (e.code === "P0001") throw new ApiError(400, e.message || "Trigger rejected the operation");
  }
  throw err;
}

// â”€â”€â”€ GET /api/admin/users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
usersAdminRouter.get("/", async (req, res, next) => {
  try {
    const q = trim(req.query.q);
    const status = trim(req.query.status);
    const primary_role = trim(req.query.primary_role);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 25));
    const offset = (page - 1) * pageSize;

    const conds = [isNull(users.deleted_at)];
    if (status && USER_STATUSES.includes(status as any)) conds.push(eq(users.status, status as any));
    if (primary_role && PRIMARY_ROLES.includes(primary_role as any)) conds.push(eq(users.primary_role, primary_role as any));
    if (q) {
      conds.push(or(ilike(users.name, `%${q}%`), ilike(users.email, `%${q}%`))!);
    }

    const rows = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        phone: users.phone,
        primary_role: users.primary_role,
        status: users.status,
        branch_id: users.branch_id,
        branch_name: branches.name,
        last_login_at: users.last_login_at,
        created_at: users.created_at,
      })
      .from(users)
      .leftJoin(branches, eq(branches.id, users.branch_id))
      .where(and(...conds))
      .orderBy(desc(users.created_at))
      .limit(pageSize)
      .offset(offset);

    // Active role assignments per listed user (one batched query).
    const ids = rows.map((r) => r.id);
    const assignments = ids.length
      ? await db
          .select({
            user_id: userRoleAssignments.user_id,
            assignment_id: userRoleAssignments.id,
            role_code: roles.code,
            role_name: roles.name,
            scope: roles.scope,
          })
          .from(userRoleAssignments)
          .innerJoin(roles, eq(roles.id, userRoleAssignments.role_id))
          .where(and(
            inArray(userRoleAssignments.user_id, ids),
            or(isNull(userRoleAssignments.effective_to), sql`${userRoleAssignments.effective_to} >= CURRENT_DATE`)!,
          ))
      : [];

    const byUser = new Map<string, Array<{ assignment_id: string; role_code: string; role_name: string; scope: string }>>();
    for (const a of assignments) {
      const list = byUser.get(a.user_id) ?? [];
      list.push({ assignment_id: a.assignment_id, role_code: a.role_code, role_name: a.role_name, scope: a.scope });
      byUser.set(a.user_id, list);
    }

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(users)
      .where(and(...conds));

    res.json({
      rows: rows.map((r) => ({ ...r, active_roles: byUser.get(r.id) ?? [] })),
      total, page, pageSize,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ GET /api/admin/users/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
usersAdminRouter.get("/:id", async (req, res, next) => {
  try {
    const [row] = await db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        phone: users.phone,
        primary_role: users.primary_role,
        status: users.status,
        locale: users.locale,
        branch_id: users.branch_id,
        last_login_at: users.last_login_at,
        created_at: users.created_at,
      })
      .from(users)
      .where(and(eq(users.id, req.params.id), isNull(users.deleted_at)))
      .limit(1);
    if (!row) throw new ApiError(404, "User not found");

    const roleRows = await db
      .select({
        assignment_id: userRoleAssignments.id,
        role_id: roles.id,
        role_code: roles.code,
        role_name: roles.name,
        role_scope: roles.scope,
        singleton_per_scope: roles.singleton_per_scope,
        scope_branch_id: userRoleAssignments.scope_branch_id,
        branch_code: branches.code,
        branch_name: branches.name,
        scope_committee_id: userRoleAssignments.scope_committee_id,
        committee_code: committees.code,
        committee_name: committees.name,
        effective_from: userRoleAssignments.effective_from,
        effective_to: userRoleAssignments.effective_to,
      })
      .from(userRoleAssignments)
      .innerJoin(roles, eq(roles.id, userRoleAssignments.role_id))
      .leftJoin(branches, eq(branches.id, userRoleAssignments.scope_branch_id))
      .leftJoin(committees, eq(committees.id, userRoleAssignments.scope_committee_id))
      .where(eq(userRoleAssignments.user_id, req.params.id))
      .orderBy(desc(userRoleAssignments.effective_from));

    res.json({ ...row, role_assignments: roleRows });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ POST /api/admin/users â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Creates a "shell" user row (no Auth0 link). When that person later signs
// in via Auth0 with the same verified email, findOrCreateUserFromAuth0
// step 2 will auto-link them. No password is set here.
usersAdminRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    const name = need(trim(req.body.name), "Name");
    const email = need(normEmail(req.body.email), "Email");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, "Email is not valid");

    const phone = trim(req.body.phone) || null;
    const primary_role = pickPrimaryRole(req.body.primary_role);
    const status = pickStatus(req.body.status);
    const branch_id = trim(req.body.branch_id) || null;

    try {
      const [created] = await db
        .insert(users)
        .values({ name, email, phone, primary_role, status, branch_id })
        .returning();
      res.status(201).json(created);
    } catch (e) { rethrowDbError(e); }
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ PATCH /api/admin/users/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
usersAdminRouter.patch("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const [existing] = await db.select().from(users).where(and(eq(users.id, id), isNull(users.deleted_at))).limit(1);
    if (!existing) throw new ApiError(404, "User not found");

    const patch: Record<string, any> = { updated_at: new Date() };
    if (req.body.name !== undefined)         patch.name = need(trim(req.body.name), "Name");
    if (req.body.email !== undefined) {
      const e = normEmail(req.body.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new ApiError(400, "Email is not valid");
      patch.email = e;
    }
    if (req.body.phone !== undefined)        patch.phone = trim(req.body.phone) || null;
    if (req.body.primary_role !== undefined) patch.primary_role = pickPrimaryRole(req.body.primary_role);
    if (req.body.status !== undefined)       patch.status = pickStatus(req.body.status);
    if (req.body.branch_id !== undefined)    patch.branch_id = trim(req.body.branch_id) || null;

    // Guard: don't let an admin demote themselves into a non-admin primary_role
    // while still being the only active admin (foot-gun protection).
    if (patch.primary_role === "admin" || existing.primary_role === "admin") {
      // (No-op for now â€” granular admin-role revocation lives in the role
      // assignments endpoints, not primary_role.)
    }

    try {
      const [row] = await db.update(users).set(patch).where(eq(users.id, id)).returning();
      res.json(row);
    } catch (e) { rethrowDbError(e); }
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ DELETE /api/admin/users/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Soft delete. Active role assignments are NOT auto-ended here â€” admin
// should end-term first. We refuse soft delete if the user is the caller.
usersAdminRouter.delete("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    if (id === req.user!.id) throw new ApiError(400, "You cannot delete your own account");
    const [row] = await db
      .update(users)
      .set({ deleted_at: new Date(), status: "inactive" })
      .where(and(eq(users.id, id), isNull(users.deleted_at)))
      .returning();
    if (!row) throw new ApiError(404, "User not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ POST /api/admin/users/:id/roles â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Body: { role_code, scope_branch_id?, scope_committee_id?, effective_from? }
usersAdminRouter.post("/:id/roles", async (req, res, next) => {
  try {
    const userId = String(req.params.id);
    const [user] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), isNull(users.deleted_at))).limit(1);
    if (!user) throw new ApiError(404, "User not found");

    const roleCode = need(trim(req.body.role_code), "Role code");
    const [role] = await db.select().from(roles).where(eq(roles.code, roleCode)).limit(1);
    if (!role) throw new ApiError(404, `Role "${roleCode}" does not exist`);

    const scopeBranch = trim(req.body.scope_branch_id) || null;
    const scopeCommittee = trim(req.body.scope_committee_id) || null;
    const effectiveFrom = trim(req.body.effective_from) || new Date().toISOString().slice(0, 10);

    // Pre-validate scope locally for a nicer error (the DB trigger is the
    // authoritative check â€” see migration 0003).
    if (role.scope === "branch" && !scopeBranch) throw new ApiError(400, `Role "${roleCode}" is branch-scoped â€” branch is required`);
    if (role.scope === "committee" && !scopeCommittee) throw new ApiError(400, `Role "${roleCode}" is committee-scoped â€” committee is required`);
    if (role.scope === "global" && (scopeBranch || scopeCommittee)) throw new ApiError(400, `Role "${roleCode}" is global â€” scope must be empty`);

    try {
      const [assignment] = await db
        .insert(userRoleAssignments)
        .values({
          user_id: userId,
          role_id: role.id,
          scope_branch_id: scopeBranch,
          scope_committee_id: scopeCommittee,
          effective_from: effectiveFrom,
        })
        .returning();
      res.status(201).json(assignment);
    } catch (e) { rethrowDbError(e); }
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ DELETE /api/admin/users/:id/roles/:assignment_id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// End-term: sets effective_to to today. Preserves history.
usersAdminRouter.delete("/:id/roles/:assignment_id", async (req, res, next) => {
  try {
    // Backdate by one day so the row drops out of `effective_to >= CURRENT_DATE`
    // filters immediately. Setting it to today would leave the assignment
    // active for the rest of today across auth, triggers, and the admin UI.
    const [row] = await db
      .update(userRoleAssignments)
      .set({ effective_to: sql`CURRENT_DATE - INTERVAL '1 day'` })
      .where(and(
        eq(userRoleAssignments.id, req.params.assignment_id),
        eq(userRoleAssignments.user_id, req.params.id),
      ))
      .returning();
    if (!row) throw new ApiError(404, "Role assignment not found");
    res.json({ ok: true, assignment: row });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ GET /api/admin/users/_meta/lookups â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns roles, branches, committees for the create/assign-role drawer.
usersAdminRouter.get("/_meta/lookups", async (_req, res, next) => {
  try {
    const rs = await db
      .select({ id: roles.id, code: roles.code, name: roles.name, scope: roles.scope, singleton_per_scope: roles.singleton_per_scope })
      .from(roles)
      .orderBy(asc(roles.scope), asc(roles.name));
    const bs = await db
      .select({ id: branches.id, code: branches.code, name: branches.name })
      .from(branches)
      .where(eq(branches.active, true))
      .orderBy(asc(branches.name));
    const cs = await db
      .select({ id: committees.id, code: committees.code, name: committees.name })
      .from(committees)
      .where(eq(committees.active, true))
      .orderBy(asc(committees.name));
    res.json({ roles: rs, branches: bs, committees: cs });
  } catch (err) { handleApiError(err, res, next); }
});
