// One-shot READ-ONLY script.
//
// Reads every row of `site_content` from the DB (SELECT only — nothing is
// written, updated, or deleted in the DB), merges each row's data over the
// current SITE_CONTENT_DEFAULTS in frontend/src/hooks/useSiteContent.js, and
// rewrites the JS file so the DB values become the baked-in defaults.
//
// Behaviour on merge:
//   - For each slug in the DB:  merged = { ...existing_default, ...db_data }
//     → DB wins per-key, existing defaults fill any keys the DB row lacks.
//   - Slugs that exist in the defaults but NOT in the DB are left untouched.
//   - Slugs that exist in the DB but NOT in the defaults are APPENDED to the
//     defaults map (with a small `// added from DB` comment).
//
// Safety:
//   - Backs up the original JS file to `<file>.bak.<timestamp>` before writing.
//   - Prints a full summary of what changed and offers `--dry-run` to preview.
//   - Never writes to the DB.
//
// Usage:
//   npx tsx scripts/dump-site-content-defaults.ts --dry-run   # preview only
//   npx tsx scripts/dump-site-content-defaults.ts             # apply

import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../db/client.js";
import { siteContent } from "../schema/site.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULTS_FILE = resolve(HERE, "..", "..", "frontend", "src", "hooks", "useSiteContent.js");

const dryRun = process.argv.includes("--dry-run");

async function main() {
  console.log("→ Reading site_content rows from DB (read-only SELECT)…");
  const rows = await db
    .select({ slug: siteContent.slug, data: siteContent.data })
    .from(siteContent);
  console.log(`  ${rows.length} row(s) found.\n`);

  const original = readFileSync(DEFAULTS_FILE, "utf8");
  const currentDefaults = extractCurrentDefaults(original);

  const dbBySlug = new Map<string, Record<string, unknown>>(
    rows.map((r) => [r.slug, (r.data ?? {}) as Record<string, unknown>]),
  );

  const updated: string[] = [];
  const unchanged: string[] = [];
  const newSlots: string[] = [];
  const missingInDb: string[] = [];

  let source = original;

  // 1. Existing slots: replace-in-place if the DB has data for them.
  for (const slug of Object.keys(currentDefaults)) {
    if (!dbBySlug.has(slug)) {
      missingInDb.push(slug);
      continue;
    }
    const existing = (currentDefaults as Record<string, unknown>)[slug] as Record<string, unknown>;
    const dbData = dbBySlug.get(slug)!;
    const merged = { ...existing, ...dbData };
    if (deepEqual(merged, existing)) {
      unchanged.push(slug);
      continue;
    }
    source = replaceSlot(source, slug, merged);
    updated.push(slug);
  }

  // 2. Slugs in DB but not in the defaults map: append at the end.
  for (const [slug, data] of dbBySlug) {
    if (slug in currentDefaults) continue;
    source = appendSlot(source, slug, data, /* comment */ "added from DB");
    newSlots.push(slug);
  }

  // Report
  console.log("Summary:");
  console.log(`  ~ Updated slots      : ${updated.length}`);
  updated.forEach((s) => console.log(`      ~ ${s}`));
  console.log(`  = Unchanged slots    : ${unchanged.length}`);
  console.log(`  + New slots (appended): ${newSlots.length}`);
  newSlots.forEach((s) => console.log(`      + ${s}`));
  console.log(`  · Slots in defaults but NOT in DB (kept as-is): ${missingInDb.length}`);
  missingInDb.forEach((s) => console.log(`      · ${s}`));

  if (updated.length === 0 && newSlots.length === 0) {
    console.log("\nNothing to write — defaults already match DB.");
    process.exit(0);
  }

  if (dryRun) {
    console.log("\n(dry-run — no files written)");
    process.exit(0);
  }

  const backupPath = `${DEFAULTS_FILE}.bak.${Date.now()}`;
  writeFileSync(backupPath, original, "utf8");
  writeFileSync(DEFAULTS_FILE, source, "utf8");
  console.log(`\n✓ Backup written to ${backupPath}`);
  console.log(`✓ ${DEFAULTS_FILE} rewritten.`);
  process.exit(0);
}

// ─── Source-file surgery ─────────────────────────────────────────────────────

