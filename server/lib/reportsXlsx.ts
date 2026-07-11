// Shared XLSX builder for the admin Reports router.
//
// Design goals:
//   • Every report has the same visual shell — logo-tinted title bar,
//     filter context sub-header, styled column headers with a frozen pane,
//     zebra-striped body, right-aligned money/number columns, and a
//     totals row where numeric columns are summed.
//   • Column definitions are declarative so a new report is 30 lines of
//     query + config, not 300 lines of exceljs boilerplate.
//   • Currency amounts are stored in paise everywhere; renderCurrency
//     converts to rupees with the Indian grouping (##,##,###) formatted
//     via Excel's own numFmt so the file behaves correctly if the branch
//     opens it in Excel/Numbers/Google Sheets.
//
// Column kinds:
//   text     — left-aligned string (or "—" for null)
//   number   — right-aligned integer
//   currency — paise → rupees with ₹ prefix, right-aligned; summed in
//              the totals row
//   date     — yyyy-mm-dd, right-aligned; skipped in totals
//   datetime — dd MMM yyyy, HH:mm (IST), right-aligned
//   percent  — 0-1 fraction rendered as %; summed as average in totals

import ExcelJS from "exceljs";
import type { Response } from "express";

export type ReportColumnKind = "text" | "number" | "currency" | "date" | "datetime" | "percent";

export interface ReportColumn<Row> {
  header: string;
  key: keyof Row & string;
  kind: ReportColumnKind;
  width?: number;
  /** Skip this column in the totals footer even if it's numeric. */
  skipTotal?: boolean;
}

export interface ReportSpec<Row> {
  /** Filename without extension. */
  filename: string;
  /** Big title at the top of the sheet. */
  title: string;
  /** Filter breadcrumb (e.g. "FY 2026–27 · Committee: CPE"). Optional. */
  subtitle?: string;
  /** Column definitions in render order. */
  columns: Array<ReportColumn<Row>>;
  rows: Row[];
  /** Optional sheet name (default: "Report"). Excel caps at 31 chars. */
  sheetName?: string;
  /** Show a totals row at the bottom summing currency/number columns. */
  showTotals?: boolean;
}

const IST_DATETIME = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "2-digit", month: "short", year: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
const IST_DATE = new Intl.DateTimeFormat("en-IN", {
  timeZone: "Asia/Kolkata",
  day: "2-digit", month: "short", year: "numeric",
});

// Indian rupee format with thousand grouping and 2 decimals — Excel numFmt.
const INR_FMT = '_-"₹" * #,##,##0.00_-;_-"₹" * -#,##,##0.00_-;_-"₹" * "-"??_-;_-@_-';

/**
 * Stream a formatted XLSX to `res`. Sets Content-Type + Content-Disposition
 * and finalises the workbook — the caller must NOT touch `res` afterwards.
 */
