import { Router } from "express";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { articleshipMatches, users, events, firms, files } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { storage } from "../../lib/storage.js";
import { notify } from "../../lib/notify.js";
import { logAudit, saveVersion, actorFromReq } from "../../lib/audit.js";

export const articleshipMatchesAdminRouter = Router();

const STATUSES = ["submitted", "matched", "placed", "cancelled"] as const;
type Status = typeof STATUSES[number];

// Firm-size buckets (must mirror the student-facing values in
// RequestArticleshipModal). Used to score firm-size fit on the picker
// side — an exact size match scores 30, an adjacent-bucket match 15, else
// 0. Partners count is a proxy since `firms.partners_count` is what we
// actually store (there's no explicit size enum on the firms table).
const SIZE_BUCKETS = {
  sole_practitioner: { min: 1,  max: 1   },
  small:             { min: 2,  max: 10  },
  medium:            { min: 11, max: 50  },
  large:             { min: 51, max: 199 },
  big4:              { min: 200, max: 100_000 },
} as const;
type SizeBucket = keyof typeof SIZE_BUCKETS;

// Adjacency map: what buckets are "one step away" so an admin looking for
// a small firm still surfaces relevant sole-practitioners and mid-size
// firms when there aren't enough exact matches.
const ADJACENT: Record<SizeBucket, SizeBucket[]> = {
  sole_practitioner: ["small"],
  small:             ["sole_practitioner", "medium"],
  medium:            ["small", "large"],
  large:             ["medium", "big4"],
  big4:              ["large"],
};

function partnersToBucket(n: number): SizeBucket {
  if (n <= 1)  return "sole_practitioner";
  if (n <= 10) return "small";
  if (n <= 50) return "medium";
  if (n <= 199) return "large";
  return "big4";
}