function extractCurrentDefaults(src: string): Record<string, unknown> {
  const marker = "export const SITE_CONTENT_DEFAULTS = ";
  const startIdx = src.indexOf(marker);
  if (startIdx < 0) throw new Error("SITE_CONTENT_DEFAULTS not found in file");
  const braceIdx = src.indexOf("{", startIdx);
  const endIdx = findMatchingBrace(src, braceIdx);
  const objText = src.slice(braceIdx, endIdx + 1);
  // Eval the object literal. Trusted local source — no user input.
  // eslint-disable-next-line no-eval
  const obj = (0, eval)("(" + objText + ")");
  if (!obj || typeof obj !== "object") throw new Error("failed to eval defaults literal");
  return obj as Record<string, unknown>;
}

function replaceSlot(src: string, slug: string, value: unknown): string {
  const re = new RegExp(`(^|\\n)  ${escapeRegex(slug)}:\\s*\\{`);
  const m = re.exec(src);
  if (!m) throw new Error(`slot "${slug}" not found in defaults file`);
  const startNl = m.index + m[1].length; // start of the line (2-space indent)
  const braceIdx = src.indexOf("{", startNl);
  const endBrace = findMatchingBrace(src, braceIdx);
  let after = endBrace + 1;
  if (src[after] === ",") after++;
  if (src[after] === "\n") after++;
  const serialized = serializeSlot(slug, value);
  return src.slice(0, startNl) + serialized + src.slice(after);
}

function appendSlot(src: string, slug: string, value: unknown, note: string): string {
  const marker = "export const SITE_CONTENT_DEFAULTS = ";
  const startIdx = src.indexOf(marker);
  const braceIdx = src.indexOf("{", startIdx);
  const endBrace = findMatchingBrace(src, braceIdx);
  const serialized = `  // ${note}\n` + serializeSlot(slug, value);
  return src.slice(0, endBrace) + serialized + src.slice(endBrace);
}

function findMatchingBrace(src: string, openIdx: number): number {
  if (src[openIdx] !== "{") throw new Error(`expected '{' at position ${openIdx}`);
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const c = src[i];
    // Line comment
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    // Block comment
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    // Regular string
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\") { i += 2; continue; }
        i++;
      }
      i++;
      continue;
    }
    // Template literal
    if (c === "`") {
      i++;
      while (i < src.length && src[i] !== "`") {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === "$" && src[i + 1] === "{") {
          i += 2;
          let d = 1;
          while (i < src.length && d > 0) {
            if (src[i] === "{") d++;
            else if (src[i] === "}") d--;
            if (d > 0) i++;
          }
          i++; // past closing }
          continue;
        }
        i++;
      }
      i++;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  throw new Error("unmatched '{' — reached end of file");
}

// ─── Serializer ──────────────────────────────────────────────────────────────

function serializeSlot(slug: string, value: unknown): string {
  return `  ${serializeKey(slug)}: ${serializeValue(value, 1)},\n`;
}

function serializeValue(v: unknown, indent: number): string {
  const pad = "  ".repeat(indent);
  const inner = "  ".repeat(indent + 1);
  if (v === null) return "null";
  if (v === undefined) return "undefined";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "string") return serializeString(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const items = v.map((x) => serializeValue(x, indent + 1));
    // Short arrays of primitives → single line
    const allPrimitive = v.every((x) => x === null || typeof x !== "object");
    if (allPrimitive) {
      const oneLine = `[${items.join(", ")}]`;
      if (oneLine.length < 80) return oneLine;
    }
    return `[\n${items.map((s) => `${inner}${s},`).join("\n")}\n${pad}]`;
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const lines = entries.map(
      ([k, val]) => `${inner}${serializeKey(k)}: ${serializeValue(val, indent + 1)},`,
    );
    return `{\n${lines.join("\n")}\n${pad}}`;
  }
  return JSON.stringify(v);
}

function serializeKey(k: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k)) return k;
  return serializeString(k);
}

function serializeString(s: string): string {
  // Multi-line strings → template literal (readable in source)
  if (s.includes("\n") && !s.includes("`") && !s.includes("${")) {
    return "`" + s.replace(/\\/g, "\\\\") + "`";
  }
  // Prefer single quotes when possible (matches file style)
  if (!s.includes("'")) {
    const escaped = s
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t");
    return "'" + escaped + "'";
  }
  // Fallback: JSON.stringify (double-quoted, fully escaped)
  return JSON.stringify(s);
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a as object);
  const bk = Object.keys(b as object);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual((a as any)[k], (b as any)[k])) return false;
  }
  return true;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
