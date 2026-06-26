import { Router } from "express";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import {
  users, roles, userRoleAssignments, branches, committees,
  checklistInstances, checklistInstanceSectionAssignments,
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
    // Comma-separated list of role codes (e.g. "mcm,committee_chairman,branch_chairman").
    // When supplied, restrict the result to users who currently hold ANY of
    // those roles via `user_role_assignments`. Used by the checklist filler
    // picker to keep the dropdown limited to MCM-eligible people.
    const role_codes = trim(req.query.role_codes)
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 25));
    const offset = (page - 1) * pageSize;

    const conds = [isNull(users.deleted_at)];
    if (status && USER_STATUSES.includes(status as any)) conds.push(eq(users.status, status as any));
    if (primary_role && PRIMARY_ROLES.includes(primary_role as any)) conds.push(eq(users.primary_role, primary_role as any));
    if (q) {
      conds.push(or(ilike(users.name, `%${q}%`), ilike(users.email, `%${q}%`))!);
    }
    if (role_codes.length > 0) {
      // EXISTS subquery — restrict to users with at least one active
      // assignment to any of the requested role codes. We expand the JS
      // string array via sql.join into a comma-separated IN-list because
      // Drizzle's raw `${jsArray}` interpolation produces a parenthesised
      // tuple which Postgres rejects as the right-hand side of ANY().
      const codeList = sql.join(role_codes.map((c) => sql`${c}`), sql`, `);
      conds.push(sql`EXISTS (
        SELECT 1
        FROM ${userRoleAssignments} ura
        INNER JOIN ${roles} r ON r.id = ura.role_id
        WHERE ura.user_id = ${users.id}
          AND r.code IN (${codeList})
          AND (ura.effective_to IS NULL OR ura.effective_to >= CURRENT_DATE)
      )`);
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
// End-term: removes the assignment from "currently active" filters.
//
//   • Past assignment (effective_from < today) → backdate effective_to to
//     yesterday so history is preserved.
//   • Same-day or future assignment (effective_from >= today) → DELETE.
//     There's no meaningful history to keep (the role was never active in
//     practice) and backdating would either violate the ura_window_valid
//     check or leave the row "active" through the rest of today.
usersAdminRouter.delete("/:id/roles/:assignment_id", async (req, res, next) => {
  try {
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          id: userRoleAssignments.id,
          effective_from: userRoleAssignments.effective_from,
        })
        .from(userRoleAssignments)
        .where(and(
          eq(userRoleAssignments.id, req.params.assignment_id),
          eq(userRoleAssignments.user_id, req.params.id),
        ))
        .limit(1);
      if (!existing) return null;

      const today = new Date().toISOString().slice(0, 10);
      if (existing.effective_from >= today) {
        await tx.delete(userRoleAssignments)
          .where(eq(userRoleAssignments.id, existing.id));
        return { deleted: true };
      }

      const [row] = await tx.update(userRoleAssignments)
        .set({ effective_to: sql`CURRENT_DATE - INTERVAL '1 day'` })
        .where(eq(userRoleAssignments.id, existing.id))
        .returning();
      return { deleted: false, assignment: row };
    });
    if (!result) throw new ApiError(404, "Role assignment not found");
    res.json({ ok: true, ...result });
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

