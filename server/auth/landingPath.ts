import { eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { users } from "../../schema/index.js";
import { loadUserPermissions } from "./permissions.js";

// Roles whose primary daily workflow is the admin console, not the member
// dashboard. These users should land on /admin after login — the role-aware
// homepage at /admin shows them their inbox + tools instead of CPE / events
// the way the member dashboard does.
//
// Members and students are deliberately NOT in this list — even when they
// hold one of these roles, they still want the member-flavoured /dashboard
// for their own CPE / registrations. The choice below favours office-bearer
// duties, on the assumption that someone who logs in as the Branch Chairman
// is doing chairman work, not checking their own CPE balance.
const ADMIN_LANDING_ROLES = new Set([
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
 * Decide where to land a user post-login.
 *   - first-time users go to /onboarding (caller passes `isNew`)
 *   - office bearers go to /admin
 *   - everyone else goes to /dashboard
 *
 * The role lookup is the same memoised query that powers the rest of the
 * permission machinery, so this adds a single DB hit per login.
 */
export async function getPostLoginPath(userId: string, isNew: boolean): Promise<string> {
  try {
    // Guest speakers skip /onboarding entirely — the form has no branch
    // for their role, and they have no CPE/registrations to see on the
    // member dashboard. Straight to the events they're speaking at.
    const [row] = await db
      .select({ primary_role: users.primary_role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (row?.primary_role === "guest") return "/my-speaker-events";

    if (isNew) return "/onboarding";

    const perms = await loadUserPermissions(userId);
    for (const code of perms.codes) {
      if (ADMIN_LANDING_ROLES.has(code)) return "/admin";
    }
  } catch {
    // If permission lookup fails, fall back to the member dashboard rather
    // than blocking sign-in. Worst case the user clicks one extra link.
  }
  return "/dashboard";
}
