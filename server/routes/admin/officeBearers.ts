import { Router } from "express";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { officeBearers, users, roles, userRoleAssignments } from "../../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const officeBearersAdminRouter = Router();

// Canonical role codes — the public About page filters by these. role_label
// (display string) is free-text so a "Joint Secretary" can exist without a
// new code.
const ROLE_CODES = [
  "chairman",
  "vice_chairman",
  "secretary",
  "treasurer",
  "wicasa_chairman",
  "imm_past_chairman",
  "managing_committee",
  "member",
] as const;

// Mapping from the display-only office_bearers.role_code to the ACL role
// code in the `roles` table. When a role_code in this map is paired with
// a linked_user_id, the create/update endpoint will sync a matching
// user_role_assignments row so the office-bearer entry and the portal
// access stay aligned. Codes missing from this map (e.g. imm_past_chairman,
// member) don't grant any portal access and are display-only.
const ACL_ROLE_FOR_OFFICE_BEARER: Record<string, string> = {
  chairman:           "branch_chairman",
  vice_chairman:      "branch_vice_chairman",
  secretary:          "branch_secretary",
  treasurer:          "branch_treasurer",
  managing_committee: "mcm",
  // wicasa_chairman is intentionally not in this map — it requires a
  // committee_chairman row scoped to the WICASA committee. We don't try
  // to sync that automatically because it needs a committee_id lookup
  // and we don't surface that here yet.
};

function parseDate(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new ApiError(400, "Invalid date");
  return d.toISOString().slice(0, 10);
}

function parseBody(input: any) {
  const term_label = need(trim(input.term_label), "Term label");
  if (!/^\d{4}(-\d{2,4})?$/.test(term_label)) {
    throw new ApiError(400, "Term label should look like 2025-26 or 2025");
  }

  const code = trim(input.role_code);
  const role_code = code ? (ROLE_CODES.includes(code as any) ? code : null) : null;

  return {
    term_label,
    role_label:   need(trim(input.role_label), "Role label"),
    role_code,
    person_name:  need(trim(input.person_name), "Person name"),
    photo_file_id: trim(input.photo_file_id) || null,
    bio:          trim(input.bio) || null,
    email:        trim(input.email) || null,
    phone:        trim(input.phone) || null,
    is_current:   !!input.is_current,
    tenure_start: parseDate(input.tenure_start),
    tenure_end:   parseDate(input.tenure_end),
    sort_order:   Number.isFinite(Number(input.sort_order))
                    ? Math.trunc(Number(input.sort_order))
                    : 0,
    hidden:       !!input.hidden,
    // linked_user_id may be omitted, null, '' (clear), a uuid, or — for
    // convenience — an email string we'll resolve to a user_id below.
    linked_user_id_raw: input.linked_user_id ?? null,
    linked_user_email_raw: trim(input.linked_user_email) || null,
  };
}

// Resolve the linked_user_id from either an explicit UUID or a lookup by
// email. Returns null when both are empty/clear. Throws when an email is
// provided but doesn't match any user (so the admin gets a clear error
// instead of a silent unlink).
async function resolveLinkedUserId(raw: {
  linked_user_id_raw: unknown;
  linked_user_email_raw: string | null;
}): Promise<string | null> {
  // Explicit clear ("" or null)
  if (raw.linked_user_id_raw === null || raw.linked_user_id_raw === "") {
    if (!raw.linked_user_email_raw) return null;
  }
  if (typeof raw.linked_user_id_raw === "string" && raw.linked_user_id_raw.length === 36) {
    // Treat 36-char strings as UUIDs (good enough for parse-time; the FK
    // constraint will catch genuinely-invalid ids at insert).
    return raw.linked_user_id_raw;
  }
  if (raw.linked_user_email_raw) {
    const [u] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, raw.linked_user_email_raw.toLowerCase()), isNull(users.deleted_at)))
      .limit(1);
    if (!u) {
      throw new ApiError(404, `No user account found for ${raw.linked_user_email_raw}. Sign them up first, then link.`);
    }
    return u.id;
  }
  return null;
}