// ─── GET /api/admin/articleship-matches ───────────────────────────────────
articleshipMatchesAdminRouter.get("/", async (req, res, next) => {
  try {
    const status = trim(req.query.status);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const conds = [] as any[];
    if (status && STATUSES.includes(status as Status)) conds.push(eq(articleshipMatches.status, status));

    const rows = await db
      .select({
        id:                       articleshipMatches.id,
        status:                   articleshipMatches.status,
        preferred_specialisations: articleshipMatches.preferred_specialisations,
        preferred_location:       articleshipMatches.preferred_location,
        preferred_firm_size:      articleshipMatches.preferred_firm_size,
        expected_stipend_paise:   articleshipMatches.expected_stipend_paise,
        recommended_firm_ids:     articleshipMatches.recommended_firm_ids,
        placed_firm_id:           articleshipMatches.placed_firm_id,
        notes:                    articleshipMatches.notes,
        created_at:               articleshipMatches.created_at,
        student_user_id:          articleshipMatches.student_user_id,
        student_name:             users.name,
        student_email:            users.email,
        seminar_event_id:         articleshipMatches.seminar_event_id,
        seminar_event_title:      events.title,
        placed_firm_name:         firms.name,
        cv_file_id:               articleshipMatches.cv_file_id,
        cv_name:                  files.name,
        cv_storage_path:          files.storage_path,
      })
      .from(articleshipMatches)
      .leftJoin(users,  eq(users.id, articleshipMatches.student_user_id))
      .leftJoin(events, eq(events.id, articleshipMatches.seminar_event_id))
      .leftJoin(firms,  eq(firms.id,  articleshipMatches.placed_firm_id))
      .leftJoin(files,  eq(files.id,  articleshipMatches.cv_file_id))
      .where(conds.length ? and(...conds) : sql`true`)
      .orderBy(desc(articleshipMatches.created_at))
      .limit(pageSize)
      .offset(offset);

    const rowsWithCvUrl = rows.map(({ cv_storage_path, ...r }) => ({
      ...r,
      cv_url: cv_storage_path ? storage().url(cv_storage_path) : null,
    }));

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(articleshipMatches)
      .where(conds.length ? and(...conds) : sql`true`);

    res.json({ rows: rowsWithCvUrl, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/articleship-matches/firms/search ──────────────────────
// Smart firm picker for the "Recommend firms" drawer. Scores every active
// (non-deleted) firm against a student's preferences and returns them
// ranked by fit. The admin can then pick 3-5 to attach to the submission.
//
// Query params:
//   • specialisations — comma-separated list (e.g. "Direct Tax,Audit")
//   • firm_size       — one of the SIZE_BUCKETS keys
//   • q               — free-text substring on firm name / city
//   • only_verified   — "1" to restrict to verified firms
//
// Scoring (max 100):
//   • Specialisation overlap: (overlap / total) * 60
//   • Firm-size fit: exact 30 · adjacent 15 · else 0
//   • Verified bonus: +10
// Firms with score = 0 are still returned last so the admin can see the
// full universe — this is a WICASA committee, not a black-box matcher.
articleshipMatchesAdminRouter.get("/firms/search", async (req, res, next) => {
  try {
    const q = trim(req.query.q);
    const only_verified = trim(req.query.only_verified) === "1";
    const specsRaw = trim(req.query.specialisations);
    const firmSize = trim(req.query.firm_size) as SizeBucket | "";
    const specs = specsRaw ? specsRaw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    const specsLower = specs.map((s) => s.toLowerCase());
    const bucket = firmSize && (firmSize in SIZE_BUCKETS) ? firmSize : null;

    const conds: any[] = [isNull(firms.deleted_at)];
    if (only_verified) conds.push(eq(firms.verified, true));
    if (q) {
      const like = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      const orClause = or(
        ilike(firms.name, like),
        ilike(firms.city, like),
        ilike(firms.registration_no, like),
      );
      if (orClause) conds.push(orClause);
    }

    const rows = await db
      .select({
        id: firms.id,
        name: firms.name,
        registration_no: firms.registration_no,
        city: firms.city,
        partners_count: firms.partners_count,
        areas_of_expertise: firms.areas_of_expertise,
        verified: firms.verified,
        phone: firms.phone,
        email: firms.email,
      })
      .from(firms)
      .where(and(...conds))
      .limit(200); // guard-rail; scoring is fast but no need to fetch 10k

    // Compute a score per firm. Case-insensitive substring matching lets
    // "Audit" match "Statutory Audit" and vice-versa — closer to what
    // WICASA actually wants than exact-string equality.
    const scored = rows.map((f) => {
      let score = 0;
      const areas = (f.areas_of_expertise ?? []).map((a) => a.toLowerCase());
      if (specsLower.length > 0 && areas.length > 0) {
        let hits = 0;
        for (const s of specsLower) {
          if (areas.some((a) => a.includes(s) || s.includes(a))) hits += 1;
        }
        score += Math.round((hits / specsLower.length) * 60);
      }
      if (bucket && f.partners_count != null) {
        const firmBucket = partnersToBucket(f.partners_count);
        if (firmBucket === bucket) score += 30;
        else if (ADJACENT[bucket].includes(firmBucket)) score += 15;
      }
      if (f.verified) score += 10;
      return { ...f, score };
    });

    // Sort by score desc, then verified desc, then name asc for a stable
    // "best match on top, browsable list below" layout.
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.verified !== b.verified) return a.verified ? -1 : 1;
      return (a.name ?? "").localeCompare(b.name ?? "");
    });

    res.json({ items: scored.slice(0, 100) });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/articleship-matches/:id/recommend ────────────────────
// WICASA reviews the submission, optionally adjusts the recommended firm list,
// and flips status to 'matched'. Fires an "articleship_match_recommended"
// notification to the student — non-fatal if it can't send.
articleshipMatchesAdminRouter.post("/:id/recommend", async (req: AuthedRequest, res, next) => {
  try {
    const id = need(trim(req.params.id), "Match ID");
    const recommended = Array.isArray(req.body?.recommended_firm_ids) ? req.body.recommended_firm_ids : null;
    if (!recommended || recommended.length === 0) throw new ApiError(400, "Provide at least one recommended firm");
    const notes = trim(req.body?.notes) || null;

    // Capture the prior state for the audit-log entry so we can render
    // a proper before/after diff on the admin History tab.
    const [before] = await db.select().from(articleshipMatches)
      .where(eq(articleshipMatches.id, id)).limit(1);

    const [row] = await db.update(articleshipMatches)
      .set({
        status: "matched",
        recommended_firm_ids: recommended,
        notes,
        updated_at: new Date(),
      })
      .where(and(eq(articleshipMatches.id, id), eq(articleshipMatches.status, "submitted")))
      .returning();
    if (!row) throw new ApiError(404, "Match not found or not in submitted state");

    // Audit + version snapshot. Non-fatal — a broken audit table won't
    // roll back the recommendation.
    const actor = actorFromReq(req);
    await logAudit({
      entity_type: "articleship_matches",
      entity_id: row.id,
      action: "status_changed",
      actor,
      before,
      after: row,
      note: notes ? `Recommended ${recommended.length} firm(s). ${notes}` : `Recommended ${recommended.length} firm(s).`,
    });
    await saveVersion({
      entity_type: "articleship_matches",
      entity_id: row.id,
      snapshot: row,
      actor,
      change_note: `Status → matched · ${recommended.length} firm(s) shortlisted`,
    });

    // Fetch firm details to include names + contact info in the email.
    // Best-effort: if this fails, the row is already saved — the student
    // just doesn't get the notification, which they can see on their
    // dashboard on next reload.
    try {
      const firmRows = await db.select({
        id: firms.id,
        name: firms.name,
        phone: firms.phone,
        email: firms.email,
        city: firms.city,
      }).from(firms).where(inArray(firms.id, recommended));

      const firmLines = firmRows.map((f, i) => {
        const contact = [f.phone, f.email].filter(Boolean).join(" · ");
        return `  ${i + 1}. ${f.name}${f.city ? ` (${f.city})` : ""}${contact ? `\n     ${contact}` : ""}`;
      }).join("\n");
      const firmNamesCsv = firmRows.map((f) => f.name).join(", ");

      const base = (process.env.PUBLIC_APP_URL || process.env.VITE_PUBLIC_APP_URL || "https://icainagpur.in").replace(/\/+$/, "");
      const dashboardUrl = `${base}/dashboard#articleship`;
      // Pre-compute pluralised label + optional "Notes from WICASA" line
      // since our notify() renderer only substitutes {{plain_vars}} —
      // no conditional / pluralisation logic in templates.
      const firmCountLabel = firmRows.length === 1
        ? "1 firm"
        : `${firmRows.length} firms`;
      const notesLine = notes ? notes : "(none)";
      await notify({
        user_id: row.student_user_id,
        template_key: "articleship_match_recommended",
        link_url: dashboardUrl,
        vars: {
          firm_count: String(firmRows.length),
          firm_count_label: firmCountLabel,
          firm_lines: firmLines,
          firm_names_csv: firmNamesCsv,
          notes_line: notesLine,
          link_url: dashboardUrl,
        },
      });
    } catch (notifyErr) {
      // eslint-disable-next-line no-console
      console.error("[articleship-matches] notify failed", notifyErr);
    }

    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/articleship-matches/:id/placed ───────────────────────
articleshipMatchesAdminRouter.post("/:id/placed", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Match ID");
    const placed_firm_id = need(trim(req.body?.placed_firm_id), "Placed firm ID");

    const [row] = await db.update(articleshipMatches)
      .set({
        status: "placed",
        placed_firm_id,
        updated_at: new Date(),
      })
      .where(and(eq(articleshipMatches.id, id), eq(articleshipMatches.status, "matched")))
      .returning();
    if (!row) throw new ApiError(404, "Match not found or not in matched state");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/articleship-matches/:id/cancel ───────────────────────
articleshipMatchesAdminRouter.post("/:id/cancel", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Match ID");
    const notes = trim(req.body?.notes) || null;
    const [row] = await db.update(articleshipMatches)
      .set({ status: "cancelled", notes, updated_at: new Date() })
      .where(eq(articleshipMatches.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Match not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/admin/articleship-matches/export.csv ────────────────────────
// Dump every submission as CSV. WICASA uses this for offline meetings —
// e.g. print the pending queue, review with the branch chair on paper,
// come back to the site to POST the recommendations. Status filter mirrors
// the list endpoint.
articleshipMatchesAdminRouter.get("/export.csv", async (req, res, next) => {
  try {
    const status = trim(req.query.status);
    const conds: any[] = [];
    if (status && STATUSES.includes(status as Status)) conds.push(eq(articleshipMatches.status, status));

    const rows = await db.select({
      created_at: articleshipMatches.created_at,
      status: articleshipMatches.status,
      student_name: users.name,
      student_email: users.email,
      preferred_specialisations: articleshipMatches.preferred_specialisations,
      preferred_firm_size: articleshipMatches.preferred_firm_size,
      expected_stipend_paise: articleshipMatches.expected_stipend_paise,
      seminar_event_title: events.title,
      notes: articleshipMatches.notes,
      placed_firm_name: firms.name,
    })
      .from(articleshipMatches)
      .leftJoin(users,  eq(users.id, articleshipMatches.student_user_id))
      .leftJoin(events, eq(events.id, articleshipMatches.seminar_event_id))
      .leftJoin(firms,  eq(firms.id,  articleshipMatches.placed_firm_id))
      .where(conds.length ? and(...conds) : sql`true`)
      .orderBy(desc(articleshipMatches.created_at));

    // Simple, safe CSV — quote every cell, double up embedded quotes.
    // No streaming yet because branch volume is < 1000 rows per year.
    const esc = (v: unknown): string => {
      if (v == null) return "";
      const s = Array.isArray(v) ? v.join("; ") : String(v);
      return `"${s.replace(/"/g, '""')}"`;
    };
    const header = [
      "Submitted", "Status", "Student", "Email",
      "Specialisations", "Firm size", "Expected stipend (₹)",
      "Seminar", "Placed firm", "Notes",
    ].map(esc).join(",");
    const body = rows.map((r) => [
      r.created_at?.toISOString().slice(0, 10),
      r.status,
      r.student_name,
      r.student_email,
      r.preferred_specialisations,
      r.preferred_firm_size,
      r.expected_stipend_paise != null ? Math.round(Number(r.expected_stipend_paise) / 100) : "",
      r.seminar_event_title,
      r.placed_firm_name,
      r.notes,
    ].map(esc).join(",")).join("\n");

    const filename = `articleship-matches-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(header + "\n" + body);
  } catch (err) { handleApiError(err, res, next); }
});