// ─── GET /api/admin/users/:id/open-checklists ───────────────────────────
// Lists every non-approved checklist instance where this user is currently
// the assigned filler, the assigned reviewer, or the assignee for a
// section. Used by the user-detail drawer to surface lingering work that
// should be reassigned when a role is revoked — otherwise the ex-treasurer
// keeps seeing "5 pending" on their dashboard for assignments that were
// implicitly tied to a role they no longer hold.
usersAdminRouter.get("/:id/open-checklists", async (req: AuthedRequest, res, next) => {
  try {
    const userId = String(req.params.id);

    // Direct user assignments (fill / review). These are the two columns
    // that drive the "is this assigned to me?" check on the member side.
    const direct = await db
      .select({
        instance_id: checklistInstances.id,
        title:       checklistInstances.title,
        status:      checklistInstances.status,
        role:        sql<string>`case
          when ${checklistInstances.assigned_fill_user_id}   = ${userId} then 'fill'
          when ${checklistInstances.assigned_review_user_id} = ${userId} then 'review'
          else 'unknown'
        end`.as("role"),
        updated_at:  checklistInstances.updated_at,
      })
      .from(checklistInstances)
      .where(and(
        isNull(checklistInstances.deleted_at),
        sql`${checklistInstances.status} <> 'approved'`,
        or(
          eq(checklistInstances.assigned_fill_user_id, userId),
          eq(checklistInstances.assigned_review_user_id, userId),
        ),
      ));

    // Per-section assignments. Several rows may map to the same instance
    // (one user owns multiple sections) so we DISTINCT-ify by instance id
    // for the count surfaced to the admin.
    const sectionRows = await db
      .select({
        instance_id: checklistInstances.id,
        title:       checklistInstances.title,
        status:      checklistInstances.status,
        section_count: sql<number>`count(*)::int`.as("section_count"),
        updated_at:  checklistInstances.updated_at,
      })
      .from(checklistInstanceSectionAssignments)
      .innerJoin(checklistInstances, eq(checklistInstances.id, checklistInstanceSectionAssignments.instance_id))
      .where(and(
        eq(checklistInstanceSectionAssignments.assignee_id, userId),
        isNull(checklistInstances.deleted_at),
        sql`${checklistInstances.status} <> 'approved'`,
      ))
      .groupBy(checklistInstances.id, checklistInstances.title, checklistInstances.status, checklistInstances.updated_at);

    res.json({
      // `direct` carries one row per (instance, role) combination — a user
      // can be both filler and reviewer on the same instance (unusual but
      // possible). The frontend renders one row per direct entry.
      direct,
      sections: sectionRows,
      total: direct.length + sectionRows.length,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/users/:id/reassign-checklists ──────────────────────
// Bulk-reassign every non-approved checklist where this user appears as
// filler, reviewer, or section assignee to a different user. Use cases:
//   • Office bearer rotation — incoming treasurer takes over outgoing
//     treasurer's open work.
//   • Member resignation or leave — owner reroutes work.
//
// Body: { to_user_id: uuid }. The target user is sanity-checked (must
// exist, not deleted) but we do NOT enforce that they hold the same role
// codes — that's an explicit admin choice. The 'approved' filter is
// hard-coded so closed work is never silently rewritten.
usersAdminRouter.post("/:id/reassign-checklists", async (req: AuthedRequest, res, next) => {
  try {
    const fromUserId = String(req.params.id);
    const toUserId   = trim(req.body?.to_user_id);
    if (!toUserId)             throw new ApiError(400, "to_user_id is required");
    if (toUserId === fromUserId) throw new ApiError(400, "Pick a different target user");

    // Confirm the target user exists and is not soft-deleted.
    const [target] = await db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(and(eq(users.id, toUserId), isNull(users.deleted_at)))
      .limit(1);
    if (!target) throw new ApiError(404, "Target user not found");

    // Three independent updates inside one transaction so the user's
    // dashboard refresh after reassign is consistent.
    const result = await db.transaction(async (tx) => {
      const fillUpdated = await tx
        .update(checklistInstances)
        .set({ assigned_fill_user_id: toUserId, updated_at: new Date() })
        .where(and(
          eq(checklistInstances.assigned_fill_user_id, fromUserId),
          isNull(checklistInstances.deleted_at),
          sql`${checklistInstances.status} <> 'approved'`,
        ))
        .returning({ id: checklistInstances.id });

      const reviewUpdated = await tx
        .update(checklistInstances)
        .set({ assigned_review_user_id: toUserId, updated_at: new Date() })
        .where(and(
          eq(checklistInstances.assigned_review_user_id, fromUserId),
          isNull(checklistInstances.deleted_at),
          sql`${checklistInstances.status} <> 'approved'`,
        ))
        .returning({ id: checklistInstances.id });

      // Section assignments: only flip rows whose parent instance is still
      // open. We restrict by instance status via a sub-select rather than
      // a join because UPDATE … FROM is awkward in drizzle and the row
      // count is small.
      const sectionUpdated = await tx
        .update(checklistInstanceSectionAssignments)
        .set({ assignee_id: toUserId, updated_at: new Date() })
        .where(and(
          eq(checklistInstanceSectionAssignments.assignee_id, fromUserId),
          sql`${checklistInstanceSectionAssignments.instance_id} in (
            select id from checklist_instances
            where deleted_at is null and status <> 'approved'
          )`,
        ))
        .returning({ id: checklistInstanceSectionAssignments.id });

      return {
        fillCount:    fillUpdated.length,
        reviewCount:  reviewUpdated.length,
        sectionCount: sectionUpdated.length,
      };
    });

    res.json({
      ok: true,
      to_user: { id: target.id, name: target.name },
      ...result,
      total: result.fillCount + result.reviewCount + result.sectionCount,
    });
  } catch (err) { handleApiError(err, res, next); }
});