// Look up the active (effective_to IS NULL or in the future) role
// assignment a user holds for a given ACL role code. Returns null when
// the user holds the role today, otherwise null.
async function findActiveAssignment(userId: string, aclRoleCode: string, tx: any = db) {
  const today = new Date().toISOString().slice(0, 10);
  const [row] = await tx
    .select({
      id: userRoleAssignments.id,
      effective_from: userRoleAssignments.effective_from,
    })
    .from(userRoleAssignments)
    .innerJoin(roles, eq(roles.id, userRoleAssignments.role_id))
    .where(and(
      eq(userRoleAssignments.user_id, userId),
      eq(roles.code, aclRoleCode),
      or(isNull(userRoleAssignments.effective_to), sql`${userRoleAssignments.effective_to} >= ${today}::date`),
    ))
    .limit(1);
  return row ?? null;
}

// End a role assignment (backdate effective_to) — mirrors the helper in
// usersAdminRouter.delete. Same-day-or-future rows are deleted because
// backdating would violate the ura_window_valid check; past rows are
// backdated to yesterday so history is preserved.
async function endAssignment(assignmentId: string, tx: any = db) {
  const [existing] = await tx
    .select({
      id: userRoleAssignments.id,
      effective_from: userRoleAssignments.effective_from,
    })
    .from(userRoleAssignments)
    .where(eq(userRoleAssignments.id, assignmentId))
    .limit(1);
  if (!existing) return;
  const today = new Date().toISOString().slice(0, 10);
  if (existing.effective_from >= today) {
    await tx.delete(userRoleAssignments).where(eq(userRoleAssignments.id, existing.id));
    return;
  }
  await tx.update(userRoleAssignments)
    .set({ effective_to: sql`CURRENT_DATE - INTERVAL '1 day'` })
    .where(eq(userRoleAssignments.id, existing.id));
}

// Resolve the role_id for an ACL role code (e.g. 'branch_treasurer' →
// the uuid of the matching row in the `roles` table).
async function findRoleId(aclRoleCode: string, tx: any = db): Promise<string | null> {
  const [row] = await tx
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.code, aclRoleCode))
    .limit(1);
  return row?.id ?? null;
}

// Sync the ACL row to match the office-bearer entry. Called inside a
// transaction by POST/PATCH/DELETE. Behaviour:
//   • office bearer has linked_user_id AND a mappable role_code AND is
//     not hidden  ⇒ ensure an active user_role_assignment exists today
//                    (idempotent: no-op if already active).
//   • office bearer was previously linked to a different user OR a
//     different role  ⇒ end the old assignment.
//   • office bearer is hidden / deleted / unlinked
//     ⇒ end the current assignment.
async function syncRoleAssignment(
  next: {
    linked_user_id: string | null;
    role_code: string | null;
    hidden: boolean;
  },
  prev: {
    linked_user_id: string | null;
    role_code: string | null;
  } | null,
  tx: any,
) {
  const today = new Date().toISOString().slice(0, 10);

  // Step 1 — end the previous assignment if the link or role changed,
  // or if the row is being hidden / removed.
  const prevRoleCode = prev?.role_code ?? null;
  const prevAclRole  = prevRoleCode ? ACL_ROLE_FOR_OFFICE_BEARER[prevRoleCode] ?? null : null;
  const nextAclRole  = next.role_code ? ACL_ROLE_FOR_OFFICE_BEARER[next.role_code] ?? null : null;
  const linkChanged  = (prev?.linked_user_id ?? null) !== next.linked_user_id;
  const roleChanged  = prevAclRole !== nextAclRole;
  const becameHidden = next.hidden;

  if (prev?.linked_user_id && prevAclRole && (linkChanged || roleChanged || becameHidden)) {
    const oldAssign = await findActiveAssignment(prev.linked_user_id, prevAclRole, tx);
    if (oldAssign) await endAssignment(oldAssign.id, tx);
  }

  // Step 2 — create the new assignment if everything required is in place.
  if (next.linked_user_id && nextAclRole && !next.hidden) {
    const already = await findActiveAssignment(next.linked_user_id, nextAclRole, tx);
    if (already) return; // idempotent — nothing to do
    const roleId = await findRoleId(nextAclRole, tx);
    if (!roleId) {
      // ACL role row missing — should never happen on a healthy DB but
      // we surface a clear error instead of silently dropping the sync.
      throw new ApiError(500, `ACL role '${nextAclRole}' not found in roles table.`);
    }
    await tx.insert(userRoleAssignments).values({
      user_id: next.linked_user_id,
      role_id: roleId,
      effective_from: today,
      // effective_to: null → "currently active"
    });
  }
}

