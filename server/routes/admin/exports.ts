import { Router } from "express";
import { parseFyRange, streamFyCsv } from "../../lib/fyExport.js";
import { handleApiError } from "../../lib/apiError.js";

export const exportsAdminRouter = Router();

// ─── GET /api/admin/exports/fy.csv?fy=2026-27 ─────────────────────────────
// Streaming consolidated CSV for one FY. Routed under /admin so the existing
// requireAdmin gate covers it. In a follow-up we'll narrow this to treasurer
// + chairman + admin only once we have a `requireRole` middleware variant.
exportsAdminRouter.get("/fy.csv", async (req, res, next) => {
  try {
    const label = String(req.query.fy ?? "").trim() || defaultFyLabel();
    const { start, end, normalised } = parseFyRange(label);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="icai-nagpur-fy-${normalised}.csv"`,
    );
    res.setHeader("Cache-Control", "no-store");

    await streamFyCsv(res, start, end, normalised);
  } catch (err) { handleApiError(err, res, next); }
});

function defaultFyLabel(): string {
  // Match the existing FY logic in lib/fy.ts — Apr 1 boundary
  const now = new Date();
  const month = now.getUTCMonth();
  const year = now.getUTCFullYear();
  const startYear = month >= 3 ? year : year - 1;
  return `${startYear}-${String(startYear + 1).slice(-2)}`;
}
