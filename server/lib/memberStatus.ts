// Who counts as a non-member for event pricing and the "members only" rule.
//
// A member is anyone with a verified membership number (member_profiles).
// Without one, these account types are non-members: 'guest' (the non-member
// registration flow creates these), and external employer accounts.
// Branch roles (admin, staff, MCM, chairman), legacy 'member' accounts and
// students keep the member fee so existing flows are unchanged.
const NON_MEMBER_ROLES = new Set(["guest", "employer", "employee"]);

export function isNonMemberRole(role: string | null | undefined): boolean {
  return NON_MEMBER_ROLES.has(String(role ?? ""));
}
