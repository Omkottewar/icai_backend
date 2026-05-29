import type { Response, NextFunction } from "express";
import { loadUserPermissions } from "../auth/permissions.js";
import type { AuthedRequest } from "./requireUser.js";

/**
 * Must run AFTER requireUser. Confirms the user has an active assignment to
 * the 'admin' role. Uses the shared loadUserPermissions cache so subsequent
 * permission checks in the same request reuse the result.
 */
export async function requireAdmin(req: AuthedRequest, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "unauthenticated" });
  const perms = await loadUserPermissions(req.user.id);
  if (!perms.isAdmin) return res.status(403).json({ error: "forbidden" });
  next();
}
