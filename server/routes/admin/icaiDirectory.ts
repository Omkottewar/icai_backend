// Admin: ICAI directory import + status.
//
// Endpoints:
//   GET    /api/admin/icai-directory          → status (count, last import time, flag state)
//   POST   /api/admin/icai-directory/import   → upload an xlsx, upsert rows
//   POST   /api/admin/icai-directory/flag     → toggle signup.mrn_gating_enabled
//   DELETE /api/admin/icai-directory          → wipe the table (with a confirmation token)
//
// Expected column headers in the xlsx (case-insensitive, flexible):
//   MRN | Membership No | Membership Number | ICAI Membership No  → mrn
//   Name | Full Name | Member Name                                → name
//   Email | Email ID | Email Address                              → email
//   Phone | Mobile | Mobile Number | Mobile No | Contact          → phone
//   City | Location                                                → city
//   Firm | Firm Name | Firm/Organization | Organization            → firm_name
//   FCA | FCA Flag | FCA/ACA                                       → fca_flag  (truthy if "Y"/"yes"/"FCA"/true)
//   COP | COP Status                                               → cop_status
//
// Anything else in the row (gender, address, photo, DOB, etc.) is preserved
// in the `raw` jsonb column for later mining, so nothing is lost.

import { Router } from "express";
import { sql } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "../../../db/client.js";
import { icaiMemberMaster, siteSettings } from "../../../schema/index.js";
import { ApiError, handleApiError, trim } from "../../lib/apiError.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";

export const icaiDirectoryAdminRouter = Router();

const HEADER_MAP: Record<string, string> = {
  mrn: "mrn",
  membership_no: "mrn",
  membership_number: "mrn",
  membership: "mrn",
  // Google Form export style — "ICAI Membership No" (and the variant
  // without "No"). Common enough that we want it to work out of the box.
  icai_membership_no:     "mrn",
  icai_membership_number: "mrn",
  icai_membership:        "mrn",
  name: "name",
  full_name: "name",
  member_name: "name",
  email: "email",
  email_id: "email",
  email_address: "email",
  phone: "phone",
  mobile: "phone",
  mobile_no:     "phone",   // "Mobile No"
  mobile_number: "phone",   // "Mobile Number" — Google Form default
  contact: "phone",
  contact_no: "phone",
  city: "city",
  location: "city",
  firm: "firm_name",
  firm_name: "firm_name",
  // The Google Form labels this column "Firm / Organization" — normalises to
  // `firm_organization`. Treat the bare "Organization" the same way.
  firm_organization: "firm_name",
  organization:      "firm_name",
  fca: "fca_flag",
  fca_flag: "fca_flag",
  fca_aca: "fca_flag",
  cop: "cop_status",
  cop_status: "cop_status",
};

