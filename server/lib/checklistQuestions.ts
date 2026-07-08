/**
 * Question-type registry for the generic checklist engine.
 *
 * Each type declares:
 *   • what its config object may contain (validated at template-edit time)
 *   • how a response value is shaped + validated (at submit time)
 *
 * Keep this file the single source of truth — both routes and the frontend
 * builder should derive their UI/limits from QUESTION_TYPES below.
 */

import { ApiError } from "./apiError.js";

export type QuestionType =
  | "short_text" | "long_text"
  | "number" | "money"
  | "date" | "datetime" | "time_range"
  | "radio" | "dropdown" | "yes_no" | "checkbox"
  | "rating" | "file" | "section_heading"
  | "task_list" | "budget_table" | "checklist_table";

export const QUESTION_TYPES = [
  "short_text", "long_text",
  "number", "money",
  "date", "datetime", "time_range",
  "radio", "dropdown", "yes_no", "checkbox",
  "rating", "file", "section_heading",
  "task_list", "budget_table", "checklist_table",
] as const;

// ─── checklist_table shapes ─────────────────────────────────────────────
// Template-time config:
//   columns[]  — array of { key, label, type }
//                 type ∈ 'text' | 'number' | 'money' | 'status'
//   rows[]     — array of { id, label, kind?, hint?, total_of?, formula? }
//                 kind ∈ 'data' | 'total' | 'computed' (default 'data')
//                 hint     — shown as placeholder / greyed cell prefill
//                 total_of — key of the column to auto-sum when kind='total'
//                 formula  — javascript-ish string (rowA - rowB) when kind='computed'
//
// Response value (persisted): { [rowId]: { [colKey]: string|number } }.
// Only 'data' rows carry response values; 'total' / 'computed' rows are
// derived client-side and re-derived on read.
export type ChecklistTableColumnType = "text" | "number" | "money" | "status";
export type ChecklistTableColumn = {
  key: string;
  label: string;
  type: ChecklistTableColumnType;
};
export type ChecklistTableRowKind = "data" | "total" | "computed";
export type ChecklistTableRow = {
  id: string;
  label: string;
  kind?: ChecklistTableRowKind;
  hint?: string;
  total_of?: string;
  formula?: string;
};

// A single task row inside a task_list response. The shape is denormalised
// from the dedicated checklist_task_assignments table so the response
// blob stays self-contained for the frontend.
export type TaskItem = {
  // Stable client-generated id used to match rows across saves; the
  // backend echoes it back. NOT the DB id.
  cid?: string;
  description: string;
  assignee_id?: string | null;
  due_date?: string | null;     // 'YYYY-MM-DD'
  status?: "pending" | "done" | "cancelled";
  notes?: string | null;
};

export function isQuestionType(v: unknown): v is QuestionType {
  return typeof v === "string" && (QUESTION_TYPES as readonly string[]).includes(v);
}

/**
 * Normalise + validate the per-type config blob. Throws ApiError on bad input.
 * The returned object is what's persisted in `config` jsonb.
 */