export async function sendReport<Row extends Record<string, unknown>>(
  res: Response,
  spec: ReportSpec<Row>,
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "ICAI Nagpur Branch Portal";
  wb.created = new Date();

  const ws = wb.addWorksheet((spec.sheetName ?? "Report").slice(0, 31), {
    views: [{ state: "frozen", ySplit: spec.subtitle ? 4 : 3 }],
  });

  const colCount = spec.columns.length;
  const lastCol = String.fromCharCode(64 + colCount);  // A-Z is enough for our report widths

  // ── Title row ──────────────────────────────────────────────────────────
  ws.mergeCells(`A1:${lastCol}1`);
  const titleCell = ws.getCell("A1");
  titleCell.value = spec.title;
  titleCell.font = { name: "Calibri", size: 16, bold: true, color: { argb: "FFFFFFFF" } };
  titleCell.alignment = { horizontal: "left", vertical: "middle", indent: 1 };
  titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0B3D91" } }; // ICAI navy
  ws.getRow(1).height = 28;

  // ── Subtitle (filter breadcrumb) ───────────────────────────────────────
  let headerRowIndex = 2;
  if (spec.subtitle) {
    ws.mergeCells(`A2:${lastCol}2`);
    const sub = ws.getCell("A2");
    sub.value = spec.subtitle;
    sub.font = { name: "Calibri", size: 10, italic: true, color: { argb: "FFCBD5E1" } };
    sub.alignment = { horizontal: "left", vertical: "middle", indent: 1 };
    sub.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A6B" } };
    ws.getRow(2).height = 18;
    headerRowIndex = 3;
  }

  // ── Generated-at line, in muted grey above the header ──────────────────
  ws.mergeCells(`A${headerRowIndex}:${lastCol}${headerRowIndex}`);
  const stamp = ws.getCell(`A${headerRowIndex}`);
  stamp.value = `Generated ${IST_DATETIME.format(new Date())} IST · ${spec.rows.length} row${spec.rows.length === 1 ? "" : "s"}`;
  stamp.font = { name: "Calibri", size: 9, color: { argb: "FF64748B" } };
  stamp.alignment = { horizontal: "right", vertical: "middle", indent: 1 };
  ws.getRow(headerRowIndex).height = 16;
  headerRowIndex += 1;

  // ── Column headers ─────────────────────────────────────────────────────
  const headerRow = ws.getRow(headerRowIndex);
  spec.columns.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = col.header;
    cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF334155" } }; // slate-700
    cell.alignment = {
      horizontal: col.kind === "text" ? "left" : "right",
      vertical: "middle",
      wrapText: true,
    };
    cell.border = {
      top:    { style: "thin", color: { argb: "FF1E293B" } },
      bottom: { style: "thin", color: { argb: "FF1E293B" } },
      left:   { style: "thin", color: { argb: "FF1E293B" } },
      right:  { style: "thin", color: { argb: "FF1E293B" } },
    };
  });
  headerRow.height = 22;

  // Column widths + number formats.
  spec.columns.forEach((col, i) => {
    const c = ws.getColumn(i + 1);
    c.width = col.width ?? defaultWidth(col.kind);
    if (col.kind === "currency") c.numFmt = INR_FMT;
    if (col.kind === "number")   c.numFmt = '#,##,##0';
    if (col.kind === "percent")  c.numFmt = '0.0%';
  });

  // ── Body rows ──────────────────────────────────────────────────────────
  spec.rows.forEach((row, r) => {
    const excelRow = ws.getRow(headerRowIndex + 1 + r);
    spec.columns.forEach((col, i) => {
      const cell = excelRow.getCell(i + 1);
      cell.value = formatValue(row[col.key], col.kind);
      cell.alignment = { horizontal: col.kind === "text" ? "left" : "right", vertical: "middle" };
      // Zebra stripes for legibility on long dumps.
      if (r % 2 === 1) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF8FAFC" } };
      }
      cell.border = {
        top:    { style: "hair", color: { argb: "FFE2E8F0" } },
        bottom: { style: "hair", color: { argb: "FFE2E8F0" } },
      };
    });
  });

  // ── Totals row ─────────────────────────────────────────────────────────
  if (spec.showTotals && spec.rows.length > 0) {
    const totalsRow = ws.getRow(headerRowIndex + 1 + spec.rows.length);
    spec.columns.forEach((col, i) => {
      const cell = totalsRow.getCell(i + 1);
      if (i === 0) {
        cell.value = "TOTAL";
      } else if (!col.skipTotal && (col.kind === "currency" || col.kind === "number")) {
        // Sum the raw underlying values (paise or integers) so the totals
        // arithmetic is exact and Excel just formats what we hand it.
        let total = 0;
        for (const row of spec.rows) {
          const raw = row[col.key];
          if (typeof raw === "number" && Number.isFinite(raw)) total += raw;
          else if (typeof raw === "string" && raw && !Number.isNaN(Number(raw))) total += Number(raw);
        }
        cell.value = col.kind === "currency" ? total / 100 : total;
      } else {
        cell.value = "";
      }
      cell.font = { name: "Calibri", size: 11, bold: true };
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE2E8F0" } };
      cell.alignment = { horizontal: col.kind === "text" ? "left" : "right", vertical: "middle" };
      cell.border = {
        top: { style: "medium", color: { argb: "FF334155" } },
      };
    });
    totalsRow.height = 22;
  }

  // ── Auto-filter over the header + body (excluding title/subtitle/totals)
  ws.autoFilter = {
    from: { row: headerRowIndex, column: 1 },
    to:   { row: headerRowIndex + spec.rows.length, column: colCount },
  };

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${spec.filename}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}

function defaultWidth(kind: ReportColumnKind): number {
  switch (kind) {
    case "currency": return 16;
    case "date":     return 14;
    case "datetime": return 20;
    case "percent":  return 12;
    case "number":   return 10;
    default:         return 22;
  }
}

function formatValue(raw: unknown, kind: ReportColumnKind): string | number | Date | null {
  if (raw === null || raw === undefined || raw === "") return kind === "text" ? "—" : null;

  switch (kind) {
    case "currency": {
      const paise = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(paise)) return null;
      return paise / 100;
    }
    case "number": {
      const n = typeof raw === "number" ? raw : Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case "date": {
      const d = raw instanceof Date ? raw : new Date(raw as string);
      if (Number.isNaN(d.getTime())) return null;
      return IST_DATE.format(d);
    }
    case "datetime": {
      const d = raw instanceof Date ? raw : new Date(raw as string);
      if (Number.isNaN(d.getTime())) return null;
      return IST_DATETIME.format(d);
    }
    case "percent": {
      const n = typeof raw === "number" ? raw : Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    default:
      return String(raw);
  }
}
