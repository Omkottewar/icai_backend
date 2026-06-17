// Pragyaan AI — role → KB-scope policy (FIN-151, P0-3, security-critical).
//
// Maps a caller's *server-derived* role to the set of kb_scope values they
// may retrieve. This is the access-control boundary for the assistant: the
// returned set is fed straight into the retrieval SQL's `scope = ANY(:scopes)`
// filter, so gated chunks are dropped BEFORE they ever reach the LLM context.
//
// The role is ALWAYS derived from the session here — never from a client
// param. A request body cannot widen its own scope.
//
// Policy (verbatim from docs/PRAGYAAN_SPEC.md "Role → scope policy"):
//   visitor (no session)        → {public}
//   primary_role 'student'      → {public, student}
//   primary_role 'employer'     → {public, employer}
//   primary_role 'member'       → {public, member}     ← NEVER internal
//   internal (admin OR any active role assignment in the roles taxonomy —
//     branch_*, mcm, committee_*, branch_manager, staff/employee primary_role)
//                               → ALL {public, member, student, employer, internal}

import type { UserPermissions } from "../../auth/permissions.js";
import { loadUserPermissions } from "../../auth/permissions.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";

// Mirrors the kb_scope enum (schema/enums.ts → kbScopeEnum).
export type KbScope = "public" | "member" | "student" | "employer" | "internal";

const ALL_SCOPES: readonly KbScope[] = [
  "public",
  "member",
  "student",
  "employer",
  "internal",
];

// users.primary_role values that, on their own, denote branch staff and so
// grant internal access (the roles taxonomy assignments cover office bearers;
// these cover plain staff accounts that may not carry a separate assignment).
const STAFF_PRIMARY_ROLES = new Set(["staff", "employee"]);

/**
 * Resolve the set of KB scopes a caller may retrieve from.
 *
 * @param perms        Permissions loaded server-side via loadUserPermissions,
 *                     or null for an anonymous visitor.
 * @param primaryRole  users.primary_role for the session user, or null/undefined
 *                     for a visitor.
 *
 * SECURITY: `internal` is granted ONLY to true internal accounts. A 'member'
 * primary_role never receives `internal`, even by accident.
 */
export function rolesToScopes(
  perms: UserPermissions | null,
  primaryRole?: string | null,
): Set<KbScope> {
  // Visitor — no session at all.
  if (!perms) return new Set<KbScope>(["public"]);

  // Internal: an admin, OR holding ANY active role assignment in the roles
  // taxonomy (every seeded role code — branch_*, mcm, committee_*,
  // branch_manager, accountant, student_desk, …, admin — is an internal
  // staff/office-bearer role), OR a staff/employee primary_role.
  const isInternal =
    perms.isAdmin ||
    perms.codes.size > 0 ||
    (primaryRole != null && STAFF_PRIMARY_ROLES.has(primaryRole));

  if (isInternal) return new Set<KbScope>(ALL_SCOPES);

  // Non-internal: scope is decided purely by the UI-hint primary_role.
  switch (primaryRole) {
    case "student":
      return new Set<KbScope>(["public", "student"]);
    case "employer":
      return new Set<KbScope>(["public", "employer"]);
    case "member":
      return new Set<KbScope>(["public", "member"]); // NEVER internal
    default:
      // Authenticated but role doesn't grant any gated scope — public only.
      return new Set<KbScope>(["public"]);
  }
}

export interface RequestScopes {
  /** The KB scopes this request may retrieve from. */
  scopes: Set<KbScope>;
  /** Human-readable role label for logging / kb_query_log.role_label. */
  roleLabel: string;
  /** True when there is no authenticated session (visitor). */
  isAnon: boolean;
}

/**
 * Derive the caller's scopes from the request session — the single entry point
 * routes should use. Reads `req.user` (set by requireUser, or absent for an
 * anonymous/optional-auth request), loads permissions server-side, and applies
 * rolesToScopes. The client NEVER supplies the role.
 *
 * Safe on routes without requireUser (e.g. the public /chat endpoint): a
 * missing `req.user` is treated as a visitor → {public}.
 */
export async function resolveRequestScopes(
  req: AuthedRequest,
): Promise<RequestScopes> {
  const user = req.user;
  if (!user) {
    return { scopes: new Set<KbScope>(["public"]), roleLabel: "visitor", isAnon: true };
  }

  const perms = await loadUserPermissions(user.id);
  const scopes = rolesToScopes(perms, user.primary_role);
  return { scopes, roleLabel: deriveRoleLabel(perms, user.primary_role), isAnon: false };
}

// A compact, stable label for analytics/audit. Prefers the most privileged
// signal (admin > office-bearer assignment > primary_role).
function deriveRoleLabel(perms: UserPermissions, primaryRole?: string | null): string {
  if (perms.isAdmin) return "admin";
  if (perms.codes.size > 0) {
    // Deterministic: the alphabetically-first active role code.
    const [first] = [...perms.codes].sort();
    return first ?? "internal";
  }
  return primaryRole ?? "user";
}
