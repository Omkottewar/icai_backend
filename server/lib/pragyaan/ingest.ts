// Pragyaan AI — ingestion core (FIN-151, P0-4 public corpus + P0-5 admin upload).
//
// One reusable pipeline that turns a text document into approved, retrievable
// kb_chunks:
//
//   checksum → upsert kb_sources → chunk → embed → replace kb_chunks
//     → status='indexed' (+ auto-approve for public) → writeAudit
//
// `ingestSource` is the single entry point both the public-corpus job
// (scripts/ingest-public.mjs) and the admin upload route (P0-5) call. It is
// idempotent: a source whose text checksum hasn't changed AND is already
// indexed is skipped, so re-running the public job is cheap and safe.
//
// `buildPublicDocs` gathers the launch (visitor-scope) corpus from the existing
// PUBLISHED public tables — events, site_content, announcements, branch
// resources, and the PDF-backed newsletters / annual reports / paper
// presentations. Only live/published rows are included; gated content never
// enters the public scope.
//
// Conventions matched from the surrounding code: snake_case columns, the db
// singleton, the drizzle sql`` template, the pgvector '[..]'::vector literal
// (see retrieval.ts), writeAudit (see audit.ts), and graceful degradation when
// an optional dependency (pdf-parse) or table is absent.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import {
  kbSources,
  kbChunks,
  events,
  committees,
  siteContent,
  announcements,
  branchNewsletters,
  annualReports,
  paperPresentations,
  officeBearers,
  ejournalIssues,
  icaiLinkCards,
  files,
} from "../../../schema/index.js";
import { storage } from "../storage.js";
import { writeAudit } from "./audit.js";
import { chunkText } from "./chunk.js";
import { getProvider } from "./provider.js";
import type { KbScope } from "./scope.js";

// kb_source_type enum values (schema/enums.ts → kbSourceTypeEnum). Re-declared
// as a TS union so callers get autocomplete; the public-corpus mapping picks
// the closest fit per origin kind.
export type KbSourceType =
  | "uploaded_pdf"
  | "url"
  | "internal_doc"
  | "event_material"
  | "newsletter"
  | "circular";

// locale enum (en | hi | mr).
export type KbLang = "en" | "hi" | "mr";

// ─── PDF text extraction ────────────────────────────────────────────────────
/**
 * Extract plain text from a PDF buffer. `pdf-parse` is loaded via dynamic
 * import inside a try/catch so a missing dependency (or a corrupt/parser-
 * defeating PDF) degrades to "" rather than throwing — ingestion of a bad PDF
 * simply yields an empty doc that the caller skips. (Spec: "agents write code
 * guarded so missing dep degrades gracefully".)
 */
export async function extractPdfText(buf: Buffer): Promise<string> {
  try {
    const mod: any = await import("pdf-parse");
    // pdf-parse v1 default-exports a function; v2 may expose { pdf } / default.
    const parse =
      typeof mod === "function"
        ? mod
        : typeof mod.default === "function"
          ? mod.default
          : typeof mod.pdf === "function"
            ? mod.pdf
            : null;
    if (!parse) return "";
    const out = await parse(buf);
    return typeof out?.text === "string" ? out.text.trim() : "";
  } catch {
    // Missing dependency, unsupported/encrypted PDF, or parser error — skip.
    return "";
  }
}