officeBearersAdminRouter.get("/", async (req, res, next) => {
  try {
    const term = trim(req.query.term);
    // LEFT JOIN users so the edit drawer can prefill the "Link user (by
    // email)" field without a second round-trip when a row is linked.
    const rows = await db.select({
        id: officeBearers.id,
        term_label: officeBearers.term_label,
        role_label: officeBearers.role_label,
        role_code: officeBearers.role_code,
        person_name: officeBearers.person_name,
        photo_file_id: officeBearers.photo_file_id,
        bio: officeBearers.bio,
        email: officeBearers.email,
        phone: officeBearers.phone,
        is_current: officeBearers.is_current,
        tenure_start: officeBearers.tenure_start,
        tenure_end: officeBearers.tenure_end,
        sort_order: officeBearers.sort_order,
        hidden: officeBearers.hidden,
        linked_user_id: officeBearers.linked_user_id,
        linked_user_email: users.email,
        created_at: officeBearers.created_at,
        updated_at: officeBearers.updated_at,
      })
      .from(officeBearers)
      .leftJoin(users, eq(users.id, officeBearers.linked_user_id))
      .where(term ? eq(officeBearers.term_label, term) : undefined as any)
      .orderBy(desc(officeBearers.term_label), asc(officeBearers.sort_order));
    res.json({ items: rows });
  } catch (err) { next(err); }
});

officeBearersAdminRouter.post("/", async (req, res, next) => {
  try {
    const parsed = parseBody(req.body);
    const linked_user_id = await resolveLinkedUserId(parsed);
    const row = await db.transaction(async (tx) => {
      const [inserted] = await tx.insert(officeBearers).values({
        term_label:    parsed.term_label,
        role_label:    parsed.role_label,
        role_code:     parsed.role_code,
        person_name:   parsed.person_name,
        photo_file_id: parsed.photo_file_id,
        bio:           parsed.bio,
        email:         parsed.email,
        phone:         parsed.phone,
        is_current:    parsed.is_current,
        tenure_start:  parsed.tenure_start,
        tenure_end:    parsed.tenure_end,
        sort_order:    parsed.sort_order,
        hidden:        parsed.hidden,
        linked_user_id,
      }).returning();
      await syncRoleAssignment(
        { linked_user_id, role_code: parsed.role_code, hidden: parsed.hidden },
        null,
        tx,
      );
      return inserted;
    });
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

officeBearersAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const parsed = parseBody(req.body);
    const linked_user_id = await resolveLinkedUserId(parsed);
    const row = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(officeBearers).where(eq(officeBearers.id, id)).limit(1);
      if (!existing) throw new ApiError(404, "Office bearer not found");
      const [updated] = await tx.update(officeBearers)
        .set({
          term_label:    parsed.term_label,
          role_label:    parsed.role_label,
          role_code:     parsed.role_code,
          person_name:   parsed.person_name,
          photo_file_id: parsed.photo_file_id,
          bio:           parsed.bio,
          email:         parsed.email,
          phone:         parsed.phone,
          is_current:    parsed.is_current,
          tenure_start:  parsed.tenure_start,
          tenure_end:    parsed.tenure_end,
          sort_order:    parsed.sort_order,
          hidden:        parsed.hidden,
          linked_user_id,
          updated_at:    new Date(),
        })
        .where(eq(officeBearers.id, id))
        .returning();
      await syncRoleAssignment(
        { linked_user_id, role_code: parsed.role_code, hidden: parsed.hidden },
        { linked_user_id: existing.linked_user_id, role_code: existing.role_code },
        tx,
      );
      return updated;
    });
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

officeBearersAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = String(req.params.id);
    const row = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(officeBearers).where(eq(officeBearers.id, id)).limit(1);
      if (!existing) throw new ApiError(404, "Office bearer not found");
      // End the matching role assignment BEFORE we delete the row.
      await syncRoleAssignment(
        { linked_user_id: null, role_code: null, hidden: true },
        { linked_user_id: existing.linked_user_id, role_code: existing.role_code },
        tx,
      );
      const [deleted] = await tx.delete(officeBearers).where(eq(officeBearers.id, id)).returning();
      return deleted;
    });
    if (!row) throw new ApiError(404, "Office bearer not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
