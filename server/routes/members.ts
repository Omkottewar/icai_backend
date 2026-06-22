import { Router } from "express";
import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { users, memberProfiles } from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { handleApiError, trim, ApiError } from "../lib/apiError.js";

export const membersRouter = Router();
membersRouter.use(requireUser);

// ─── GET /api/members/directory ───────────────────────────────────────────────
// Paginated, searchable list of members (primary_role = 'member') with their
// ICAI MRN and FCA/ACA status. Accessible to any authenticated user.
membersRouter.get("/directory", async (req, res, next) => {
  try {
    const q        = trim(req.query.q);
    const page     = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(10, Number(req.query.pageSize) || 25));
    const offset   = (page - 1) * pageSize;

    const conds = [
      isNull(users.deleted_at),
      eq(users.primary_role, "member"),
      isNull(memberProfiles.deleted_at),
    ];

    if (q) {
      conds.push(or(
        ilike(users.name, `%${q}%`),
        ilike(memberProfiles.mrn, `%${q}%`),
      )!);
    }

    const where = and(...conds);

    const [rows, [{ total }]] = await Promise.all([
      db
        .select({
          id:     users.id,
          name:   users.name,
          mrn:    memberProfiles.mrn,
          is_fca: memberProfiles.is_fca,
          city:   memberProfiles.city,
        })
        .from(users)
        .innerJoin(memberProfiles, eq(memberProfiles.user_id, users.id))
        .where(where)
        .orderBy(users.name)
        .limit(pageSize)
        .offset(offset),

      db
        .select({ total: sql<number>`count(*)::int` })
        .from(users)
        .innerJoin(memberProfiles, eq(memberProfiles.user_id, users.id))
        .where(where),
    ]);

    res.json({
      rows: rows.map((r) => ({
        id:     r.id,
        name:   r.name,
        mrn:    r.mrn,
        status: r.is_fca ? "FCA" : "ACA",
        city:   r.city ?? "",
      })),
      total,
      page,
      pageSize,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/members/profile ─────────────────────────────────────────
// Update the editable subset of the current member's profile. Fields that
// are sourced from ICAI (MRN, FCA status, COP status/number, member-since
// date) stay read-only — those flow in via the ICAI sync and we don't want
// members overriding them locally. Anything not present in the body is
// left untouched, so partial updates work.
//
// Returns the updated profile so the client can update its cache without
// a second round-trip.

const GENDERS  = new Set(["male", "female", "other", "unspecified"]);
const PIN_RE   = /^\d{6}$/;
const PHONE_RE = /^[+0-9 ()\-]{6,20}$/;

function cleanString(value: unknown, max = 200): string | null {
  if (value === null) return null;
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (t.length === 0) return null;
  return t.slice(0, max);
}

function cleanStringArray(value: unknown, maxLen = 12, perItemMax = 60): string[] | null {
  if (value === null) return [];
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const t = raw.trim().slice(0, perItemMax);
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= maxLen) break;
  }
  return out;
}

membersRouter.patch("/profile", async (req: AuthedRequest, res, next) => {
  try {
    const user = req.user!;
    if (user.primary_role !== "member") {
      throw new ApiError(403, "Only members can edit a member profile");
    }

    const body = req.body ?? {};

    // ─── users-table fields ────────────────────────────────────────
    const userUpdate: Record<string, unknown> = {};
    if ("phone" in body) {
      const phone = cleanString(body.phone, 20);
      if (phone !== null && !PHONE_RE.test(phone)) {
        throw new ApiError(400, "Phone must be 6–20 digits, optionally with + ( ) - spaces");
      }
      userUpdate.phone = phone;
    }
    if (Object.keys(userUpdate).length > 0) {
      userUpdate.updated_at = new Date();
      await db.update(users).set(userUpdate).where(eq(users.id, user.id));
    }

    // ─── member_profiles fields ────────────────────────────────────
    const profUpdate: Record<string, unknown> = {};

    if ("gender" in body) {
      const g = typeof body.gender === "string" ? body.gender : null;
      if (g && !GENDERS.has(g)) {
        throw new ApiError(400, "Gender must be male / female / other / unspecified");
      }
      profUpdate.gender = g || "unspecified";
    }
    if ("is_practising" in body) {
      profUpdate.is_practising = !!body.is_practising;
    }
    if ("address" in body) {
      profUpdate.address = cleanString(body.address, 400);
    }
    if ("city" in body) {
      profUpdate.city = cleanString(body.city, 80);
    }
    if ("pincode" in body) {
      const pin = cleanString(body.pincode, 6);
      if (pin !== null && !PIN_RE.test(pin)) {
        throw new ApiError(400, "Pincode must be 6 digits");
      }
      profUpdate.pincode = pin;
    }
    if ("areas_of_practice" in body) {
      const areas = cleanStringArray(body.areas_of_practice, 12, 60);
      if (areas === null) {
        throw new ApiError(400, "areas_of_practice must be an array of strings");
      }
      profUpdate.areas_of_practice = areas;
    }

    if (Object.keys(profUpdate).length > 0) {
      const updated = await db
        .update(memberProfiles)
        .set(profUpdate)
        .where(and(eq(memberProfiles.user_id, user.id), isNull(memberProfiles.deleted_at)))
        .returning();

      if (updated.length === 0) {
        throw new ApiError(404, "No member profile to update");
      }
    }

    // Re-read the freshly-joined profile so the client can swap state in
    // place without a second round-trip.
    const [row] = await db
      .select({
        phone: users.phone,
        mrn: memberProfiles.mrn,
        is_fca: memberProfiles.is_fca,
        cop_status: memberProfiles.cop_status,
        cop_number: memberProfiles.cop_number,
        is_practising: memberProfiles.is_practising,
        gender: memberProfiles.gender,
        member_since: memberProfiles.member_since,
        address: memberProfiles.address,
        city: memberProfiles.city,
        pincode: memberProfiles.pincode,
        areas_of_practice: memberProfiles.areas_of_practice,
      })
      .from(users)
      .innerJoin(memberProfiles, eq(memberProfiles.user_id, users.id))
      .where(and(eq(users.id, user.id), isNull(memberProfiles.deleted_at)))
      .limit(1);

    res.json({ ok: true, profile: row ?? null });
  } catch (err) { handleApiError(err, res, next); }
});
