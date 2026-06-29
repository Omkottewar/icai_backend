import { Router } from "express";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  checklistTemplates, checklistTemplateQuestions, checklistInstances,
} from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import { isAdmin } from "../auth/permissions.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";
import {
  isQuestionType, normaliseConfig, type QuestionType,
} from "../lib/checklistQuestions.js";

export const checklistTemplatesRouter = Router();
checklistTemplatesRouter.use(requireUser);

// All template endpoints are admin-only. Templates are the "form designer"
// surface; non-admins consume instances (which live on a different router).
async function requireAdminUser(req: AuthedRequest) {
  if (!(await isAdmin(req.user!.id))) throw new ApiError(403, "Admin only");
}

// Allowed approver role codes. Empty (default) → single-reviewer flow.
// Non-empty → ensureApprovalStages() creates one stage per listed role
// at release time. Filter anything the UI shouldn't have sent so a bad
// payload can't poison the array.
const VALID_APPROVER_ROLES = new Set([
  "branch_chairman",
  "branch_vice_chairman",
  "branch_secretary",
  "branch_treasurer",
]);
function sanitiseApproverRoleCodes(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const v of input) {
    const s = typeof v === "string" ? v.trim() : "";
    if (s && VALID_APPROVER_ROLES.has(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

// ─── GET /api/checklist-templates ─────────────────────────────────────────
// Lists the LATEST version per family, plus a count of versions in the family.
// Set ?all=1 to see every version (used by the version history drawer).
//
// Starter templates (is_starter=true) are hidden — they live behind the
// dedicated /starters endpoint and aren't part of the user's editable
// inventory.
checklistTemplatesRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    await requireAdminUser(req);
    const showAll = req.query.all === "1";

    if (showAll) {
      const rows = await db
        .select()
        .from(checklistTemplates)
        .where(and(
          isNull(checklistTemplates.deleted_at),
          eq(checklistTemplates.is_starter, false),
        ))
        .orderBy(desc(checklistTemplates.updated_at));
      return res.json({ rows });
    }

    // Latest version per family. Sub-select pattern keeps it one round-trip.
    const result = await db.execute(sql`
      SELECT t.*, fam.version_count
      FROM checklist_templates t
      INNER JOIN (
        SELECT family_id,
               MAX(version) AS max_version,
               COUNT(*)     AS version_count
        FROM checklist_templates
        WHERE deleted_at IS NULL AND is_starter = false
        GROUP BY family_id
      ) fam ON fam.family_id = t.family_id AND fam.max_version = t.version
      WHERE t.deleted_at IS NULL AND t.is_starter = false
      ORDER BY t.updated_at DESC
    `);
    res.json({ rows: Array.from(result) });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/checklist-templates/starters ────────────────────────────────
// Curated, system-supplied templates the "+ New template" gallery shows
// the user as one-click starting points. Always sorted by name so the
// order is stable.
//
// `question_count` excludes section_heading rows since those aren't really
// "items the user has to fill" — gives a meaningful number for the card UI.
checklistTemplatesRouter.get("/starters", async (req: AuthedRequest, res, next) => {
  try {
    await requireAdminUser(req);
    const result = await db.execute(sql`
      SELECT t.*,
             (SELECT COUNT(*)::int FROM checklist_template_questions q
              WHERE q.template_id = t.id AND q.type <> 'section_heading') AS question_count,
             (SELECT COUNT(*)::int FROM checklist_template_questions q
              WHERE q.template_id = t.id AND q.type = 'section_heading') AS section_count
      FROM checklist_templates t
      WHERE t.is_starter = true AND t.deleted_at IS NULL
      ORDER BY t.name ASC
    `);
    res.json({ rows: Array.from(result) });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /api/checklist-templates/:id ─────────────────────────────────────
checklistTemplatesRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    await requireAdminUser(req);
    const id = String(req.params.id);

    const [template] = await db
      .select()
      .from(checklistTemplates)
      .where(eq(checklistTemplates.id, id))
      .limit(1);
    if (!template || template.deleted_at) throw new ApiError(404, "Template not found");

    const questions = await db
      .select()
      .from(checklistTemplateQuestions)
      .where(eq(checklistTemplateQuestions.template_id, id))
      .orderBy(asc(checklistTemplateQuestions.sort_order), asc(checklistTemplateQuestions.created_at));

    // Quick stats for the admin list UI.
    const [{ instances_count }] = await db
      .select({ instances_count: sql<number>`COUNT(*)::int`.as("instances_count") })
      .from(checklistInstances)
      .where(eq(checklistInstances.template_id, id));

    res.json({ template, questions, instances_count });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/checklist-templates ────────────────────────────────────────
// Creates v1 of a new template family. New rows are always draft (not published).
checklistTemplatesRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    await requireAdminUser(req);
    const name = need(trim(req.body.name), "Name");
    const description = trim(req.body.description) || null;
    const category    = trim(req.body.category)    || null;
    const fill_role   = trim(req.body.fill_role)   || null;
    const review_role = trim(req.body.review_role) || null;
    const approver_role_codes = sanitiseApproverRoleCodes(req.body.approver_role_codes);
    const questions = Array.isArray(req.body.questions) ? req.body.questions : [];

    const created = await db.transaction(async (tx) => {
      const family_id = crypto.randomUUID();
      const [row] = await tx.insert(checklistTemplates).values({
        family_id,
        version: 1,
        name, description, category,
        fill_role, review_role,
        approver_role_codes,
        created_by: req.user!.id,
        is_published: false,
      }).returning();

      if (questions.length > 0) {
        await tx.insert(checklistTemplateQuestions).values(
          questions.map((q: any, idx: number) => buildQuestionInsert(row.id, q, idx)),
        );
      }
      return row;
    });
    res.status(201).json(created);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /api/checklist-templates/:id ───────────────────────────────────
// Update metadata + replace the question set. Only legal while is_published
// is false (the DB trigger blocks question writes against published rows).
// Pass questions: [...] to overwrite; omit to leave questions alone.
checklistTemplatesRouter.patch("/:id", async (req: AuthedRequest, res, next) => {
  try {
    await requireAdminUser(req);
    const id = String(req.params.id);

    const [existing] = await db.select().from(checklistTemplates).where(eq(checklistTemplates.id, id)).limit(1);
    if (!existing || existing.deleted_at) throw new ApiError(404, "Template not found");
    if (existing.is_starter) throw new ApiError(400, "Starter templates are read-only. Click \"Use\" to make your own copy first.");
    if (existing.is_published) throw new ApiError(400, "Published templates are locked. Clone a new version to edit.");

    const patch: Record<string, any> = {};
    if (req.body.name        !== undefined) patch.name        = need(trim(req.body.name), "Name");
    if (req.body.description !== undefined) patch.description = trim(req.body.description) || null;
    if (req.body.category    !== undefined) patch.category    = trim(req.body.category)    || null;
    if (req.body.fill_role   !== undefined) patch.fill_role   = trim(req.body.fill_role)   || null;
    if (req.body.review_role !== undefined) patch.review_role = trim(req.body.review_role) || null;
    if (req.body.approver_role_codes !== undefined) patch.approver_role_codes = sanitiseApproverRoleCodes(req.body.approver_role_codes);

    const questions = Array.isArray(req.body.questions) ? req.body.questions : null;

    const updated = await db.transaction(async (tx) => {
      if (Object.keys(patch).length > 0) {
        await tx.update(checklistTemplates).set(patch).where(eq(checklistTemplates.id, id));
      }
      if (questions) {
        await tx.delete(checklistTemplateQuestions).where(eq(checklistTemplateQuestions.template_id, id));
        if (questions.length > 0) {
          await tx.insert(checklistTemplateQuestions).values(
            questions.map((q: any, idx: number) => buildQuestionInsert(id, q, idx)),
          );
        }
      }
      const [row] = await tx.select().from(checklistTemplates).where(eq(checklistTemplates.id, id)).limit(1);
      return row;
    });
    res.json(updated);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/checklist-templates/:id/publish ────────────────────────────
// Flip is_published → true. Locks the question set for that version.
checklistTemplatesRouter.post("/:id/publish", async (req: AuthedRequest, res, next) => {
  try {
    await requireAdminUser(req);
    const id = String(req.params.id);

    const [existing] = await db.select().from(checklistTemplates).where(eq(checklistTemplates.id, id)).limit(1);
    if (!existing || existing.deleted_at) throw new ApiError(404, "Template not found");
    if (existing.is_starter) throw new ApiError(400, "Starter templates are already active.");
    if (existing.is_published) return res.json(existing);

    const [questionCount] = await db
      .select({ n: sql<number>`COUNT(*)::int`.as("n") })
      .from(checklistTemplateQuestions)
      .where(eq(checklistTemplateQuestions.template_id, id));
    if ((questionCount?.n ?? 0) === 0) throw new ApiError(400, "Add at least one question before publishing");

    const [row] = await db.update(checklistTemplates)
      .set({ is_published: true, published_at: new Date() })
      .where(eq(checklistTemplates.id, id))
      .returning();
    res.json(row);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/checklist-templates/:id/clone ──────────────────────────────
// Forks a new draft version into the same family (or a brand-new family if
// ?fork=1). Copies metadata + every question. Use this to edit a published
// template — never the original.
checklistTemplatesRouter.post("/:id/clone", async (req: AuthedRequest, res, next) => {
  try {
    await requireAdminUser(req);
    const id = String(req.params.id);
    const newFamily = req.query.fork === "1";

    const [src] = await db.select().from(checklistTemplates).where(eq(checklistTemplates.id, id)).limit(1);
    if (!src) throw new ApiError(404, "Template not found");
    // Cloning FROM a starter is always a new family — there's no "v2 of a
    // starter" semantics; users should get a clean copy they fully own.
    const isStarterClone = src.is_starter;
    const forkAsNewFamily = newFamily || isStarterClone;

    const created = await db.transaction(async (tx) => {
      let family_id: string;
      let version: number;
      if (forkAsNewFamily) {
        family_id = crypto.randomUUID();
        version = 1;
      } else {
        family_id = src.family_id;
        const [{ next_version }] = await tx
          .select({ next_version: sql<number>`(COALESCE(MAX(${checklistTemplates.version}), 0) + 1)::int`.as("next_version") })
          .from(checklistTemplates)
          .where(eq(checklistTemplates.family_id, family_id));
        version = next_version;
      }

      // Naming rules:
      //   • Cloning a starter → plain starter name (the user just picked
      //     "CPE Seminar" from the gallery; they don't want "(copy)" tacked on).
      //   • Forking a user template into a new family → "{name} (copy)".
      //   • New version in the same family → exact same name.
      const clonedName = isStarterClone
        ? src.name
        : (newFamily ? `${src.name} (copy)` : src.name);

      const [row] = await tx.insert(checklistTemplates).values({
        family_id, version,
        name: clonedName,
        description: src.description,
        category: src.category,
        fill_role: src.fill_role,
        review_role: src.review_role,
        approver_role_codes: src.approver_role_codes ?? [],
        created_by: req.user!.id,
        is_published: false,
        // Clones are never starters themselves — even if the source was one.
        is_starter: false,
      }).returning();

      const srcQuestions = await tx
        .select()
        .from(checklistTemplateQuestions)
        .where(eq(checklistTemplateQuestions.template_id, src.id))
        .orderBy(asc(checklistTemplateQuestions.sort_order));

      if (srcQuestions.length > 0) {
        await tx.insert(checklistTemplateQuestions).values(srcQuestions.map((q, idx) => ({
          template_id: row.id,
          sort_order: idx,
          type: q.type,
          label: q.label,
          help_text: q.help_text,
          required: q.required,
          config: q.config as any,
          // section_owner_role lives on section_heading rows — preserving it
          // is critical for starter clones where the whole point is "the
          // treasurer reviews Budget, the VC reviews Speakers, etc."
          section_owner_role: q.section_owner_role,
        })));
      }
      return row;
    });

    res.status(201).json(created);
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/checklist-templates/:id ──────────────────────────────────
// Soft-delete the template. Only blocks if a LIVE instance still references
// this template — i.e. one that is not soft-deleted and is still in a
// non-terminal status. Soft-deleted instances and terminal instances
// (approved / rejected) don't block: the FK keeps audit history intact even
// after the template row is marked deleted.
//
// `?force=1` cascades a soft-delete to the live instances too. This is
// what the admin actually wants when they say "delete the template I just
// created by mistake" — without force we'd nag them about an instance they
// already meant to discard.
checklistTemplatesRouter.delete("/:id", async (req: AuthedRequest, res, next) => {
  try {
    await requireAdminUser(req);
    const id = String(req.params.id);
    const force = req.query.force === "1" || req.query.force === "true";

    // Starters can't be deleted via the API — they're system rows. The
    // seed script is the only way to add/replace them.
    const [target] = await db.select({ is_starter: checklistTemplates.is_starter })
      .from(checklistTemplates)
      .where(eq(checklistTemplates.id, id))
      .limit(1);
    if (target?.is_starter) throw new ApiError(400, "Starter templates can't be deleted.");

    // Live instance = not soft-deleted AND not in a terminal status.
    const [{ live }] = await db
      .select({ live: sql<number>`COUNT(*)::int`.as("live") })
      .from(checklistInstances)
      .where(and(
        eq(checklistInstances.template_id, id),
        isNull(checklistInstances.deleted_at),
        sql`${checklistInstances.status} NOT IN ('approved', 'rejected')`,
      ));

    if ((live ?? 0) > 0 && !force) {
      throw new ApiError(
        400,
        `Cannot delete: ${live} active instance(s) reference this template. Retry with ?force=1 to also soft-delete those instances.`,
      );
    }

    await db.transaction(async (tx) => {
      if (force && (live ?? 0) > 0) {
        await tx.update(checklistInstances)
          .set({ deleted_at: new Date() })
          .where(and(
            eq(checklistInstances.template_id, id),
            isNull(checklistInstances.deleted_at),
          ));
      }
      const [row] = await tx.update(checklistTemplates)
        .set({ deleted_at: new Date() })
        .where(eq(checklistTemplates.id, id))
        .returning();
      if (!row) throw new ApiError(404, "Template not found");
    });

    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── helpers ──────────────────────────────────────────────────────────────

function buildQuestionInsert(template_id: string, q: any, idx: number) {
  const type = q?.type;
  if (!isQuestionType(type)) throw new ApiError(400, `Unknown question type: ${type}`);
  const label = need(trim(q?.label), "Question label");
  const help_text = trim(q?.help_text) || null;
  const required = q?.required !== false;
  const config = normaliseConfig(type as QuestionType, q?.config);
  const sort_order = Number.isFinite(Number(q?.sort_order)) ? Number(q.sort_order) : idx;
  // Only persist section_owner_role on section_heading rows. The frontend
  // should already null it out for other types, but defensive on the
  // backend in case an old client sends it.
  const section_owner_role = type === "section_heading"
    ? (trim(q?.section_owner_role) || null)
    : null;
  return { template_id, sort_order, type, label, help_text, required, config, section_owner_role };
}
