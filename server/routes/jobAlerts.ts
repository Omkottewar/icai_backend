// Job-alerts public routes.
//
// Endpoints:
//   GET    /api/job-alerts/categories       — public — active category list
//   GET    /api/job-alerts/me               — auth   — the caller's subs
//   POST   /api/job-alerts/subscribe        — auth   — create/reactivate subs
//   POST   /api/job-alerts/unsubscribe      — auth   — soft unsub selected subs
//   POST   /api/job-alerts/unsubscribe-all  — auth   — kill every sub of caller
//   GET    /api/job-alerts/confirm          — public (token) — flip confirmed_at
//   GET    /api/job-alerts/manage           — public (token) — token → user_id
//     (the frontend then calls the auth'd endpoints with a session that the
//      confirm/manage flow can set up if the browser has no session)

import { Router } from "express";
import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "../../db/client.js";
import { jobAlertSubscriptions, jobCategories, users } from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { sameOrigin } from "../middleware/sameOrigin.js";
import { ApiError, handleApiError, trim } from "../lib/apiError.js";
import { sendConfirmationEmail } from "../lib/jobAlerts.js";
import { verifyToken } from "../lib/tokens.js";

export const jobAlertsRouter = Router();

const POSTING_TYPES = new Set(["job", "articleship", "assignment"]);
const FREQUENCIES = new Set(["instant", "daily_digest", "weekly_digest"]);

