import { Router } from "express";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client.js";
import {
  eventChecklists, eventChecklistItems, eventChecklistReviews,
  events, committees, users,
} from "../../schema/index.js";
import { requireUser, type AuthedRequest } from "../middleware/requireUser.js";
import {
  getActiveRoleCodes, getCommitteesUserChairs, isAdmin, isBranchChairman,
  loadUserPermissions,
} from "../auth/permissions.js";
import { ApiError, handleApiError, need, trim } from "../lib/apiError.js";

export const checklistsRouter = Router();
checklistsRouter.use(requireUser);

const KINDS = ["money", "number", "text", "date"] as const;
function pickKind(v: unknown) {
  return KINDS.includes(v as any) ? (v as typeof KINDS[number]) : "text";
}

// â”€â”€â”€ permission helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Loads checklist + event, then evaluates what the requesting user may do.
async function loadAndAuthorize(checklistId: string, userId: string) {
  const [row] = await db
    .select({
      checklist: eventChecklists,
      event_id: events.id,
      event_title: events.title,
      event_status: events.status,
      event_committee_id: events.committee_id,
      committee_code: committees.code,
      committee_name: committees.name,
    })
    .from(eventChecklists)
    .innerJoin(events, eq(events.id, eventChecklists.event_id))
    .leftJoin(committees, eq(committees.id, events.committee_id))
    .where(eq(eventChecklists.id, checklistId))
    .limit(1);
  if (!row) throw new ApiError(404, "Checklist not found");

  const perms = await loadUserPermissions(userId);
  const isCommitteeChair = perms.committeeChairmanOf.includes(row.event_committee_id);

  return {
    row,
    perms: {
      canEdit: perms.isAdmin,                          // build/edit items (admin-only)
      canFill: isCommitteeChair,                       // committee chairman only â€” separation of duties
      canSubmitForReview: isCommitteeChair,
      canReview: perms.isBranchChairman,               // branch chairman only â€” admin cannot self-approve
      canRead: perms.isAdmin || isCommitteeChair || perms.isBranchChairman,
    },
  };
}

