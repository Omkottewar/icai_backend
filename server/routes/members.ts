import { Router } from "express";
import { and, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import { users, memberProfiles } from "../../schema/index.js";
import { requireUser } from "../middleware/requireUser.js";
import { handleApiError, trim } from "../lib/apiError.js";

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
