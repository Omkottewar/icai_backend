import { and, eq, gte, isNull, or } from "drizzle-orm";
import { db } from "../../db/client.js";
import { roles, userRoleAssignments } from "../../schema/index.js";

export type UserPermissions = {
  codes: Set<string>;
  isAdmin: boolean;
  isBranchChairman: boolean;
  isCommitteeChairman: boolean;
  isMcm: boolean;
  committeeChairmanOf: string[];   // committee_ids where user is chairman
  committeeMemberOf: string[];     // committee_ids where user is a member
};

// Per-request memoisation. Same userId asked multiple times within a single
// request reuses the result instead of re-hitting the DB. The cache is keyed
// by promise so two concurrent callers also share one in-flight query.
//
// We deliberately do NOT cache across requests â€” a role change should be
// visible on the next request. For multi-request caching we'd need cache
// invalidation on user_role_assignments writes.
const inflight = new Map<string, Promise<UserPermissions>>();

// Single round-trip that loads every role assignment the user currently
// holds, along with the role code and any scope ids. Replaces three
// separate queries (isAdmin / isBranchChairman / getCommitteesUserChairs)
// that used to fire sequentially on every authorised endpoint.
export function loadUserPermissions(userId: string): Promise<UserPermissions> {
  let p = inflight.get(userId);
  if (p) return p;

  p = (async () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await db
      .select({
        code: roles.code,
        scope_committee_id: userRoleAssignments.scope_committee_id,
      })
      .from(userRoleAssignments)
      .innerJoin(roles, eq(roles.id, userRoleAssignments.role_id))
      .where(and(
        eq(userRoleAssignments.user_id, userId),
        or(isNull(userRoleAssignments.effective_to), gte(userRoleAssignments.effective_to, today)),
      ));

    const codes = new Set<string>();
    const committeeChairmanOf: string[] = [];
    const committeeMemberOf: string[] = [];
    for (const r of rows) {
      codes.add(r.code);
      if (r.code === "committee_chairman" && r.scope_committee_id) committeeChairmanOf.push(r.scope_committee_id);
      if (r.code === "committee_member"  && r.scope_committee_id) committeeMemberOf.push(r.scope_committee_id);
    }
    return {
      codes,
      isAdmin: codes.has("admin"),
      isBranchChairman: codes.has("branch_chairman"),
      isCommitteeChairman: codes.has("committee_chairman"),
      isMcm: codes.has("mcm"),
      committeeChairmanOf,
      committeeMemberOf,
    };
  })();

  // Cache for ~2 seconds so within-request bursts share the result. Any
  // slower request lifecycle than that is unusual.
  inflight.set(userId, p);
  setTimeout(() => inflight.delete(userId), 2000);
  return p;
}

// â”€â”€â”€ thin convenience wrappers (back-compat) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// All of these now hit a memoised query instead of issuing their own.
export async function isAdmin(userId: string): Promise<boolean> {
  return (await loadUserPermissions(userId)).isAdmin;
}
export async function isBranchChairman(userId: string): Promise<boolean> {
  return (await loadUserPermissions(userId)).isBranchChairman;
}
export async function getCommitteesUserChairs(userId: string): Promise<string[]> {
  return (await loadUserPermissions(userId)).committeeChairmanOf;
}
export async function getActiveRoleCodes(userId: string): Promise<Set<string>> {
  return (await loadUserPermissions(userId)).codes;
}
