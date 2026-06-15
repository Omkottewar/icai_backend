import { Router } from "express";
import { and, eq, gte, inArray, isNull, or } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  siteContent, siteSettings,
  users, userRoleAssignments, roles, files,
} from "../../schema/index.js";
import { handleApiError } from "../lib/apiError.js";
import { storage } from "../lib/storage.js";

export const siteRouter = Router();

// â”€â”€â”€ GET /api/site/content â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Public, no auth. Returns every site_content row keyed by slug. Frontend
// caches this for the page lifetime â€” site copy changes are rare and we want
// HomePage / AboutPage / etc. to share a single fetch.
siteRouter.get("/content", async (_req, res, next) => {
  try {
    const rows = await db.select({
      slug:       siteContent.slug,
      data:       siteContent.data,
      updated_at: siteContent.updated_at,
    }).from(siteContent);
    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ GET /api/site/settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Public, no auth. Returns settings as a flat { key: value } object â€” the
// shape every consumer (Header, Footer, ContactPage) wants directly.
siteRouter.get("/settings", async (_req, res, next) => {
  try {
    const rows = await db.select({
      key:   siteSettings.key,
      value: siteSettings.value,
    }).from(siteSettings);
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    res.json(out);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ GET /api/site/managing-committee â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Public roster for the About page. Pulled from user_role_assignments rather
// than maintained as a separate editable list â€” the underlying role-holders
// are already managed via the users admin. Order: office bearers first
// (chairman â†’ vice chairman â†’ secretary â†’ treasurer), then MCMs alphabetic.
const MC_ROLE_CODES = [
  "branch_chairman",
  "branch_vice_chairman",
  "branch_secretary",
  "branch_treasurer",
  "mcm",
];

const ROLE_ORDER: Record<string, number> = {
  branch_chairman:       0,
  branch_vice_chairman:  1,
  branch_secretary:      2,
  branch_treasurer:      3,
  mcm:                   4,
};

siteRouter.get("/managing-committee", async (_req, res, next) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    const rows = await db.select({
      user_id:      users.id,
      name:         users.name,
      email:        users.email,
      avatar_path:  files.storage_path,
      role_code:    roles.code,
      role_name:    roles.name,
    })
      .from(userRoleAssignments)
      .innerJoin(roles, eq(roles.id, userRoleAssignments.role_id))
      .innerJoin(users, eq(users.id, userRoleAssignments.user_id))
      .leftJoin(files, eq(files.id, users.avatar_id))
      .where(and(
        inArray(roles.code, MC_ROLE_CODES),
        isNull(users.deleted_at),
        or(
          isNull(userRoleAssignments.effective_to),
          gte(userRoleAssignments.effective_to, today),
        ),
      ));

    // De-dupe: a single user can hold multiple roles (e.g. office bearers also
    // carry `mcm`). Keep the highest-precedence role per user.
    const byUser = new Map<string, typeof rows[number]>();
    for (const r of rows) {
      const existing = byUser.get(r.user_id);
      if (!existing || (ROLE_ORDER[r.role_code] ?? 999) < (ROLE_ORDER[existing.role_code] ?? 999)) {
        byUser.set(r.user_id, r);
      }
    }

    const list = Array.from(byUser.values())
      .map((r) => ({
        user_id:   r.user_id,
        name:      r.name,
        role_code: r.role_code,
        role_name: r.role_name,
        avatar_url: r.avatar_path ? storage().url(r.avatar_path) : null,
      }))
      .sort((a, b) => {
        const pa = ROLE_ORDER[a.role_code] ?? 999;
        const pb = ROLE_ORDER[b.role_code] ?? 999;
        if (pa !== pb) return pa - pb;
        return a.name.localeCompare(b.name);
      });

    res.json({ rows: list });
  } catch (err) { handleApiError(err, res, next); }
});

