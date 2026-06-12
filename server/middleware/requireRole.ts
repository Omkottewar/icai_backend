import type { Response, NextFunction } from "express";
import { loadUserPermissions } from "../auth/permissions.js";
import type { AuthedRequest } from "./requireUser.js";

// Narrow gate for individual admin endpoints. Use this AFTER requireUser
// (and typically after requireAdmin too) to restrict to a specific subset
// of role codes.
//
// Example usage:
//   import { requireRole } from "../middleware/requireRole.js";
//   const canPublish = requireRole(["admin", "branch_chairman", "branch_vice_chairman"]);
//   router.post("/:id/publish", canPublish, async (req, res) => { ... });
//
// Always allows 'admin' as a fallback so the IT admin can always step in
// without us having to remember to add 'admin' to every list. To disallow
// admin, drop that line.
export function requireRole(roles: string[]) {
  const allowed = new Set(roles);
  // admin is the universal override (matches the convention in
  // requireAdmin.ts + RequireAdmin.jsx)
  allowed.add("admin");

  return async function requireRoleMiddleware(
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
  ) {
    if (!req.user) return res.status(401).json({ error: "unauthenticated" });
    const perms = await loadUserPermissions(req.user.id);
    for (const code of perms.codes) {
      if (allowed.has(code)) return next();
    }
    return res.status(403).json({
      error: "forbidden",
      message: `This action requires one of: ${[...allowed].join(", ")}`,
    });
  };
}

// Per-resource role check used for "you can only edit YOUR committee's
// events" / "you can only review checklists you're assigned to" scenarios.
// `committeeOwnerOnly` returns a middleware that lets the request through
// only if (a) the user is admin / branch_chairman / VC, OR (b) the user is
// a committee_chairman scoped to the committee returned by `loadCommitteeId`.
//
// Example:
//   router.patch("/:id", committeeOwnerOnly(async (req) => {
//     const ev = await db.select().from(events).where(eq(events.id, req.params.id));
//     return ev[0]?.committee_id ?? null;
//   }), handler);
export function committeeOwnerOnly(
  loadCommitteeId: (req: AuthedRequest) => Promise<string | null>,
) {
  return async function committeeOwnerMiddleware(
    req: AuthedRequest,
    res: Response,
    next: NextFunction,
  ) {
    if (!req.user) return res.status(401).json({ error: "unauthenticated" });
    const perms = await loadUserPermissions(req.user.id);

    // Branch-level office bearers always pass.
    if (perms.isAdmin
        || perms.codes.has("branch_chairman")
        || perms.codes.has("branch_vice_chairman")) {
      return next();
    }

    // Otherwise the user must be committee_chairman of THIS event's committee.
    const committeeId = await loadCommitteeId(req).catch(() => null);
    if (!committeeId) {
      return res.status(404).json({ error: "not_found" });
    }
    if (perms.committeeChairmanOf.includes(committeeId)) return next();

    return res.status(403).json({
      error: "forbidden",
      message: "Only the branch chairman or the committee chairman of this committee can perform this action.",
    });
  };
}
