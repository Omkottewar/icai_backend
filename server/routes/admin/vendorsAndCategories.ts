// Admin CRUD for the vendor directory + expense category catalogue.
//
// Two thin routers — no complex workflow, just list / create / patch /
// delete. Feeds:
//   • Bill entry autofill (vendor lookup + default category)
//   • Treasurer dashboard "top vendors" and "expense by category" charts
//   • MIS export categorisation
//
// Delete semantics: hard-delete not allowed if the vendor / category has
// ever been referenced by a bill — that would orphan the FK. Instead we
// flip `active=false` so it disappears from dropdowns but historical rows
// keep their reference.

import { Router } from "express";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { vendors, expenseCategories, bills } from "../../../schema/index.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";

export const vendorsAdminRouter = Router();
export const expenseCategoriesAdminRouter = Router();

const KIND_VALUES = new Set(["expense", "income"]);

// ═══════════════════════════════════════════════════════════════════════════
// Vendors
// ═══════════════════════════════════════════════════════════════════════════

vendorsAdminRouter.get("/", async (req, res, next) => {
  try {
    const activeFilter = trim(req.query.active);
    const q = trim(req.query.q).toLowerCase();
    const conds: any[] = [isNull(vendors.deleted_at)];
    if (activeFilter === "true")  conds.push(eq(vendors.active, true));
    if (activeFilter === "false") conds.push(eq(vendors.active, false));

    let rows = await db.select({
      id:               vendors.id,
      name:             vendors.name,
      contact_person:   vendors.contact_person,
      contact_phone:    vendors.contact_phone,
      contact_email:    vendors.contact_email,
      address:          vendors.address,
      gstin:            vendors.gstin,
      pan:              vendors.pan,
      default_category_id: vendors.default_category_id,
      notes:            vendors.notes,
      active:           vendors.active,
      created_at:       vendors.created_at,
    })
      .from(vendors)
      .where(and(...conds))
      .orderBy(asc(vendors.name));

    if (q) {
      rows = rows.filter((r) =>
        r.name.toLowerCase().includes(q) ||
        r.gstin?.toLowerCase().includes(q) ||
        r.pan?.toLowerCase().includes(q)
      );
    }

    // Bill count per vendor — useful for the admin table ("top 3 most used")
    // and to gate deletion.
    const counts = await db.select({
      vendor_id: bills.vendor_id,
      c: sql<number>`count(*)::int`.as("c"),
    }).from(bills).where(isNull(bills.deleted_at)).groupBy(bills.vendor_id);
    const byId = new Map(counts.map((c) => [c.vendor_id, c.c]));

    res.json({
      rows: rows.map((r) => ({ ...r, bill_count: byId.get(r.id) || 0 })),
    });
  } catch (err) { handleApiError(err, res, next); }
});