// ─── Public — list categories ────────────────────────────────────────────
jobAlertsRouter.get("/categories", async (_req, res, next) => {
  try {
    const rows = await db
      .select({
        id: jobCategories.id,
        code: jobCategories.code,
        name: jobCategories.name,
        description: jobCategories.description,
        sort_order: jobCategories.sort_order,
      })
      .from(jobCategories)
      .where(eq(jobCategories.active, true))
      .orderBy(asc(jobCategories.sort_order), asc(jobCategories.name));
    res.json({ items: rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Auth — my current subs ──────────────────────────────────────────────
jobAlertsRouter.get("/me", requireUser, async (req: AuthedRequest, res, next) => {
  try {
    const rows = await db
      .select({
        id: jobAlertSubscriptions.id,
        category_id: jobAlertSubscriptions.category_id,
        category_name: jobCategories.name,
        posting_type: jobAlertSubscriptions.posting_type,
        frequency: jobAlertSubscriptions.frequency,
        filter_location: jobAlertSubscriptions.filter_location,
        filter_experience: jobAlertSubscriptions.filter_experience,
        confirmed_at: jobAlertSubscriptions.confirmed_at,
        unsubscribed_at: jobAlertSubscriptions.unsubscribed_at,
        created_at: jobAlertSubscriptions.created_at,
      })
      .from(jobAlertSubscriptions)
      .leftJoin(jobCategories, eq(jobCategories.id, jobAlertSubscriptions.category_id))
      .where(eq(jobAlertSubscriptions.user_id, req.user!.id))
      .orderBy(asc(jobCategories.sort_order), asc(jobAlertSubscriptions.posting_type));
    res.json({ items: rows });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Auth — subscribe (bulk) ─────────────────────────────────────────────
// Body: {
//   category_ids: string[],
//   posting_types: string[],  // one of job/articleship/assignment
//   frequency?: 'instant' | 'daily_digest' | 'weekly_digest',
//   filter_location?: string,
//   filter_experience?: string
// }
//
// One row is upserted per (category_id, posting_type). Existing rows are
// reactivated (unsubscribed_at set NULL) and their frequency/filters updated.
// Confirmation email is sent if any sub is still unconfirmed after the write.
jobAlertsRouter.post("/subscribe", requireUser, sameOrigin, async (req: AuthedRequest, res, next) => {
  try {
    const userRole = req.user!.primary_role;
    if (userRole !== "member" && userRole !== "student") {
      throw new ApiError(403, "Job alerts are for members and students");
    }

    const category_ids: string[] = Array.isArray(req.body.category_ids) ? req.body.category_ids : [];
    const posting_types: string[] = Array.isArray(req.body.posting_types) ? req.body.posting_types : [];
    const frequency = FREQUENCIES.has(req.body.frequency) ? req.body.frequency : "instant";
    const filter_location = trim(req.body.filter_location) || null;
    const filter_experience = trim(req.body.filter_experience) || null;

    if (category_ids.length === 0) throw new ApiError(400, "Pick at least one category");
    if (posting_types.length === 0) throw new ApiError(400, "Pick at least one posting type");
    for (const t of posting_types) {
      if (!POSTING_TYPES.has(t)) throw new ApiError(400, `Invalid posting type: ${t}`);
    }

    // Guard: every category_id must exist and be active.
    const validCats = await db.select({ id: jobCategories.id, name: jobCategories.name })
      .from(jobCategories)
      .where(and(inArray(jobCategories.id, category_ids), eq(jobCategories.active, true)));
    const validCatIds = new Set(validCats.map((c) => c.id));
    for (const c of category_ids) {
      if (!validCatIds.has(c)) throw new ApiError(400, `Unknown or inactive category: ${c}`);
    }

    const now = new Date();
    const rows: Array<{ category_id: string; posting_type: string }> = [];
    for (const c of category_ids) {
      for (const t of posting_types) {
        rows.push({ category_id: c, posting_type: t });
      }
    }

    // Upsert one row at a time — small N (<= ~30 combinations), and the
    // per-row logic is simpler than a bulk statement with jsonb args.
    for (const row of rows) {
      await db.insert(jobAlertSubscriptions).values({
        user_id: req.user!.id,
        category_id: row.category_id,
        posting_type: row.posting_type as any,
        frequency,
        filter_location,
        filter_experience,
        // NOTE: don't set confirmed_at here — sendConfirmationEmail handles
        // that flow. However, if this user already has ANY confirmed sub,
        // we treat them as pre-verified (see below).
      }).onConflictDoUpdate({
        target: [jobAlertSubscriptions.user_id, jobAlertSubscriptions.category_id, jobAlertSubscriptions.posting_type],
        set: {
          frequency,
          filter_location,
          filter_experience,
          unsubscribed_at: null,
          updated_at: now,
        },
      });
    }

    // Is this user already confirmed on any prior sub? Double opt-in is
    // per-user (not per-sub), so a re-subscribe by someone who confirmed
    // last month doesn't need another email round-trip.
    const [confirmedRow] = await db
      .select({ id: jobAlertSubscriptions.id })
      .from(jobAlertSubscriptions)
      .where(and(
        eq(jobAlertSubscriptions.user_id, req.user!.id),
        isNotNull(jobAlertSubscriptions.confirmed_at),
      ))
      .limit(1);
    const userIsConfirmed = Boolean(confirmedRow);

    if (userIsConfirmed) {
      // Backfill confirmed_at on any newly-inserted rows so instant alerts
      // begin firing immediately.
      await db.update(jobAlertSubscriptions)
        .set({ confirmed_at: now })
        .where(and(
          eq(jobAlertSubscriptions.user_id, req.user!.id),
          isNull(jobAlertSubscriptions.confirmed_at),
        ));
    } else {
      // Fire the confirmation email.
      await sendConfirmationEmail(req.user!.id, validCats.map((c) => c.name));
    }

    res.json({ ok: true, confirmed: userIsConfirmed });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Auth — unsubscribe from selected subs ───────────────────────────────
// Body: { subscription_ids: string[] }
jobAlertsRouter.post("/unsubscribe", requireUser, sameOrigin, async (req: AuthedRequest, res, next) => {
  try {
    const ids: string[] = Array.isArray(req.body.subscription_ids) ? req.body.subscription_ids : [];
    if (ids.length === 0) throw new ApiError(400, "Nothing to unsubscribe");
    await db.update(jobAlertSubscriptions)
      .set({ unsubscribed_at: new Date(), updated_at: new Date() })
      .where(and(
        inArray(jobAlertSubscriptions.id, ids),
        eq(jobAlertSubscriptions.user_id, req.user!.id),
      ));
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Auth — unsubscribe from everything ──────────────────────────────────
jobAlertsRouter.post("/unsubscribe-all", requireUser, sameOrigin, async (req: AuthedRequest, res, next) => {
  try {
    await db.update(jobAlertSubscriptions)
      .set({ unsubscribed_at: new Date(), updated_at: new Date() })
      .where(and(
        eq(jobAlertSubscriptions.user_id, req.user!.id),
        isNull(jobAlertSubscriptions.unsubscribed_at),
      ));
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Public — confirm subscription via token ─────────────────────────────
// GET /api/job-alerts/confirm?token=...
// Verifies the HMAC token, flips confirmed_at on every unconfirmed sub for
// that user, and returns { ok, email } so the confirm page can render a
// friendly landing.
jobAlertsRouter.get("/confirm", async (req, res, next) => {
  try {
    const token = trim(req.query.token);
    if (!token) throw new ApiError(400, "Missing confirmation token");
    const user_id = verifyToken(token, "job_alert_confirm");
    if (!user_id) throw new ApiError(400, "This confirmation link is invalid or has expired");

    const now = new Date();
    await db.update(jobAlertSubscriptions)
      .set({ confirmed_at: now, updated_at: now })
      .where(and(
        eq(jobAlertSubscriptions.user_id, user_id),
        isNull(jobAlertSubscriptions.confirmed_at),
      ));

    const [u] = await db.select({ email: users.email, name: users.name })
      .from(users).where(eq(users.id, user_id)).limit(1);
    res.json({ ok: true, email: u?.email, name: u?.name });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Public — resolve manage token to user info ──────────────────────────
// The preference-centre page uses this to show subs without requiring the
// user to be logged in (unsubscribe compliance). Mutations still go through
// the auth'd /unsubscribe endpoints, so the page shows a "sign in to edit"
// state when the token identifies a user without an active session.
jobAlertsRouter.get("/manage", async (req, res, next) => {
  try {
    const token = trim(req.query.token);
    if (!token) throw new ApiError(400, "Missing token");
    const user_id = verifyToken(token, "job_alert_manage");
    if (!user_id) throw new ApiError(400, "This link is invalid or has expired");

    const [u] = await db.select({ email: users.email, name: users.name })
      .from(users).where(eq(users.id, user_id)).limit(1);
    if (!u) throw new ApiError(404, "User not found");

    const subs = await db
      .select({
        id: jobAlertSubscriptions.id,
        category_id: jobAlertSubscriptions.category_id,
        category_name: jobCategories.name,
        posting_type: jobAlertSubscriptions.posting_type,
        frequency: jobAlertSubscriptions.frequency,
        confirmed_at: jobAlertSubscriptions.confirmed_at,
        unsubscribed_at: jobAlertSubscriptions.unsubscribed_at,
      })
      .from(jobAlertSubscriptions)
      .leftJoin(jobCategories, eq(jobCategories.id, jobAlertSubscriptions.category_id))
      .where(eq(jobAlertSubscriptions.user_id, user_id))
      .orderBy(asc(jobCategories.sort_order));

    res.json({ user: { name: u.name, email: u.email }, subs });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── Public — one-click unsub via token ──────────────────────────────────
// POST /api/job-alerts/manage-unsubscribe   body: { token, subscription_ids? }
// Passing no ids kills every sub for that user (used by the "unsubscribe all"
// button on the preference centre).
jobAlertsRouter.post("/manage-unsubscribe", sameOrigin, async (req, res, next) => {
  try {
    const token = trim(req.body?.token);
    if (!token) throw new ApiError(400, "Missing token");
    const user_id = verifyToken(token, "job_alert_manage");
    if (!user_id) throw new ApiError(400, "This link is invalid or has expired");

    const ids: string[] = Array.isArray(req.body.subscription_ids) ? req.body.subscription_ids : [];
    const now = new Date();
    if (ids.length > 0) {
      await db.update(jobAlertSubscriptions)
        .set({ unsubscribed_at: now, updated_at: now })
        .where(and(
          inArray(jobAlertSubscriptions.id, ids),
          eq(jobAlertSubscriptions.user_id, user_id),
        ));
    } else {
      await db.update(jobAlertSubscriptions)
        .set({ unsubscribed_at: now, updated_at: now })
        .where(and(
          eq(jobAlertSubscriptions.user_id, user_id),
          isNull(jobAlertSubscriptions.unsubscribed_at),
        ));
    }
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
