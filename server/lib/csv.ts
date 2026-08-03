// Shared CSV export helpers.
//
// Every admin CSV export uses the same pattern: quote each cell, escape
// embedded quotes by doubling, join with commas, join rows with \n.
// Values that need special treatment (Date, Array, null / undefined) are
// normalised here so per-endpoint code stays a one-liner.
//
// Usage:
//   const csv = buildCsv(
//     ["User", "Email", "Event", "Status"],
//     rows,
//     (r) => [r.user_name, r.user_email, r.event_title, r.status],
//   );
//   sendCsv(res, "registrations", csv);

import type { Response } from "express";

/**
 * CSV-escape a single cell value.
 *
 * Rules:
 *   • null / undefined            → empty string
 *   • Date                        → ISO string
 *   • Array                       → joined with "; "
 *   • Anything else               → String(value)
 *
 * The result is always wrapped in double quotes and any embedded double
 * quotes are doubled — the everything-is-quoted rule keeps things simple
 * for downstream consumers (Excel is fine with it too).
 */
export function csvCell(value: unknown): string {
  if (value == null) return '""';
  if (value instanceof Date) return `"${value.toISOString()}"`;
  if (Array.isArray(value)) {
    return `"${value.map((v) => (v == null ? "" : String(v))).join("; ").replace(/"/g, '""')}"`;
  }
  const s = typeof value === "string" ? value : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Build a CSV string from a header row and a list of row objects.
 * `mapRow(row)` should return an array of raw values in the same order
 * as the header.
 *
 * Adds a BOM (﻿) so Excel opens the file with correct UTF-8 encoding
 * — the ₹ symbol and Indian names (Devanagari / accented Roman) render
 * without the "junk characters" Excel-on-Windows problem.
 */
export function buildCsv<T>(
  header: string[],
  rows: T[],
  mapRow: (row: T) => unknown[],
): string {
  const lines: string[] = [];
  lines.push(header.map(csvCell).join(","));
  for (const r of rows) {
    lines.push(mapRow(r).map(csvCell).join(","));
  }
  return "﻿" + lines.join("\n");
}

/**
 * Send a CSV response with the right headers to trigger a browser
 * download. `filename` should be without extension — a timestamped
 * `.csv` suffix is appended.
 */
export function sendCsv(res: Response, filename: string, body: string): void {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe  = filename.replace(/[^a-zA-Z0-9_-]+/g, "-");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${safe}-${stamp}.csv"`);
  res.send(body);
}