// â”€â”€â”€ GET /api/checklists â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Lists checklists the current user can act on.
checklistsRouter.get("/", async (req: AuthedRequest, res, next) => {
  try {
    const userId = req.user!.id;
    const perms = await loadUserPermissions(userId);

    // Build the visibility filter as a set of OR clauses.
    const orConds: any[] = [];
    if (perms.isAdmin) orConds.push(sql`TRUE`);
    if (perms.isBranchChairman) {
      orConds.push(eq(eventChecklists.status, "awaiting_branch_review"));
    }
    if (perms.committeeChairmanOf.length > 0) {
      orConds.push(and(
        eq(eventChecklists.status, "awaiting_committee"),
        inArray(events.committee_id, perms.committeeChairmanOf),
      ));
    }
    if (orConds.length === 0) return res.json({ rows: [] });

    const rows = await db
      .select({
        id: eventChecklists.id,
        event_id: eventChecklists.event_id,
        event_title: events.title,
        event_starts_at: events.starts_at,
        committee_code: committees.code,
        committee_name: committees.name,
        status: eventChecklists.status,
        created_at: eventChecklists.created_at,
        updated_at: eventChecklists.updated_at,
      })
      .from(eventChecklists)
      .innerJoin(events, eq(events.id, eventChecklists.event_id))
      .leftJoin(committees, eq(committees.id, events.committee_id))
      .where(orConds.length === 1 ? orConds[0] : sql`(${sql.join(orConds, sql` OR `)})`)
      .orderBy(desc(eventChecklists.updated_at));

    res.json({ rows });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ GET /api/checklists/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
checklistsRouter.get("/:id", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { row, perms } = await loadAndAuthorize(id, req.user!.id);
    if (!perms.canRead) throw new ApiError(403, "Forbidden");

    const items = await db
      .select()
      .from(eventChecklistItems)
      .where(eq(eventChecklistItems.checklist_id, id))
      .orderBy(asc(eventChecklistItems.sort_order), asc(eventChecklistItems.created_at));

    const reviews = await db
      .select({
        id: eventChecklistReviews.id,
        actor_id: eventChecklistReviews.actor_id,
        actor_name: users.name,
        action: eventChecklistReviews.action,
        note: eventChecklistReviews.note,
        created_at: eventChecklistReviews.created_at,
      })
      .from(eventChecklistReviews)
      .leftJoin(users, eq(users.id, eventChecklistReviews.actor_id))
      .where(eq(eventChecklistReviews.checklist_id, id))
      .orderBy(desc(eventChecklistReviews.created_at));

    res.json({
      checklist: row.checklist,
      event: {
        id: row.event_id,
        title: row.event_title,
        status: row.event_status,
        committee_code: row.committee_code,
        committee_name: row.committee_name,
      },
      items,
      reviews,
      perms,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ POST /api/checklists â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Admin creates the checklist for an event.
// Body: { event_id, items?: [{label, kind, required, sort_order}] }
checklistsRouter.post("/", async (req: AuthedRequest, res, next) => {
  try {
    if (!(await isAdmin(req.user!.id))) throw new ApiError(403, "Only admins can create checklists");

    const eventId = need(trim(req.body.event_id), "event_id");
    const [event] = await db.select({ id: events.id }).from(events).where(eq(events.id, eventId)).limit(1);
    if (!event) throw new ApiError(404, "Event not found");

    const initialItems = Array.isArray(req.body.items) ? req.body.items : [];

    // One transaction = one connection borrow + atomic create. The unique
    // constraint on event_id (from migration 0004) catches duplicate-create
    // races so we don't need a pre-flight SELECT.
    try {
      const created = await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(eventChecklists)
          .values({ event_id: eventId, created_by: req.user!.id, status: "awaiting_committee" })
          .returning();

        if (initialItems.length > 0) {
          await tx.insert(eventChecklistItems).values(initialItems.map((it: any, idx: number) => ({
            checklist_id: row.id,
            label: need(trim(it.label), "Item label"),
            kind: pickKind(it.kind),
            required: it.required !== false,
            sort_order: Number.isFinite(Number(it.sort_order)) ? Number(it.sort_order) : idx,
          })));
        }

        await tx.insert(eventChecklistReviews).values({
          checklist_id: row.id,
          actor_id: req.user!.id,
          action: "created",
        });

        return row;
      });
      res.status(201).json(created);
    } catch (e: any) {
      if (e?.code === "23505") throw new ApiError(409, "A checklist already exists for this event");
      throw e;
    }
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ POST /api/checklists/:id/items â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
checklistsRouter.post("/:id/items", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { perms } = await loadAndAuthorize(id, req.user!.id);
    if (!perms.canEdit) throw new ApiError(403, "Only admins can edit checklist items");

    const label = need(trim(req.body.label), "Label");
    const kind = pickKind(req.body.kind);
    const required = req.body.required !== false;
    const [{ maxOrder }] = await db
      .select({ maxOrder: sql<number>`COALESCE(MAX(${eventChecklistItems.sort_order}), -1)::int`.as("maxOrder") })
      .from(eventChecklistItems)
      .where(eq(eventChecklistItems.checklist_id, id));
    const sort = Number(req.body.sort_order ?? (maxOrder + 1));

    const [item] = await db.insert(eventChecklistItems).values({
      checklist_id: id, label, kind, required, sort_order: sort,
    }).returning();
    res.status(201).json(item);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ PATCH /api/checklists/:id/items/:itemId â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Admin: edit label/kind/required/sort. Committee chairman: only the value.
checklistsRouter.patch("/:id/items/:itemId", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const itemId = String(req.params.itemId);
    const { row, perms } = await loadAndAuthorize(id, req.user!.id);

    // Decide which fields the caller may set.
    const patch: Record<string, any> = {};
    const wantsValue = req.body.value !== undefined;
    const wantsStructural = ["label", "kind", "required", "sort_order"]
      .some((k) => req.body[k] !== undefined);

    if (wantsStructural && !perms.canEdit) throw new ApiError(403, "Only admins can edit item structure");
    if (wantsValue && !perms.canFill) throw new ApiError(403, "Only the committee chairman or admin can fill values");
    if (wantsValue && row.checklist.status === "approved") throw new ApiError(400, "Approved checklists are frozen");

    if (req.body.label !== undefined)      patch.label = need(trim(req.body.label), "Label");
    if (req.body.kind !== undefined)       patch.kind = pickKind(req.body.kind);
    if (req.body.required !== undefined)   patch.required = !!req.body.required;
    if (req.body.sort_order !== undefined) patch.sort_order = Number(req.body.sort_order);
    if (wantsValue)                        patch.value = trim(req.body.value) || null;

    if (Object.keys(patch).length === 0) throw new ApiError(400, "Nothing to update");

    const [updated] = await db.update(eventChecklistItems)
      .set(patch)
      .where(and(eq(eventChecklistItems.id, itemId), eq(eventChecklistItems.checklist_id, id)))
      .returning();
    if (!updated) throw new ApiError(404, "Item not found");

    // Touch the parent so updated_at advances (fires trigger).
    await db.update(eventChecklists).set({}).where(eq(eventChecklists.id, id));

    res.json(updated);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ DELETE /api/checklists/:id/items/:itemId â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
checklistsRouter.delete("/:id/items/:itemId", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const itemId = String(req.params.itemId);
    const { perms } = await loadAndAuthorize(id, req.user!.id);
    if (!perms.canEdit) throw new ApiError(403, "Only admins can delete items");

    const [row] = await db.delete(eventChecklistItems)
      .where(and(eq(eventChecklistItems.id, itemId), eq(eventChecklistItems.checklist_id, id)))
      .returning();
    if (!row) throw new ApiError(404, "Item not found");
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ POST /api/checklists/:id/submit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Committee chairman (or admin) submits the filled checklist for branch review.
checklistsRouter.post("/:id/submit", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { row, perms } = await loadAndAuthorize(id, req.user!.id);
    if (!perms.canSubmitForReview) throw new ApiError(403, "Forbidden");
    if (row.checklist.status !== "awaiting_committee") throw new ApiError(400, "Checklist is not awaiting committee input");

    // Validate: every required item must have a non-empty value.
    const items = await db.select().from(eventChecklistItems).where(eq(eventChecklistItems.checklist_id, id));
    const missing = items.filter((it) => it.required && (!it.value || !it.value.trim()));
    if (missing.length > 0) {
      throw new ApiError(400, `Fill all required items first (${missing.length} missing: ${missing.slice(0, 3).map((m) => m.label).join(", ")}${missing.length > 3 ? "â€¦" : ""})`);
    }

    const [updated] = await db.update(eventChecklists)
      .set({ status: "awaiting_branch_review" })
      .where(eq(eventChecklists.id, id))
      .returning();
    await db.insert(eventChecklistReviews).values({
      checklist_id: id, actor_id: req.user!.id, action: "submitted_for_review",
      note: trim(req.body.note) || null,
    });
    res.json(updated);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ POST /api/checklists/:id/approve â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Branch chairman approves. DB trigger flips events.status â†’ published.
checklistsRouter.post("/:id/approve", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { row, perms } = await loadAndAuthorize(id, req.user!.id);
    if (!perms.canReview) throw new ApiError(403, "Only branch chairman or admin can approve");
    if (row.checklist.status !== "awaiting_branch_review") throw new ApiError(400, "Checklist is not awaiting branch review");

    const [updated] = await db.update(eventChecklists)
      .set({ status: "approved" })
      .where(eq(eventChecklists.id, id))
      .returning();
    await db.insert(eventChecklistReviews).values({
      checklist_id: id, actor_id: req.user!.id, action: "approved",
      note: trim(req.body.note) || null,
    });
    res.json(updated);
  } catch (err) { handleApiError(err, res, next); }
});

// â”€â”€â”€ POST /api/checklists/:id/reject â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Branch chairman rejects. Goes back to the committee chairman for revisions.
checklistsRouter.post("/:id/reject", async (req: AuthedRequest, res, next) => {
  try {
    const id = String(req.params.id);
    const { row, perms } = await loadAndAuthorize(id, req.user!.id);
    if (!perms.canReview) throw new ApiError(403, "Only branch chairman or admin can reject");
    if (row.checklist.status !== "awaiting_branch_review") throw new ApiError(400, "Checklist is not awaiting branch review");

    const note = need(trim(req.body.note), "Rejection note");

    const [updated] = await db.update(eventChecklists)
      .set({ status: "awaiting_committee" })
      .where(eq(eventChecklists.id, id))
      .returning();
    await db.insert(eventChecklistReviews).values({
      checklist_id: id, actor_id: req.user!.id, action: "rejected", note,
    });
    res.json(updated);
  } catch (err) { handleApiError(err, res, next); }
});