// ─── checksum ────────────────────────────────────────────────────────────────
/** sha256 hex of the source text — drives change-detection / re-index dedupe. */
export function computeChecksum(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ─── ingestSource ──────────────────────────────────────────────────────────
export interface IngestSourceInput {
  /** Display title (citation label). */
  title: string;
  /** The full plain text to chunk + embed. Empty/whitespace ⇒ no-op skip. */
  text: string;
  /** Access scope for the resulting chunks (public auto-approves). */
  scope: KbScope;
  /** Reply/content language tag stored on source + chunks. */
  lang: KbLang;
  /** kb_source_type bucket. */
  sourceType: KbSourceType;
  /** Originating table kind ('event' | 'site_content' | …) for DB-sourced rows. */
  originKind?: string | null;
  /** Originating DB row id, when the source is a row in another table. */
  originId?: string | null;
  /** External/deep-link URL for the citation chip, if any. */
  url?: string | null;
  /** files.id when the source is a stored file (PDF upload). */
  fileId?: string | null;
  /** Acting user id (audit actor); null/undefined for system jobs. */
  uploadedBy?: string | null;
  /** Force approval even for non-public scope (admin "publish now"). */
  autoApprove?: boolean;
}

export interface IngestSourceResult {
  /** kb_sources.id of the upserted source. */
  sourceId: string | null;
  /** True when nothing changed (checksum match + already indexed) — no work done. */
  skipped: boolean;
  /** Number of chunks written (0 when skipped or when text was empty). */
  chunkCount: number;
  /** 'indexed' on success, 'skipped' when unchanged, 'empty' when no text. */
  status: "indexed" | "skipped" | "empty";
}

/** Existing kb_sources row fields we need to decide skip vs. re-index. */
interface ExistingSource {
  id: string;
  checksum: string | null;
  status: string;
  version: number;
  approved_at: Date | null;
}

/** Look up an existing source by (origin_kind, origin_id) or by id. */
async function findExistingSource(
  originKind: string | null,
  originId: string | null,
  byId: string | null,
): Promise<ExistingSource | null> {
  if (originKind && originId) {
    const [row] = await db
      .select({
        id: kbSources.id,
        checksum: kbSources.checksum,
        status: kbSources.status,
        version: kbSources.version,
        approved_at: kbSources.approved_at,
      })
      .from(kbSources)
      .where(and(eq(kbSources.origin_kind, originKind), eq(kbSources.origin_id, originId)))
      .limit(1);
    return (row as ExistingSource | undefined) ?? null;
  }
  if (byId) {
    const [row] = await db
      .select({
        id: kbSources.id,
        checksum: kbSources.checksum,
        status: kbSources.status,
        version: kbSources.version,
        approved_at: kbSources.approved_at,
      })
      .from(kbSources)
      .where(eq(kbSources.id, byId))
      .limit(1);
    return (row as ExistingSource | undefined) ?? null;
  }
  return null;
}

/** Format a JS number[] as a pgvector text literal '[v1,v2,...]' (see retrieval.ts). */
function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * Ingest (create or re-index) a single source end-to-end.
 *
 * Idempotent: if the text checksum matches the stored one AND the source is
 * already `indexed`, returns `{ skipped: true }` without embedding. Otherwise
 * it (re)chunks, embeds via the provider, atomically replaces the source's
 * kb_chunks, flips status to `indexed`, auto-approves when public (or when
 * `autoApprove`), and appends a kb_audit row ('upload' for a new source,
 * 'reindex' for an existing one).
 *
 * Public scope ⇒ system-auto-approved (approved_at=now()) so the launch
 * (visitor) scope can answer immediately. The DB write (chunk replace + status)
 * runs in one transaction so a partially-embedded source never becomes live.
 */
export async function ingestSource(input: IngestSourceInput): Promise<IngestSourceResult> {
  const title = input.title.trim();
  const text = input.text.trim();
  const originKind = input.originKind ?? null;
  const originId = input.originId ?? null;
  const explicitId = null; // by-id upsert is only used by callers that pass an id; none today.

  // Empty text ⇒ nothing to embed. Don't create/mutate a source row.
  if (!text) {
    return { sourceId: null, skipped: true, chunkCount: 0, status: "empty" };
  }

  const checksum = computeChecksum(text);
  const existing = await findExistingSource(originKind, originId, explicitId);

  // Fast path: unchanged + already indexed ⇒ skip (no embedding spend).
  if (existing && existing.checksum === checksum && existing.status === "indexed") {
    return { sourceId: existing.id, skipped: true, chunkCount: 0, status: "skipped" };
  }

  const autoApprove = input.scope === "public" || input.autoApprove === true;
  const isReindex = existing != null;

  // Upsert the source row (outside the chunk transaction so its id is stable
  // for the audit + chunk inserts). Pending until the chunk replace commits.
  let sourceId: string;
  let fromVersion: number | null = null;
  let toVersion = 1;

  if (existing) {
    fromVersion = existing.version;
    toVersion = existing.version + 1;
    sourceId = existing.id;
    await db
      .update(kbSources)
      .set({
        title,
        source_type: input.sourceType,
        scope: input.scope,
        lang: input.lang,
        url: input.url ?? null,
        file_id: input.fileId ?? null,
        checksum,
        status: "chunking",
        version: toVersion,
        error: null,
        updated_at: new Date(),
        // Re-affirm approval for auto-approved scopes; leave gated sources for
        // the chairman to (re)approve.
        ...(autoApprove ? { approved_at: new Date() } : {}),
      })
      .where(eq(kbSources.id, sourceId));
  } else {
    const [created] = await db
      .insert(kbSources)
      .values({
        title,
        source_type: input.sourceType,
        scope: input.scope,
        lang: input.lang,
        url: input.url ?? null,
        origin_kind: originKind,
        origin_id: originId,
        file_id: input.fileId ?? null,
        checksum,
        status: "chunking",
        version: toVersion,
        uploaded_by: input.uploadedBy ?? null,
        ...(autoApprove ? { approved_at: new Date() } : {}),
      })
      .returning({ id: kbSources.id });
    sourceId = created!.id;
  }

  // Chunk + embed (provider call — outside the txn; the txn only does DB work).
  const chunks = chunkText(text);
  // Chunk + embed, then atomically replace the source's chunks and mark it
  // indexed. On ANY failure (embedding error, DB error) flip the source to
  // 'failed' with the message so it doesn't sit silently stuck in 'chunking'.
  // This is operability only — a non-'indexed' source is never retrievable
  // (the gate requires 'indexed'), so a failed re-index never serves stale or
  // partial content.
  try {
    const embeddings =
      chunks.length > 0 ? await getProvider().embedTexts(chunks.map((c) => c.content)) : [];

    await db.transaction(async (tx) => {
      await tx.delete(kbChunks).where(eq(kbChunks.source_id, sourceId));

      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        const vec = embeddings[i] ?? [];
        const literal = toVectorLiteral(vec);
        // Embedding bound as a pgvector literal then cast ::vector (retrieval.ts
        // pattern). All other values are bound params — injection-safe.
        await tx.execute(sql`
          INSERT INTO kb_chunks
            (source_id, chunk_index, content, token_count, scope, lang, embedding)
          VALUES (
            ${sourceId},
            ${c.chunkIndex},
            ${c.content},
            ${c.tokenCount},
            ${input.scope}::kb_scope,
            ${input.lang}::locale,
            ${literal}::vector
          )
        `);
      }

      await tx
        .update(kbSources)
        .set({ status: "indexed", updated_at: new Date() })
        .where(eq(kbSources.id, sourceId));
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await db
      .update(kbSources)
      .set({ status: "failed", error: msg.slice(0, 1000), updated_at: new Date() })
      .where(eq(kbSources.id, sourceId));
    throw err;
  }

  // Tamper-evident audit row (P0-8). Non-fatal detail; the source is already
  // live at this point.
  await writeAudit({
    sourceId,
    actorId: input.uploadedBy ?? null,
    action: isReindex ? "reindex" : "upload",
    fromVersion,
    toVersion,
    detail: {
      title,
      scope: input.scope,
      lang: input.lang,
      source_type: input.sourceType,
      origin_kind: originKind,
      origin_id: originId,
      checksum,
      chunk_count: chunks.length,
      auto_approved: autoApprove,
      via: originKind ? "ingest_public" : "ingest_source",
    },
  });

  return { sourceId, skipped: false, chunkCount: chunks.length, status: "indexed" };
}

// ─── buildPublicDocs ─────────────────────────────────────────────────────────
/** One candidate public document — the shape the ingest job feeds ingestSource. */
export interface PublicDoc {
  title: string;
  text: string;
  originKind: string;
  originId: string;
  sourceType: KbSourceType;
  url: string | null;
  /** Content language; defaults 'en' for branch content (mostly English). */
  lang?: KbLang;
}

// Site-content slots whose body is public, renderable prose worth indexing.
// Image-only / roster slots (about_committee_members) carry no text.
// The faq_* slots back the Pragyaan starter chips — every starter question
// must have a matching Q&A here so the bot can ground its reply.
const PUBLIC_SITE_SLOTS = new Set<string>([
  "chairman_message",
  "home_hero",
  "home_hero_stats",
  "home_leadership_banner",
  "home_branch_premises",
  "about_vision",
  "about_mission",
  "about_history",
  "faq_branch_services",
  "faq_for_members",
  "faq_for_students",
  "faq_for_employers",
]);

/** Postgres "undefined_table" (relation does not exist) — table not present. */
function isMissingRelation(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "42P01") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /relation .* does not exist/i.test(msg);
}

// Flatten a site_content `data` JSON blob into readable text. Strings are kept
// as-is; { stats: [{k,v}] } and stat arrays render as "label: value" lines;
// nested objects/arrays of strings are joined. Image/URL fields are dropped.
function flattenSiteData(data: unknown): string {
  const lines: string[] = [];
  const visit = (val: unknown, keyHint?: string): void => {
    if (val == null) return;
    if (typeof val === "string") {
      const s = val.trim();
      // Skip values that are just a file UUID (image fields) or a bare URL.
      if (!s) return;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return;
      if (/^https?:\/\/\S+$/i.test(s) && !/\s/.test(s)) return;
      lines.push(keyHint ? `${keyHint}: ${s}` : s);
      return;
    }
    if (typeof val === "number" || typeof val === "boolean") {
      lines.push(keyHint ? `${keyHint}: ${val}` : String(val));
      return;
    }
    if (Array.isArray(val)) {
      for (const item of val) {
        if (item && typeof item === "object" && "k" in (item as any)) {
          const o = item as { k?: unknown; v?: unknown };
          const k = typeof o.k === "string" ? o.k : "";
          const v = o.v == null ? "" : String(o.v);
          if (k || v) lines.push(`${k}: ${v}`.trim());
        } else {
          visit(item);
        }
      }
      return;
    }
    if (typeof val === "object") {
      for (const v of Object.values(val as Record<string, unknown>)) visit(v);
    }
  };
  visit(data);
  return lines.join("\n");
}

// Fetch the raw bytes for a stored file. Local-disk paths (storage().url →
// "/uploads/<bucket>/<file>") are read straight off disk so the job works with
// the server stopped; absolute URLs (Supabase public bucket) are fetched.
async function fetchFileBytes(storagePath: string): Promise<Buffer | null> {
  try {
    const url = storage().url(storagePath);
    if (/^https?:\/\//i.test(url)) {
      const r = await fetch(url);
      if (!r.ok) return null;
      return Buffer.from(await r.arrayBuffer());
    }
    // Relative "/uploads/<storage_path>" → read from ./uploads on disk.
    return await readFile(join(process.cwd(), "uploads", storagePath));
  } catch {
    return null;
  }
}

// Build the deep-link URL for a stored file (citation target).
function fileLink(storagePath: string | null): string | null {
  if (!storagePath) return null;
  try {
    return storage().url(storagePath);
  } catch {
    return null;
  }
}

/**
 * Gather the PUBLISHED public corpus as ingest-ready docs. Pulls only
 * live/published/non-hidden rows from the tables that actually back the public
 * site:
 *
 *   • events            — status='published', not deleted, +committee name
 *   • site_content      — the public prose slots (chairman/about/home …)
 *   • announcements     — currently-active window, audience 'all'
 *   • paper_presentations / branch_newsletters / annual_reports — PDF text
 *     (best-effort via pdf-parse; PDFs that yield no text are skipped)
 *   • office_bearers    — current roster (names/roles as a small reference doc)
 *
 * Optional tables that the spec lists but that don't exist in this schema
 * (circulars / standards / FAQs) are probed defensively and skipped when the
 * relation is absent, so this stays forward-compatible without breaking now.
 *
 * No DB writes here — the caller (scripts/ingest-public.mjs) feeds each doc to
 * ingestSource(scope:'public', autoApprove:true).
 */
export async function buildPublicDocs(): Promise<PublicDoc[]> {
  const docs: PublicDoc[] = [];

  // ── Events (published, not deleted) ──────────────────────────────────────
  {
    const rows = await db
      .select({
        id: events.id,
        slug: events.slug,
        title: events.title,
        description: events.description,
        venue: events.venue,
        online_url: events.online_url,
        mode: events.mode,
        audience: events.audience,
        starts_at: events.starts_at,
        ends_at: events.ends_at,
        cpe_hours: events.cpe_hours,
        program_type: events.program_type,
        highlights: events.highlights,
        committee_name: committees.name,
      })
      .from(events)
      .leftJoin(committees, eq(committees.id, events.committee_id))
      .where(and(isNull(events.deleted_at), eq(events.status, "published")));

    for (const r of rows) {
      const parts: string[] = [r.title];
      if (r.committee_name) parts.push(`Organised by: ${r.committee_name}`);
      if (r.program_type) parts.push(`Type: ${r.program_type}`);
      parts.push(`Audience: ${r.audience}; Mode: ${r.mode}`);
      if (r.starts_at) parts.push(`Starts: ${new Date(r.starts_at).toISOString()}`);
      if (r.ends_at) parts.push(`Ends: ${new Date(r.ends_at).toISOString()}`);
      if (r.venue) parts.push(`Venue: ${r.venue}`);
      if (r.online_url) parts.push(`Online: ${r.online_url}`);
      if (r.cpe_hours) parts.push(`CPE hours: ${r.cpe_hours}`);
      if (Array.isArray(r.highlights) && r.highlights.length) {
        parts.push(`Highlights: ${r.highlights.join("; ")}`);
      }
      if (r.description) parts.push("", r.description);
      docs.push({
        title: r.title,
        text: parts.join("\n"),
        originKind: "event",
        originId: r.id,
        sourceType: "event_material",
        url: `/#/events/${r.slug}`,
      });
    }
  }

  // ── Site content (public prose slots only) ───────────────────────────────
  {
    const rows = await db
      .select({ slug: siteContent.slug, data: siteContent.data })
      .from(siteContent);
    for (const r of rows) {
      if (!PUBLIC_SITE_SLOTS.has(r.slug)) continue;
      const text = flattenSiteData(r.data);
      if (!text.trim()) continue;
      docs.push({
        title: humanizeSlug(r.slug),
        text,
        originKind: "site_content",
        // site_content PK is the slug (text), not a uuid; origin_id expects a
        // uuid, so we leave it null and dedupe by (origin_kind, title) instead.
        originId: deterministicUuidFromKey(`site_content:${r.slug}`),
        sourceType: "internal_doc",
        url: aboutOrHomeLink(r.slug),
      });
    }
  }

  // ── Announcements (active window) ────────────────────────────────────────
  {
    const now = new Date();
    const rows = await db
      .select({
        id: announcements.id,
        title: announcements.title,
        body: announcements.body,
        link_url: announcements.link_url,
        audience: announcements.audience,
        starts_at: announcements.starts_at,
        ends_at: announcements.ends_at,
      })
      .from(announcements)
      .where(isNull(announcements.deleted_at));
    for (const r of rows) {
      // Active = started and not ended (mirrors GET /api/announcements).
      const started = r.starts_at == null || new Date(r.starts_at) <= now;
      const notEnded = r.ends_at == null || new Date(r.ends_at) > now;
      if (!started || !notEnded) continue;
      // Public scope only carries 'all'/'public' announcements.
      if (r.audience && !["all", "public"].includes(r.audience)) continue;
      const text = [r.title, r.body ?? ""].filter(Boolean).join("\n\n").trim();
      if (!text) continue;
      docs.push({
        title: r.title,
        text,
        originKind: "announcement",
        originId: r.id,
        sourceType: "internal_doc",
        url: r.link_url ?? null,
      });
    }
  }

  // ── Office bearers (current roster — small reference doc) ─────────────────
  {
    const rows = await db
      .select({
        id: officeBearers.id,
        term_label: officeBearers.term_label,
        role_label: officeBearers.role_label,
        person_name: officeBearers.person_name,
        bio: officeBearers.bio,
        email: officeBearers.email,
        phone: officeBearers.phone,
      })
      .from(officeBearers)
      .where(and(eq(officeBearers.hidden, false), eq(officeBearers.is_current, true)));
    for (const r of rows) {
      const parts = [`${r.role_label}: ${r.person_name} (${r.term_label})`];
      if (r.email) parts.push(`Email: ${r.email}`);
      if (r.phone) parts.push(`Phone: ${r.phone}`);
      if (r.bio) parts.push("", r.bio);
      docs.push({
        title: `${r.role_label} — ${r.person_name}`,
        text: parts.join("\n"),
        originKind: "office_bearer",
        originId: r.id,
        sourceType: "internal_doc",
        url: "/#/about",
      });
    }
  }

  // ── Committees (standalone reference docs) ────────────────────────────────
  // The committee name is already joined onto events; this section ingests
  // each active committee's charter/description as its own kb_source so the
  // bot can answer "what does the Direct Tax Committee do?" without an event
  // being involved. Inactive committees are skipped — past-only committees
  // shouldn't surface in suggestions.
  {
    const rows = await db
      .select({
        id: committees.id,
        code: committees.code,
        name: committees.name,
        description: committees.description,
      })
      .from(committees)
      .where(eq(committees.active, true));
    for (const r of rows) {
      const text = [r.name, r.description ?? ""].filter(Boolean).join("\n\n").trim();
      if (!text) continue;
      docs.push({
        title: `Committee — ${r.name}`,
        text,
        originKind: "committee",
        originId: r.id,
        sourceType: "internal_doc",
        // No public detail page yet — the About page lists committees.
        url: "/#/about",
      });
    }
  }

  // ── ICAI link cards (curated external deep-links) ─────────────────────────
  // Quick-link cards on the Resources page pointing at icai.org / wirc-icai
  // / GST portal / etc. The url field IS the citation target — the bot can
  // say "see the ICAI CPE Portal [n]" with a real outbound link.
  {
    const rows = await db
      .select({
        id: icaiLinkCards.id,
        category: icaiLinkCards.category,
        title: icaiLinkCards.title,
        description: icaiLinkCards.description,
        url: icaiLinkCards.url,
      })
      .from(icaiLinkCards)
      .where(eq(icaiLinkCards.active, true));
    for (const r of rows) {
      // Skip the mock seed rows so the bot doesn't cite them after launch.
      if (/^\[MOCK\]/i.test(r.title)) continue;
      const parts: string[] = [r.title];
      if (r.category) parts.push(`Category: ${r.category}`);
      if (r.description) parts.push("", r.description);
      parts.push("", `Link: ${r.url}`);
      docs.push({
        title: r.title,
        text: parts.join("\n"),
        originKind: "icai_link",
        originId: r.id,
        sourceType: "url",
        url: r.url,
      });
    }
  }

  // ── PDF-backed resources: newsletters / annual reports / paper presentations
  //    + e-journal issues
  await collectPdfDocs(docs);

  // ── Optional tables the spec mentions but that don't exist here yet
  //    (circulars / standards / FAQs). Probe defensively; skip if absent.
  await collectOptionalTextDocs(docs);

  return docs;
}

// Pull PDF-backed branch resources, extract their text, and push docs for the
// ones that yield usable text. hidden=false everywhere (matches the public
// branch-content endpoints).
async function collectPdfDocs(docs: PublicDoc[]): Promise<void> {
  // Newsletters
  {
    const rows = await db
      .select({
        id: branchNewsletters.id,
        title: branchNewsletters.title,
        issue_month: branchNewsletters.issue_month,
        issue_year: branchNewsletters.issue_year,
        editor_note: branchNewsletters.editor_note,
        pdf_path: files.storage_path,
      })
      .from(branchNewsletters)
      .leftJoin(files, eq(files.id, branchNewsletters.pdf_file_id))
      .where(eq(branchNewsletters.hidden, false));
    for (const r of rows) {
      const pdfText = r.pdf_path ? await pdfTextFor(r.pdf_path) : "";
      const text = [r.title, r.editor_note ?? "", pdfText].filter(Boolean).join("\n\n").trim();
      if (!text) continue;
      docs.push({
        title: `${r.title} (${r.issue_month}/${r.issue_year})`,
        text,
        originKind: "newsletter",
        originId: r.id,
        sourceType: "newsletter",
        url: fileLink(r.pdf_path),
      });
    }
  }

  // Annual reports
  {
    const rows = await db
      .select({
        id: annualReports.id,
        fy_label: annualReports.fy_label,
        title: annualReports.title,
        summary: annualReports.summary,
        pdf_path: files.storage_path,
      })
      .from(annualReports)
      .leftJoin(files, eq(files.id, annualReports.pdf_file_id))
      .where(eq(annualReports.hidden, false));
    for (const r of rows) {
      const pdfText = r.pdf_path ? await pdfTextFor(r.pdf_path) : "";
      const heading = r.title ?? `Annual Report ${r.fy_label}`;
      const text = [heading, r.summary ?? "", pdfText].filter(Boolean).join("\n\n").trim();
      if (!text) continue;
      docs.push({
        title: heading,
        text,
        originKind: "annual_report",
        originId: r.id,
        sourceType: "internal_doc",
        url: fileLink(r.pdf_path),
      });
    }
  }

  // E-journal issues (quarterly publication) — only published, non-hidden
  // rows are public. The editorial summary + PDF body get indexed; the
  // citation deep-links to the in-app issue page (slug-routed).
  {
    const rows = await db
      .select({
        id: ejournalIssues.id,
        slug: ejournalIssues.slug,
        title: ejournalIssues.title,
        issue_label: ejournalIssues.issue_label,
        issue_year: ejournalIssues.issue_year,
        editorial_summary: ejournalIssues.editorial_summary,
        pdf_path: files.storage_path,
      })
      .from(ejournalIssues)
      .leftJoin(files, eq(files.id, ejournalIssues.pdf_file_id))
      .where(and(eq(ejournalIssues.status, "published"), eq(ejournalIssues.hidden, false)));
    for (const r of rows) {
      const pdfText = r.pdf_path ? await pdfTextFor(r.pdf_path) : "";
      const parts: string[] = [r.title, `Issue: ${r.issue_label}`];
      if (r.editorial_summary) parts.push("", r.editorial_summary);
      if (pdfText) parts.push("", pdfText);
      const text = parts.filter(Boolean).join("\n").trim();
      if (!text) continue;
      docs.push({
        title: `${r.title} — ${r.issue_label}`,
        text,
        originKind: "ejournal_issue",
        originId: r.id,
        sourceType: "newsletter",
        url: `/#/resources/journal/${r.slug}`,
      });
    }
  }

  // Paper presentations
  {
    const rows = await db
      .select({
        id: paperPresentations.id,
        title: paperPresentations.title,
        speaker_name: paperPresentations.speaker_name,
        committee_tag: paperPresentations.committee_tag,
        presented_on: paperPresentations.presented_on,
        description: paperPresentations.description,
        pdf_path: files.storage_path,
      })
      .from(paperPresentations)
      .leftJoin(files, eq(files.id, paperPresentations.pdf_file_id))
      .where(eq(paperPresentations.hidden, false));
    for (const r of rows) {
      const pdfText = r.pdf_path ? await pdfTextFor(r.pdf_path) : "";
      const parts = [r.title, `Speaker: ${r.speaker_name}`];
      if (r.committee_tag) parts.push(`Topic: ${r.committee_tag}`);
      if (r.presented_on) parts.push(`Presented: ${r.presented_on}`);
      if (r.description) parts.push("", r.description);
      if (pdfText) parts.push("", pdfText);
      const text = parts.filter(Boolean).join("\n").trim();
      if (!text) continue;
      docs.push({
        title: r.title,
        text,
        originKind: "paper_presentation",
        originId: r.id,
        sourceType: "event_material",
        url: fileLink(r.pdf_path),
      });
    }
  }
}

// Fetch + extract text for a stored PDF; "" on any failure (missing dep,
// unreadable file, image-only PDF).
async function pdfTextFor(storagePath: string): Promise<string> {
  const bytes = await fetchFileBytes(storagePath);
  if (!bytes) return "";
  return extractPdfText(bytes);
}

// Defensive probe for optional public tables named in the spec (circulars,
// standards, FAQs) that aren't part of this schema. If a future migration adds
// them, ingestion picks them up; until then each probe swallows the
// "relation does not exist" error and contributes nothing.
async function collectOptionalTextDocs(docs: PublicDoc[]): Promise<void> {
  // circulars: id, title, body/summary, url, published/visibility
  await probeTable(
    sql`SELECT id::text AS id, title,
               COALESCE(summary, body, '') AS body,
               url
        FROM circulars
        WHERE COALESCE(is_public, true) = true
          AND deleted_at IS NULL`,
    (r) => ({
      title: String(r.title ?? "Circular"),
      text: [r.title, r.body].filter(Boolean).join("\n\n"),
      originKind: "circular",
      originId: String(r.id),
      sourceType: "circular" as KbSourceType,
      url: (r.url as string) ?? null,
    }),
    docs,
  );

  // standards: id, code/title, body
  await probeTable(
    sql`SELECT id::text AS id,
               COALESCE(title, code, 'Standard') AS title,
               COALESCE(body, description, '') AS body,
               url
        FROM standards
        WHERE deleted_at IS NULL`,
    (r) => ({
      title: String(r.title ?? "Standard"),
      text: [r.title, r.body].filter(Boolean).join("\n\n"),
      originKind: "standard",
      originId: String(r.id),
      sourceType: "internal_doc" as KbSourceType,
      url: (r.url as string) ?? null,
    }),
    docs,
  );

  // faqs: id, question, answer
  await probeTable(
    sql`SELECT id::text AS id, question, answer
        FROM faqs
        WHERE COALESCE(is_public, true) = true`,
    (r) => ({
      title: String(r.question ?? "FAQ"),
      text: [r.question, r.answer].filter(Boolean).join("\n\n"),
      originKind: "faq",
      originId: String(r.id),
      sourceType: "internal_doc" as KbSourceType,
      url: null,
    }),
    docs,
  );
}

// Run a probe SELECT; map rows to docs. A missing table is swallowed silently;
// any other error is logged once (non-fatal) so a bad probe never aborts the
// whole corpus build.
async function probeTable(
  query: ReturnType<typeof sql>,
  map: (row: Record<string, unknown>) => PublicDoc,
  docs: PublicDoc[],
): Promise<void> {
  try {
    const rows = (await db.execute(query)) as unknown as Array<Record<string, unknown>>;
    for (const r of rows) {
      const doc = map(r);
      if (doc.text && doc.text.trim()) docs.push(doc);
    }
  } catch (err) {
    if (isMissingRelation(err)) return;
    // eslint-disable-next-line no-console
    console.warn("[pragyaan:ingest] optional table probe failed (non-fatal):", err);
  }
}

// "about_history" → "About — History"; "home_hero" → "Home Hero". Used for
// site_content doc titles.
function humanizeSlug(slug: string): string {
  if (slug.startsWith("faq_")) {
    // faq_branch_services → "FAQ — Branch services"
    const rest = slug.slice(4).replace(/_/g, " ");
    return `FAQ — ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
  }
  const pretty = slug
    .split("_")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(" ");
  return pretty.replace(/^About /, "About — ");
}

// Map a public site slug to its on-site deep link (best-effort).
function aboutOrHomeLink(slug: string): string {
  // Hash-routed SPA — paths without `/#/` get a server SPA-fallback that
  // dumps the user on the home page. The about page is the closest
  // useful landing for chairman/secretary/about-style slots; everything
  // else (home_hero, etc.) doesn't have a dedicated detail page so we
  // leave it pointing at the home route. The frontend Citations
  // component additionally rebuilds URLs from origin_kind, so even
  // older ingested rows with broken paths render to the right place.
  if (slug.startsWith("about_") || slug.includes("chairman") || slug.includes("message")) {
    return "/#/about";
  }
  return "/#/";
}

// site_content rows are keyed by a text slug, but kb_sources.origin_id is a
// uuid. Derive a stable uuid (v5-style, namespaced) from the slug key so the
// (origin_kind, origin_id) upsert is deterministic across runs.
function deterministicUuidFromKey(key: string): string {
  const h = createHash("sha1").update(key).digest("hex");
  // Shape the first 32 hex chars into a uuid; force version=5 + RFC variant.
  const s = h.slice(0, 32).split("");
  s[12] = "5";
  s[16] = ((parseInt(s[16]!, 16) & 0x3) | 0x8).toString(16);
  const u = s.join("");
  return `${u.slice(0, 8)}-${u.slice(8, 12)}-${u.slice(12, 16)}-${u.slice(16, 20)}-${u.slice(20, 32)}`;
}
