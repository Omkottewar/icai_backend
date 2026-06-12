import type { Response, NextFunction } from "express";
import { loadUserPermissions } from "../auth/permissions.js";
import type { AuthedRequest } from "./requireUser.js";

// Roles that may enter the admin API. 'admin' is the catch-all (IT admin);
// office bearers each have a focused home variant but still need to call the
// same admin endpoints to load their dashboards. Kept in sync with the
// frontend RequireAdmin gate AND backend/server/auth/landingPath.ts.
const ADMIN_GATE_ROLES = new Set([
  "admin",
  "branch_chairman",
  "branch_vice_chairman",
  "branch_secretary",
  "branch_treasurer",
  "committee_chairman",
  "accountant",
  "branch_manager",
]);

/**
 * Must run AFTER requireUser. Confirms the user holds at least one role from
 * the admin gate set. Uses the shared loadUserPermissions cache so subsequent
 * permission checks in the same request reuse the result.
 *
 * Individual admin endpoints can further narrow access (e.g. refunds router
 * could require 'branch_treasurer' specifically) — this middleware is the
 * coarse outer gate.
 */
export async function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "unauthenticated" });
  const perms = await loadUserPermissions(req.user.id);
  let allowed = false;
  for (const code of perms.codes) {
    if (ADMIN_GATE_ROLES.has(code)) { allowed = true; break; }
  }
  if (!allowed) return res.status(403).json({ error: "forbidden" });
  next();
}
