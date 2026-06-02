import type { Response, NextFunction } from "express";
import { eq, isNull, and } from "drizzle-orm";
import { db } from "../../db/client.js";
import { employerUsers, employers } from "../../schema/index.js";
import type { AuthedRequest } from "./requireUser.js";

export type EmployerRequest = AuthedRequest & {
  employer?: {
    id: string;
    company_name: string;
    role: "owner" | "poster";   // user's role on this employer
  };
};

/**
 * Must run AFTER requireUser. Loads the employer the current user can act
 * on and attaches it as `req.employer`. For v1 we assume one employer per
 * user (the one they own from onboarding); the schema supports multi but
 * the dashboard exposes only the first match.
 *
 * Rejects with 403 if the user has no employer_users row — either because
 * they signed up as a different role, or because their employer account was
 * revoked.
 */
export async function requireEmployer(req: EmployerRequest, res: Response, next: NextFunction) {
  if (!req.user) return res.status(401).json({ error: "unauthenticated" });

  const rows = await db
    .select({
      id: employers.id,
      company_name: employers.company_name,
      role: employerUsers.role,
    })
    .from(employerUsers)
    .innerJoin(employers, eq(employers.id, employerUsers.employer_id))
    .where(
      and(
        eq(employerUsers.user_id, req.user.id),
        isNull(employers.deleted_at),
      ),
    )
    .limit(1);

  if (!rows[0]) return res.status(403).json({ error: "no_employer_account" });

  req.employer = rows[0];
  next();
}