function normHeader(h: string): string {
  return h
    .toString()
    .toLowerCase()
    .trim()
    .replace(/[\s\-./]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function pickFcaFlag(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v ?? "").trim().toLowerCase();
  return s === "y" || s === "yes" || s === "fca" || s === "true" || s === "1";
}

// ─── GET /api/admin/icai-directory ───────────────────────────────────────────
icaiDirectoryAdminRouter.get("/", async (_req, res, next) => {
  try {
    const [{ count }] = await db.execute<{ count: string }>(sql`
      SELECT COUNT(*)::text AS count FROM icai_member_master
    `) as unknown as Array<{ count: string }>;

    const [{ last_imported, source_file }] = (await db.execute(sql`
      SELECT MAX(imported_at) AS last_imported,
             MAX(source_file) FILTER (WHERE imported_at = (SELECT MAX(imported_at) FROM icai_member_master)) AS source_file
      FROM icai_member_master
    `)) as unknown as Array<{ last_imported: string | null; source_file: string | null }>;

    const [flag] = await db
      .select()
      .from(siteSettings)
      .where(sql`${siteSettings.key} = 'signup.mrn_gating_enabled'`)
      .limit(1);

    res.json({
      total: Number(count ?? 0),
      last_imported,
      source_file,
      gating_enabled: flag?.value === "true",
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/icai-directory/import ───────────────────────────────────
// Body: { filename, data_base64 }  — same shape as /api/admin/files
icaiDirectoryAdminRouter.post("/import", async (req: AuthedRequest, res, next) => {
  try {
    const filename = trim(req.body?.filename) || "icai_directory.xlsx";
    const dataB64: string = typeof req.body?.data_base64 === "string" ? req.body.data_base64 : "";
    if (!dataB64) throw new ApiError(400, "File data is required");

    const stripped = dataB64.replace(/^data:[^;]+;base64,/, "");
    const buf = Buffer.from(stripped, "base64");
    if (buf.length === 0) throw new ApiError(400, "File data is empty or invalid base64");
    if (buf.length > 25 * 1024 * 1024) throw new ApiError(400, "File exceeds 25 MB limit");

    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(buf, { type: "buffer" });
    } catch {
      throw new ApiError(400, "Could not parse the file. Expected an .xlsx / .csv workbook.");
    }

    const sheetName = workbook.SheetNames[0];
    if (!sheetName) throw new ApiError(400, "Workbook has no sheets");
    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null });

    if (rows.length === 0) throw new ApiError(400, "Sheet is empty");

    // Build header → canonical field mapping from the actual first row's keys.
    const sampleKeys = Object.keys(rows[0]);
    const colMap: Record<string, string> = {};
    for (const raw of sampleKeys) {
      const norm = normHeader(raw);
      const canon = HEADER_MAP[norm];
      if (canon) colMap[raw] = canon;
    }
    if (!Object.values(colMap).includes("mrn") || !Object.values(colMap).includes("name")) {
      // Surface what we actually saw so the admin can spot a mismatch
      // (header on the wrong row, weird stray characters, etc.) instead
      // of guessing why the import was rejected.
      const found = sampleKeys.map((k) => `"${k}" → ${normHeader(k)}`).join(", ");
      throw new ApiError(400,
        "Spreadsheet must include at least an MRN column and a Name column. " +
        `Detected headers: ${found || "(none)"}.`,
      );
    }

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Process in chunks to keep the transaction small.
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const payload = slice.flatMap((raw) => {
        const out: Record<string, unknown> = {};
        for (const [src, dst] of Object.entries(colMap)) {
          out[dst] = raw[src];
        }
        const mrn = String(out.mrn ?? "").trim();
        const name = String(out.name ?? "").trim();
        if (!mrn || !name) {
          skipped++;
          return [];
        }
        return [{
          mrn,
          name,
          email:       out.email ? String(out.email).trim().toLowerCase() : null,
          phone:       out.phone ? String(out.phone).trim() : null,
          city:        out.city ? String(out.city).trim() : null,
          firm_name:   out.firm_name ? String(out.firm_name).trim() : null,
          fca_flag:    pickFcaFlag(out.fca_flag),
          cop_status:  out.cop_status ? String(out.cop_status).trim() : null,
          source_file: filename,
          raw,
        }];
      });

      if (payload.length === 0) continue;
      try {
        await db
          .insert(icaiMemberMaster)
          .values(payload as any)
          .onConflictDoUpdate({
            target: icaiMemberMaster.mrn,
            set: {
              name:        sql`EXCLUDED.name`,
              email:       sql`EXCLUDED.email`,
              phone:       sql`EXCLUDED.phone`,
              city:        sql`EXCLUDED.city`,
              firm_name:   sql`EXCLUDED.firm_name`,
              fca_flag:    sql`EXCLUDED.fca_flag`,
              cop_status:  sql`EXCLUDED.cop_status`,
              imported_at: sql`now()`,
              source_file: sql`EXCLUDED.source_file`,
              raw:         sql`EXCLUDED.raw`,
            },
          });
        imported += payload.length;
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    res.json({ imported, skipped, errors });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /api/admin/icai-directory/flag ─────────────────────────────────────
// Toggle the signup gating feature flag.
icaiDirectoryAdminRouter.post("/flag", async (req, res, next) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    await db
      .insert(siteSettings)
      .values({ key: "signup.mrn_gating_enabled", value: enabled ? "true" : "false" })
      .onConflictDoUpdate({
        target: siteSettings.key,
        set: { value: enabled ? "true" : "false", updated_at: new Date() },
      });
    res.json({ ok: true, enabled });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── DELETE /api/admin/icai-directory ────────────────────────────────────────
icaiDirectoryAdminRouter.delete("/", async (req, res, next) => {
  try {
    if (req.body?.confirm !== "wipe-icai-directory") {
      throw new ApiError(400, "Pass { confirm: 'wipe-icai-directory' } to confirm.");
    }
    const result = await db.execute(sql`DELETE FROM icai_member_master`);
    res.json({ ok: true, deleted: (result as any).rowCount ?? null });
  } catch (err) { handleApiError(err, res, next); }
});