export function normaliseConfig(type: QuestionType, raw: any): Record<string, unknown> {
  const cfg = (raw && typeof raw === "object" && !Array.isArray(raw)) ? raw : {};

  switch (type) {
    case "short_text":
    case "long_text": {
      const out: Record<string, unknown> = {};
      if (typeof cfg.placeholder === "string") out.placeholder = String(cfg.placeholder).slice(0, 200);
      if (Number.isFinite(Number(cfg.max_length))) out.max_length = clampInt(Number(cfg.max_length), 1, 10_000);
      if (Number.isFinite(Number(cfg.min_length))) out.min_length = clampInt(Number(cfg.min_length), 0, 10_000);
      return out;
    }
    case "number": {
      const out: Record<string, unknown> = {};
      if (Number.isFinite(Number(cfg.min)))  out.min  = Number(cfg.min);
      if (Number.isFinite(Number(cfg.max)))  out.max  = Number(cfg.max);
      if (Number.isFinite(Number(cfg.step))) out.step = Number(cfg.step);
      if (typeof cfg.unit === "string") out.unit = String(cfg.unit).slice(0, 30);
      return out;
    }
    case "money": {
      const out: Record<string, unknown> = { currency: "INR" };
      if (Number.isFinite(Number(cfg.min_paise))) out.min_paise = clampInt(Number(cfg.min_paise), 0, 1e12);
      if (Number.isFinite(Number(cfg.max_paise))) out.max_paise = clampInt(Number(cfg.max_paise), 0, 1e12);
      return out;
    }
    case "date":
    case "datetime": {
      const out: Record<string, unknown> = {};
      if (typeof cfg.min === "string") out.min = cfg.min;
      if (typeof cfg.max === "string") out.max = cfg.max;
      return out;
    }
    case "radio":
    case "dropdown":
    case "checkbox": {
      const options = Array.isArray(cfg.options) ? cfg.options : [];
      const cleaned = options
        .map((o: any, i: number) => ({
          value: String(o?.value ?? o?.label ?? `opt_${i + 1}`).slice(0, 100),
          label: String(o?.label ?? o?.value ?? `Option ${i + 1}`).slice(0, 200),
        }))
        .filter((o: any) => o.label.trim().length > 0);
      if (cleaned.length < 2) {
        throw new ApiError(400, `${type} questions need at least 2 options`);
      }
      // Ensure unique values
      const seen = new Set<string>();
      for (const o of cleaned) {
        if (seen.has(o.value)) throw new ApiError(400, `Duplicate option value: ${o.value}`);
        seen.add(o.value);
      }
      const out: Record<string, unknown> = { options: cleaned };
      if (type === "checkbox") {
        if (Number.isFinite(Number(cfg.min_selected))) out.min_selected = clampInt(Number(cfg.min_selected), 0, cleaned.length);
        if (Number.isFinite(Number(cfg.max_selected))) out.max_selected = clampInt(Number(cfg.max_selected), 1, cleaned.length);
      }
      return out;
    }
    case "yes_no":
      return {};
    case "rating": {
      const out: Record<string, unknown> = { scale: 5 };
      if (Number.isFinite(Number(cfg.scale))) out.scale = clampInt(Number(cfg.scale), 2, 10);
      return out;
    }
    case "file": {
      const out: Record<string, unknown> = { max_size_kb: 5 * 1024 };
      if (Number.isFinite(Number(cfg.max_size_kb))) out.max_size_kb = clampInt(Number(cfg.max_size_kb), 1, 50 * 1024);
      if (Array.isArray(cfg.accept)) {
        out.accept = cfg.accept
          .filter((s: any) => typeof s === "string")
          .map((s: string) => s.trim().toLowerCase())
          .filter((s: string) => s.length > 0)
          .slice(0, 20);
      }
      return out;
    }
    case "section_heading":
      return {};
    case "time_range":
      // No template-time knobs today. Could later allow min/max bounds.
      return {};
    case "budget_table": {
      // Template-time knobs:
      //   faculty_count — default rows for the per-faculty categories
      //                   (Stay / Travel / Food / Cab). The treasurer can
      //                   leave unused rows at 0; the renderer hides
      //                   computed sub-rows beyond this number.
      const out: Record<string, unknown> = {};
      const fc = Number(cfg.faculty_count);
      out.faculty_count = Number.isFinite(fc) ? clampInt(fc, 1, 20) : 6;
      return out;
    }
    case "task_list": {
      // Optional defaults the builder may set on the template:
      //   min_tasks  — refuse to submit with fewer rows
      //   default_due_days — pre-fill new tasks' due date as event start - N days
      const out: Record<string, unknown> = {};
      if (Number.isFinite(Number(cfg.min_tasks))) out.min_tasks = clampInt(Number(cfg.min_tasks), 0, 50);
      if (Number.isFinite(Number(cfg.default_due_days))) out.default_due_days = clampInt(Number(cfg.default_due_days), 0, 365);
      return out;
    }
    case "checklist_table": {
      // Validate/normalise the fixed-row Excel-style table shape. Both
      // columns and rows are required — a table with none of either isn't
      // useful. Column keys and row ids must be unique so the response
      // blob can be dictionary-keyed without collisions.
      const rawCols = Array.isArray(cfg.columns) ? cfg.columns : [];
      const rawRows = Array.isArray(cfg.rows) ? cfg.rows : [];
      const validColTypes = new Set<ChecklistTableColumnType>([
        "text", "number", "money", "status",
      ]);
      const validRowKinds = new Set<ChecklistTableRowKind>([
        "data", "total", "computed",
      ]);

      const seenColKeys = new Set<string>();
      const columns: ChecklistTableColumn[] = rawCols
        .map((c: any, i: number) => {
          const key = String(c?.key ?? `col_${i + 1}`).slice(0, 50);
          const label = String(c?.label ?? key).slice(0, 200);
          const type = validColTypes.has(c?.type) ? c.type : "text";
          return { key, label, type };
        })
        .filter((c: ChecklistTableColumn) => {
          if (seenColKeys.has(c.key)) return false;
          seenColKeys.add(c.key);
          return c.key.length > 0;
        });

      if (columns.length < 1) {
        throw new ApiError(400, "checklist_table needs at least one column");
      }

      const seenRowIds = new Set<string>();
      const rows: ChecklistTableRow[] = rawRows
        .map((r: any, i: number) => {
          const id = String(r?.id ?? `row_${i + 1}`).slice(0, 50);
          const label = String(r?.label ?? id).slice(0, 300);
          const kind = validRowKinds.has(r?.kind) ? r.kind : "data";
          const out: ChecklistTableRow = { id, label, kind };
          if (typeof r?.hint === "string") out.hint = String(r.hint).slice(0, 200);
          if (kind === "total" && typeof r?.total_of === "string") {
            out.total_of = String(r.total_of).slice(0, 50);
          }
          if (kind === "computed" && typeof r?.formula === "string") {
            out.formula = String(r.formula).slice(0, 500);
          }
          return out;
        })
        .filter((r: ChecklistTableRow) => {
          if (seenRowIds.has(r.id)) return false;
          seenRowIds.add(r.id);
          return r.id.length > 0;
        });

      if (rows.length < 1) {
        throw new ApiError(400, "checklist_table needs at least one row");
      }

      return { columns, rows };
    }
  }
}