vendorsAdminRouter.post("/", async (req, res, next) => {
  try {
    const name = need(trim(req.body?.name), "Vendor name");
    const [row] = await db.insert(vendors).values({
      name,
      contact_person: trim(req.body?.contact_person) || null,
      contact_phone:  trim(req.body?.contact_phone) || null,
      contact_email:  trim(req.body?.contact_email) || null,
      address:        trim(req.body?.address) || null,
      gstin:          trim(req.body?.gstin) || null,
      pan:            trim(req.body?.pan) || null,
      default_category_id: trim(req.body?.default_category_id) || null,
      notes:          trim(req.body?.notes) || null,
      active:         req.body?.active !== false,
    }).returning();
    res.status(201).json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

vendorsAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Vendor ID");
    const patch: Record<string, unknown> = { updated_at: new Date() };
    for (const key of ["name", "contact_person", "contact_phone", "contact_email", "address", "gstin", "pan", "notes"] as const) {
      if (req.body?.[key] !== undefined) {
        const v = trim(req.body[key]);
        patch[key] = v || (key === "name" ? undefined : null);
        if (key === "name" && !v) throw new ApiError(400, "Name cannot be empty");
      }
    }
    if ("default_category_id" in (req.body || {})) {
      patch.default_category_id = trim(req.body.default_category_id) || null;
    }
    if (req.body?.active !== undefined) patch.active = !!req.body.active;

    const [row] = await db.update(vendors).set(patch as any)
      .where(and(eq(vendors.id, id), isNull(vendors.deleted_at)))
      .returning();
    if (!row) throw new ApiError(404, "Vendor not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

// Soft-delete only when the vendor has never been used on a bill; otherwise
// force the admin to just flip `active=false` (preserves FK integrity).
vendorsAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Vendor ID");
    const [{ c }] = await db.select({ c: sql<number>`count(*)::int`.as("c") })
      .from(bills)
      .where(and(eq(bills.vendor_id, id), isNull(bills.deleted_at)));
    if (c > 0) {
      throw new ApiError(409, "This vendor has bills against it — deactivate instead of deleting");
    }
    await db.update(vendors).set({ deleted_at: new Date(), active: false, updated_at: new Date() })
      .where(eq(vendors.id, id));
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});

// ═══════════════════════════════════════════════════════════════════════════
// Expense categories
// ═══════════════════════════════════════════════════════════════════════════

expenseCategoriesAdminRouter.get("/", async (_req, res, next) => {
  try {
    const rows = await db.select({
      id: expenseCategories.id,
      code: expenseCategories.code,
      label: expenseCategories.label,
      description: expenseCategories.description,
      kind: expenseCategories.kind,
      sort_order: expenseCategories.sort_order,
      active: expenseCategories.active,
    })
      .from(expenseCategories)
      .orderBy(asc(expenseCategories.sort_order), asc(expenseCategories.label));

    // Bill count per category for the admin table.
    const counts = await db.select({
      category_id: bills.category_id,
      c: sql<number>`count(*)::int`.as("c"),
    }).from(bills).where(isNull(bills.deleted_at)).groupBy(bills.category_id);
    const byId = new Map(counts.map((c) => [c.category_id, c.c]));

    res.json({ rows: rows.map((r) => ({ ...r, bill_count: byId.get(r.id) || 0 })) });
  } catch (err) { handleApiError(err, res, next); }
});

expenseCategoriesAdminRouter.post("/", async (req, res, next) => {
  try {
    const label = need(trim(req.body?.label), "Category label");
    const code = trim(req.body?.code) || label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
    if (!code) throw new ApiError(400, "Category code could not be derived");
    const kind = trim(req.body?.kind) || "expense";
    if (!KIND_VALUES.has(kind)) throw new ApiError(400, "Invalid kind");

    try {
      const [row] = await db.insert(expenseCategories).values({
        code, label, kind,
        description: trim(req.body?.description) || null,
        sort_order: Number(req.body?.sort_order) || 0,
        active: req.body?.active !== false,
      }).returning();
      res.status(201).json({ item: row });
    } catch (err: any) {
      if (err?.code === "23505") throw new ApiError(409, "Category code already exists");
      throw err;
    }
  } catch (err) { handleApiError(err, res, next); }
});

expenseCategoriesAdminRouter.patch("/:id", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Category ID");
    const patch: Record<string, unknown> = { updated_at: new Date() };
    if (req.body?.label !== undefined) {
      const v = trim(req.body.label);
      if (!v) throw new ApiError(400, "Label cannot be empty");
      patch.label = v;
    }
    if (req.body?.description !== undefined) patch.description = trim(req.body.description) || null;
    if (req.body?.kind !== undefined) {
      const v = trim(req.body.kind);
      if (!KIND_VALUES.has(v)) throw new ApiError(400, "Invalid kind");
      patch.kind = v;
    }
    if (req.body?.sort_order !== undefined) patch.sort_order = Number(req.body.sort_order) || 0;
    if (req.body?.active !== undefined) patch.active = !!req.body.active;

    const [row] = await db.update(expenseCategories).set(patch as any)
      .where(eq(expenseCategories.id, id))
      .returning();
    if (!row) throw new ApiError(404, "Category not found");
    res.json({ item: row });
  } catch (err) { handleApiError(err, res, next); }
});

expenseCategoriesAdminRouter.delete("/:id", async (req, res, next) => {
  try {
    const id = need(trim(req.params.id), "Category ID");
    const [{ c }] = await db.select({ c: sql<number>`count(*)::int`.as("c") })
      .from(bills)
      .where(and(eq(bills.category_id, id), isNull(bills.deleted_at)));
    if (c > 0) throw new ApiError(409, "This category has bills against it — deactivate instead of deleting");
    await db.delete(expenseCategories).where(eq(expenseCategories.id, id));
    res.json({ ok: true });
  } catch (err) { handleApiError(err, res, next); }
});