/**
 * Validate a response value for a given question. Returns the cleaned value
 * (what we persist in jsonb) or throws ApiError. `null` means "left blank".
 */
export function validateResponseValue(
  type: QuestionType,
  required: boolean,
  config: any,
  raw: unknown,
): unknown {
  // section_heading has no value
  if (type === "section_heading") return null;

  const isBlank = raw === null || raw === undefined
    || (typeof raw === "string" && raw.trim() === "")
    || (Array.isArray(raw) && raw.length === 0);

  if (isBlank) {
    if (required) throw new ApiError(400, "Required");
    return null;
  }

  const cfg = (config && typeof config === "object") ? config : {};

  switch (type) {
    case "short_text":
    case "long_text": {
      const s = String(raw);
      if (cfg.min_length && s.length < cfg.min_length) throw new ApiError(400, `Must be at least ${cfg.min_length} characters`);
      if (cfg.max_length && s.length > cfg.max_length) throw new ApiError(400, `Must be at most ${cfg.max_length} characters`);
      return s;
    }
    case "number": {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new ApiError(400, "Must be a number");
      if (cfg.min !== undefined && n < cfg.min) throw new ApiError(400, `Must be ≥ ${cfg.min}`);
      if (cfg.max !== undefined && n > cfg.max) throw new ApiError(400, `Must be ≤ ${cfg.max}`);
      return n;
    }
    case "money": {
      const n = Math.round(Number(raw));
      if (!Number.isFinite(n) || n < 0) throw new ApiError(400, "Must be a non-negative amount (paise)");
      if (cfg.min_paise !== undefined && n < cfg.min_paise) throw new ApiError(400, `Must be ≥ ${cfg.min_paise} paise`);
      if (cfg.max_paise !== undefined && n > cfg.max_paise) throw new ApiError(400, `Must be ≤ ${cfg.max_paise} paise`);
      return n;
    }
    case "date":
    case "datetime": {
      const s = String(raw);
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) throw new ApiError(400, "Invalid date");
      return s;
    }
    case "radio":
    case "dropdown": {
      const s = String(raw);
      const values = (cfg.options ?? []).map((o: any) => o.value);
      if (!values.includes(s)) throw new ApiError(400, "Choose one of the listed options");
      return s;
    }
    case "yes_no": {
      if (raw === true || raw === "yes" || raw === "true") return "yes";
      if (raw === false || raw === "no" || raw === "false") return "no";
      throw new ApiError(400, "Answer yes or no");
    }
    case "checkbox": {
      const arr = Array.isArray(raw) ? raw.map(String) : [String(raw)];
      const values = new Set((cfg.options ?? []).map((o: any) => String(o.value)));
      for (const v of arr) {
        if (!values.has(v)) throw new ApiError(400, "Pick from the listed options");
      }
      const uniq = Array.from(new Set(arr));
      if (cfg.min_selected && uniq.length < cfg.min_selected) throw new ApiError(400, `Pick at least ${cfg.min_selected}`);
      if (cfg.max_selected && uniq.length > cfg.max_selected) throw new ApiError(400, `Pick at most ${cfg.max_selected}`);
      return uniq;
    }
    case "rating": {
      const n = Math.round(Number(raw));
      const scale = Number(cfg.scale ?? 5);
      if (!Number.isFinite(n) || n < 1 || n > scale) throw new ApiError(400, `Rate between 1 and ${scale}`);
      return n;
    }
    case "file": {
      // Files come through as { file_id, name, size_kb } — we trust the upload
      // pipeline to have produced these; this layer only sanity-checks shape.
      if (typeof raw !== "object" || !raw || !("file_id" in raw)) throw new ApiError(400, "Upload a file");
      return raw;
    }
    case "time_range": {
      // Expect { start: 'HH:MM', end: 'HH:MM' }. Both required when present.
      if (typeof raw !== "object" || raw === null) throw new ApiError(400, "Pick start and end times");
      const r = raw as Record<string, unknown>;
      const tre = /^([01]\d|2[0-3]):[0-5]\d$/;
      const start = typeof r.start === "string" ? r.start : "";
      const end   = typeof r.end   === "string" ? r.end   : "";
      if (!tre.test(start) || !tre.test(end)) throw new ApiError(400, "Times must be in 24-hour HH:MM format");
      if (start >= end) throw new ApiError(400, "End time must be after start time");
      return { start, end };
    }
    case "budget_table": {
      // Shape: a big JSON blob with revenue + expenses by category. We
      // sanity-check the shape (object, expected keys) and coerce all
      // amounts to non-negative integers (paise). The actual category list
      // is fixed client-side; we don't gate on which categories appear so
      // future additions don't require backend changes.
      if (typeof raw !== "object" || raw === null) throw new ApiError(400, "Budget must be an object");
      const b = raw as Record<string, any>;
      const facultyCount = Number(cfg.faculty_count) || 6;

      // Coerce per-faculty number arrays
      const numArr = (v: unknown): number[] => {
        if (!Array.isArray(v)) return [];
        return v.slice(0, facultyCount).map((x) => {
          const n = Math.round(Number(x));
          return Number.isFinite(n) && n >= 0 ? n : 0;
        });
      };
      // Coerce travel array (each row is { to, from })
      const travelArr = (v: unknown) => {
        if (!Array.isArray(v)) return [];
        return v.slice(0, facultyCount).map((x) => {
          const r = (x && typeof x === "object") ? x : {};
          const to   = Math.round(Number((r as any).to))   || 0;
          const from = Math.round(Number((r as any).from)) || 0;
          return { to: Math.max(0, to), from: Math.max(0, from) };
        });
      };
      // Coerce {label, amount_paise} addable-row arrays
      const labeledArr = (v: unknown) => {
        if (!Array.isArray(v)) return [];
        return v.map((x) => {
          const r = (x && typeof x === "object") ? x : {};
          return {
            label: typeof (r as any).label === "string" ? (r as any).label.slice(0, 200) : "",
            amount_paise: Math.max(0, Math.round(Number((r as any).amount_paise)) || 0),
          };
        }).slice(0, 50);  // cap row count
      };
      const single = (v: unknown) => Math.max(0, Math.round(Number(v)) || 0);

      const revenue = (b.revenue && typeof b.revenue === "object") ? b.revenue : {};
      const expenses = (b.expenses && typeof b.expenses === "object") ? b.expenses : {};
      const facultyNames = Array.isArray(b.faculty_names)
        ? b.faculty_names.slice(0, facultyCount).map((s: unknown) => typeof s === "string" ? s.slice(0, 100) : "")
        : [];

      return {
        faculty_names: facultyNames,
        revenue: {
          participation: {
            participants: Math.max(0, Math.round(Number((revenue.participation || {}).participants)) || 0),
            fee_paise:    Math.max(0, Math.round(Number((revenue.participation || {}).fee_paise))    || 0),
          },
          other: labeledArr(revenue.other),
        },
        expenses: {
          stay:           numArr(expenses.stay),
          travel:         travelArr(expenses.travel),
          food_faculty:   numArr(expenses.food_faculty),
          memento:        labeledArr(expenses.memento),
          cab:            numArr(expenses.cab),
          food_event:     labeledArr(expenses.food_event),
          venue:          labeledArr(expenses.venue),
          photography:    single(expenses.photography),
          material:       single(expenses.material),
          transportation: single(expenses.transportation),
          printing:       single(expenses.printing),
          flower:         single(expenses.flower),
          light_sound:    single(expenses.light_sound),
          led_screen:     single(expenses.led_screen),
          other:          labeledArr(expenses.other),
        },
      };
    }
    case "task_list": {
      // The raw value is an array of TaskItem rows. We trim, validate each,
      // and return the cleaned array. The reconciliation into the
      // checklist_task_assignments table happens in the responses save
      // endpoint — this layer is shape-only.
      if (!Array.isArray(raw)) throw new ApiError(400, "Tasks must be a list");
      const cleaned: TaskItem[] = [];
      for (const r of raw) {
        if (!r || typeof r !== "object") continue;
        const t = r as Record<string, unknown>;
        const description = typeof t.description === "string" ? t.description.trim() : "";
        if (!description) continue;   // silently drop rows with no description
        cleaned.push({
          cid: typeof t.cid === "string" ? t.cid : undefined,
          description: description.slice(0, 500),
          assignee_id: typeof t.assignee_id === "string" && t.assignee_id ? t.assignee_id : null,
          due_date: typeof t.due_date === "string" && t.due_date ? t.due_date.slice(0, 10) : null,
          status: (t.status === "done" || t.status === "cancelled") ? t.status : "pending",
          notes: typeof t.notes === "string" ? t.notes.slice(0, 1000) : null,
        });
      }
      if (cfg.min_tasks && cleaned.length < cfg.min_tasks) {
        throw new ApiError(400, `Add at least ${cfg.min_tasks} task${cfg.min_tasks === 1 ? "" : "s"}`);
      }
      return cleaned;
    }
    case "checklist_table": {
      // Response shape: { [rowId]: { [colKey]: string | number } }.
      // We validate ONLY 'data' rows against the template's columns —
      // total / computed rows are derived at read time and never stored.
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new ApiError(400, "Checklist table response must be an object");
      }
      const cols: ChecklistTableColumn[] = Array.isArray(cfg.columns) ? cfg.columns : [];
      const rows: ChecklistTableRow[] = Array.isArray(cfg.rows) ? cfg.rows : [];
      const dataRowIds = new Set(
        rows.filter((r) => (r.kind ?? "data") === "data").map((r) => r.id),
      );

      const out: Record<string, Record<string, string | number>> = {};
      const rec = raw as Record<string, unknown>;
      for (const rowId of Object.keys(rec)) {
        if (!dataRowIds.has(rowId)) continue;  // drop unknown / non-data rows
        const cell = rec[rowId];
        if (typeof cell !== "object" || cell === null) continue;
        const cellMap = cell as Record<string, unknown>;
        const cleanedRow: Record<string, string | number> = {};
        for (const col of cols) {
          const v = cellMap[col.key];
          if (v === undefined || v === null || v === "") continue;
          if (col.type === "number" || col.type === "money") {
            const n = Number(v);
            if (Number.isFinite(n)) cleanedRow[col.key] = n;
          } else if (col.type === "status") {
            const s = String(v);
            if (s === "done" || s === "pending" || s === "na") cleanedRow[col.key] = s;
          } else {
            // text
            cleanedRow[col.key] = String(v).slice(0, 500);
          }
        }
        if (Object.keys(cleanedRow).length > 0) out[rowId] = cleanedRow;
      }
      return out;
    }
  }
}

function clampInt(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
