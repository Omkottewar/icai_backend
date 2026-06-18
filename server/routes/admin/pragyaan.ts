// Pragyaan AI — admin + chairman governance & analytics API (FIN-151).
//
// Mounted at /api/admin/pragyaan (see routes/admin/index.ts). The parent
// adminRouter already applies requireUser + requireAdmin, so every route here
// is admin-gated by default. The governance *decisions* a chairman must own —
// approve / reject / retention — additionally accept branch/committee chairmen
// via requireRole(['admin','branch_chairman','committee_chairman']) (requireRole
// always also admits 'admin').
//
// Source lifecycle this router drives (P0-5/P0-6):
//   create (admin upload, autoApprove:false)  → status 'indexed', approved_at NULL
//     → chairman approve  → approved_at/approved_by set, retrievable
//     → chairman reject   → status 'failed' + retired_at set, never retrievable
//   reindex / rollback / retire / retention    → maintenance over the source row
//
// Governance gating (spec): a source is retrievable only when
//   status='indexed' AND approved_at IS NOT NULL AND retired_at IS NULL
//   AND (retention_expires_at IS NULL OR retention_expires_at > now()).
//
// Approval state lives on the kb_sources row itself (approved_at/approved_by/
// status/retired_at) plus the append-only kb_audit chain — NOT in a separate
// `approvals` table. (That generic table + its approval_target enum were
// dropped in migration 0015 and do not exist in this DB; the spec's reference
// to it is stale. The kb_audit hash chain is the durable governance record.)
//
// EVERY mutation appends a kb_audit row via writeAudit(action,…) (P0-8).
//
// Conventions matched from neighbouring admin routers: Router(), the db
// singleton, ApiError/handleApiError/need/trim, snake_case columns, drizzle
// query builder for typed reads + the sql`` template / db.execute for the
// analytics aggregates, ".js" relative-import suffixes.

import { Router } from "express";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../../db/client.js";
import { kbSources, kbChunks, kbFeedback, kbMessages, kbConversations, files } from "../../../schema/index.js";
import type { AuthedRequest } from "../../middleware/requireUser.js";
import { requireRole } from "../../middleware/requireRole.js";
import { ApiError, handleApiError, need, trim } from "../../lib/apiError.js";
import { storage } from "../../lib/storage.js";
import { writeAudit } from "../../lib/pragyaan/audit.js";
import { ingestSource, buildPublicDocs, extractPdfText } from "../../lib/pragyaan/ingest.js";
import type { KbLang, KbSourceType } from "../../lib/pragyaan/ingest.js";
import type { KbScope } from "../../lib/pragyaan/scope.js";

export const pragyaanAdminRouter = Router();

// Chairman-or-admin gate for the governance decisions (approve/reject/retention).
// requireRole already folds in 'admin'.
const canGovern = requireRole(["admin", "branch_chairman", "committee_chairman"]);

// ─── enum allow-lists (mirror schema/enums.ts) ───────────────────────────────
const SCOPES: readonly KbScope[] = ["public", "member", "student", "employer", "internal"];
const LANGS: readonly KbLang[] = ["en", "hi", "mr"];
const SOURCE_TYPES: readonly KbSourceType[] = [
  "uploaded_pdf", "url", "internal_doc", "event_material", "newsletter", "circular",
];
const STATUSES = ["pending", "chunking", "embedded", "indexed", "failed"] as const;

function pickScope(v: unknown): KbScope {
  const s = trim(v);
  if (!SCOPES.includes(s as KbScope)) {
    throw new ApiError(400, `scope must be one of: ${SCOPES.join(", ")}`);
  }
  return s as KbScope;
}
function pickLang(v: unknown): KbLang {
  const s = trim(v) || "en";
  if (!LANGS.includes(s as KbLang)) {
    throw new ApiError(400, `lang must be one of: ${LANGS.join(", ")}`);
  }
  return s as KbLang;
}
function pickSourceType(v: unknown): KbSourceType {
  const s = trim(v);
  if (!SOURCE_TYPES.includes(s as KbSourceType)) {
    throw new ApiError(400, `source_type must be one of: ${SOURCE_TYPES.join(", ")}`);
  }
  return s as KbSourceType;
}

function parseOptDate(v: unknown, label: string): Date | null {
  const s = trim(v);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new ApiError(400, `${label} is not a valid date`);
  return d;
}

// Resolve a stored file (files.id) to its plain text. PDFs go through
// extractPdfText (pdf-parse, guarded — degrades to ""); a missing dep or
// image-only PDF yields empty text, which the caller rejects with a clear 400.
// Reads bytes via the same storage() abstraction the ingest job uses.
async function fileToText(fileId: string): Promise<{ title: string; text: string; mime: string }> {
  const [f] = await db
    .select({
      name: files.name,
      mime_type: files.mime_type,
      storage_path: files.storage_path,
    })
    .from(files)
    .where(and(eq(files.id, fileId), isNull(files.deleted_at)))
    .limit(1);
  if (!f) throw new ApiError(404, "File not found");

  let bytes: Buffer | null = null;
  try {
    const url = storage().url(f.storage_path);
    if (/^https?:\/\//i.test(url)) {
      const r = await fetch(url);
      if (r.ok) bytes = Buffer.from(await r.arrayBuffer());
    } else {
      const { readFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      bytes = await readFile(join(process.cwd(), "uploads", f.storage_path));
    }
  } catch {
    bytes = null;
  }
  if (!bytes) throw new ApiError(422, "Could not read the uploaded file from storage");

  const text = /pdf/i.test(f.mime_type) ? await extractPdfText(bytes) : bytes.toString("utf8");
  return { title: f.name, text, mime: f.mime_type };
}

// Load a source row or 404. Reused by every /:id route.
async function loadSource(id: string) {
  const [row] = await db.select().from(kbSources).where(eq(kbSources.id, id)).limit(1);
  if (!row) throw new ApiError(404, "Source not found");
  return row;
}

// ─── POST /sources ───────────────────────────────────────────────────────────
// Create + ingest a new source from a file_id | url | text. Admin uploads are
// NOT auto-approved (autoApprove:false) — they enter status 'indexed' with
// approved_at NULL and await chairman approval before any answer can use them.
// Body: { title?, file_id? , url?, text?, scope, lang?, source_type }.
pragyaanAdminRouter.post("/sources", async (req: AuthedRequest, res, next) => {
  try {
    const scope = pickScope(req.body?.scope);
    const lang = pickLang(req.body?.lang);
    const sourceType = pickSourceType(req.body?.source_type);

    const fileId = trim(req.body?.file_id) || null;
    const url = trim(req.body?.url) || null;
    const rawText = typeof req.body?.text === "string" ? req.body.text : "";
    let title = trim(req.body?.title) || null;

    // Exactly one content source.
    const provided = [fileId ? "file_id" : null, url ? "url" : null, rawText.trim() ? "text" : null].filter(Boolean);
    if (provided.length === 0) throw new ApiError(400, "Provide one of file_id, url, or text");
    if (provided.length > 1) throw new ApiError(400, `Provide only one of file_id, url, text (got ${provided.join(", ")})`);

    // Resolve the content to plain text.
    let text: string;
    if (fileId) {
      const f = await fileToText(fileId);
      text = f.text;
      if (!title) title = f.title;
    } else if (url) {
      // v1: no server-side fetch of arbitrary URLs (SSRF surface). The admin
      // supplies the text body; the URL is stored as the citation deep-link.
      text = rawText;
      if (!title) title = url;
    } else {
      text = rawText;
    }

    if (!text || !text.trim()) {
      throw new ApiError(422, "No extractable text — for a PDF upload ensure it is text-based, or paste the text directly");
    }
    if (!title) throw new ApiError(400, "Title is required");

    // ingestSource handles chunk → embed → insert → status='indexed' and writes
    // its own 'upload' kb_audit row. autoApprove:false keeps gated/admin sources
    // pending chairman approval (public scope still auto-approves inside ingest).
    const result = await ingestSource({
      title,
      text,
      scope,
      lang,
      sourceType,
      url,
      fileId,
      uploadedBy: req.user!.id,
      autoApprove: false,
    });

    if (!result.sourceId) throw new ApiError(422, "Ingestion produced no content");

    const src = await loadSource(result.sourceId);
    res.status(201).json({
      id: src.id,
      title: src.title,
      scope: src.scope,
      lang: src.lang,
      source_type: src.source_type,
      status: src.status,
      version: src.version,
      chunk_count: result.chunkCount,
      approved_at: src.approved_at,
      skipped: result.skipped,
    });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /sources ──────────────────────────────────────────────────────────────
// List sources with status / scope / version + a live chunk count. Filters:
//   ?status=  ?scope=  ?q=<title substring>  ?page=  ?pageSize=
pragyaanAdminRouter.get("/sources", async (req, res, next) => {
  try {
    const status = trim(req.query.status);
    const scope = trim(req.query.scope);
    const q = trim(req.query.q);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 25));
    const offset = (page - 1) * pageSize;

    const conds: any[] = [];
    if (status && (STATUSES as readonly string[]).includes(status)) conds.push(eq(kbSources.status, status as any));
    if (scope && (SCOPES as readonly string[]).includes(scope)) conds.push(eq(kbSources.scope, scope as any));
    if (q) conds.push(sql`${kbSources.title} ILIKE ${`%${q}%`}`);
    const where = conds.length ? and(...conds) : undefined;

    // Chunk count via a correlated subquery so a source with zero chunks still lists.
    const chunkCount = sql<number>`(
      SELECT count(*)::int FROM ${kbChunks} WHERE ${kbChunks.source_id} = ${kbSources.id}
    )`.as("chunk_count");

    const rows = await db
      .select({
        id: kbSources.id,
        title: kbSources.title,
        source_type: kbSources.source_type,
        scope: kbSources.scope,
        lang: kbSources.lang,
        status: kbSources.status,
        version: kbSources.version,
        supersedes_id: kbSources.supersedes_id,
        url: kbSources.url,
        file_id: kbSources.file_id,
        approved_at: kbSources.approved_at,
        approved_by: kbSources.approved_by,
        retired_at: kbSources.retired_at,
        retention_expires_at: kbSources.retention_expires_at,
        created_at: kbSources.created_at,
        updated_at: kbSources.updated_at,
        chunk_count: chunkCount,
      })
      .from(kbSources)
      .where(where)
      .orderBy(desc(kbSources.updated_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(kbSources)
      .where(where);

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /sources/:id ──────────────────────────────────────────────────────────
// Detail for one source + its version chain (walked via supersedes_id) + chunk
// count. The chain is ordered newest→oldest; each prior row is the version this
// one superseded.
pragyaanAdminRouter.get("/sources/:id", async (req, res, next) => {
  try {
    const id = trim(req.params.id);
    if (!id) throw new ApiError(400, "Source id is required");
    const src = await loadSource(id);

    const [{ chunk_count }] = await db
      .select({ chunk_count: sql<number>`count(*)::int`.as("chunk_count") })
      .from(kbChunks)
      .where(eq(kbChunks.source_id, id));

    // Walk the supersedes_id chain (this row → the version it replaced → …).
    // Bounded loop guards against a cyclic chain. Each hop is one row.
    const chain: Array<{ id: string; version: number; status: string; approved_at: Date | null; retired_at: Date | null; created_at: Date }> = [];
    let cursor: string | null = src.supersedes_id ?? null;
    const guard = new Set<string>([id]);
    while (cursor && !guard.has(cursor) && chain.length < 50) {
      guard.add(cursor);
      const [prev]: Array<{ id: string; version: number; status: string; approved_at: Date | null; retired_at: Date | null; created_at: Date; supersedes_id: string | null }> =
        await db
          .select({
            id: kbSources.id,
            version: kbSources.version,
            status: kbSources.status,
            approved_at: kbSources.approved_at,
            retired_at: kbSources.retired_at,
            created_at: kbSources.created_at,
            supersedes_id: kbSources.supersedes_id,
          })
          .from(kbSources)
          .where(eq(kbSources.id, cursor))
          .limit(1);
      if (!prev) break;
      chain.push({ id: prev.id, version: prev.version, status: prev.status, approved_at: prev.approved_at, retired_at: prev.retired_at, created_at: prev.created_at });
      cursor = prev.supersedes_id ?? null;
    }

    res.json({ source: { ...src, chunk_count }, version_chain: chain });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /sources/:id/reindex ──────────────────────────────────────────────────
// Re-run the ingest pipeline for an existing source. We re-derive the text from
// its current backing content (file_id → extract; otherwise the current chunk
// text), bump the version, and re-embed. ingestSource writes the 'reindex'
// audit row itself; for a URL/text source with no recoverable text we surface a
// clear error rather than wiping its chunks.
pragyaanAdminRouter.post("/sources/:id/reindex", async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    const src = await loadSource(id);

    let text = "";
    let title = src.title;
    if (src.file_id) {
      const f = await fileToText(src.file_id);
      text = f.text;
      title = src.title || f.title;
    } else {
      // Reconstruct from the stored chunks (the original text source isn't
      // retained separately for url/text sources).
      const chunks = await db
        .select({ content: kbChunks.content })
        .from(kbChunks)
        .where(eq(kbChunks.source_id, id))
        .orderBy(asc(kbChunks.chunk_index));
      text = chunks.map((c) => c.content).join("\n\n");
    }

    if (!text.trim()) throw new ApiError(422, "Nothing to reindex — no recoverable text for this source");

    const result = await ingestSource({
      title,
      text,
      scope: src.scope as KbScope,
      lang: src.lang as KbLang,
      sourceType: src.source_type as KbSourceType,
      url: src.url,
      fileId: src.file_id,
      uploadedBy: req.user!.id,
      // Preserve the source's current approval posture: re-affirm only if it was
      // already approved (or public). A pending source stays pending after reindex.
      autoApprove: src.approved_at != null,
    });

    res.json({ id, status: "indexed", version: (src.version ?? 1) + 1, chunk_count: result.chunkCount, skipped: result.skipped });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /sources/:id/rollback ──────────────────────────────────────────────────
// Revert to the prior version: reactivate the version this source superseded
// (supersedes_id), and retire the current one. Only works when a prior-version
// row exists (created by a versioned re-upload). Writes a 'rollback' audit row.
pragyaanAdminRouter.post("/sources/:id/rollback", async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    const current = await loadSource(id);

    const priorId = current.supersedes_id ?? null;
    if (!priorId) {
      throw new ApiError(400, "No prior version to roll back to (this source supersedes nothing)");
    }
    const [prior] = await db.select().from(kbSources).where(eq(kbSources.id, priorId)).limit(1);
    if (!prior) throw new ApiError(400, "The superseded prior version no longer exists");

    const now = new Date();
    await db.transaction(async (tx) => {
      // Retire the current version.
      await tx
        .update(kbSources)
        .set({ retired_at: now, updated_at: now })
        .where(eq(kbSources.id, id));
      // Reactivate the prior version: clear retired_at, mark indexed. Its
      // approval posture is preserved (it was approved when it was previously live).
      await tx
        .update(kbSources)
        .set({ retired_at: null, status: "indexed", updated_at: now })
        .where(eq(kbSources.id, priorId));
    });

    await writeAudit({
      sourceId: id,
      actorId: req.user!.id,
      action: "rollback",
      fromVersion: current.version,
      toVersion: prior.version,
      detail: { reactivated_source_id: priorId, retired_source_id: id, reason: trim(req.body?.reason) || null },
    });

    res.json({ ok: true, reactivated_id: priorId, retired_id: id, active_version: prior.version });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /sources/:id/retire ──────────────────────────────────────────────────
// Soft-retire a source (sets retired_at). Retired sources are excluded from
// retrieval immediately. Idempotent. Writes a 'retire' audit row.
pragyaanAdminRouter.post("/sources/:id/retire", async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    const src = await loadSource(id);
    if (src.retired_at) {
      return res.json({ ok: true, id, retired_at: src.retired_at, already: true });
    }
    const now = new Date();
    await db.update(kbSources).set({ retired_at: now, updated_at: now }).where(eq(kbSources.id, id));

    await writeAudit({
      sourceId: id,
      actorId: req.user!.id,
      action: "retire",
      fromVersion: src.version,
      toVersion: src.version,
      detail: { reason: trim(req.body?.reason) || null },
    });

    res.json({ ok: true, id, retired_at: now });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /ingest/public ──────────────────────────────────────────────────────
// Kick the public-corpus build + ingest asynchronously and return 202. Each doc
// is ingested at scope 'public' with autoApprove:true (system-approved so the
// visitor scope answers immediately) and writes its own audit row. The job runs
// detached; failures are logged, never surfaced to this response.
pragyaanAdminRouter.post("/ingest/public", async (req: AuthedRequest, res, next) => {
  try {
    const actorId = req.user!.id;

    // Fire-and-forget — do not await. Errors are caught so an unhandled
    // rejection can't crash the process.
    void (async () => {
      const startedAt = Date.now();
      let ingested = 0;
      let skipped = 0;
      let failed = 0;
      try {
        const docs = await buildPublicDocs();
        for (const doc of docs) {
          try {
            const r = await ingestSource({
              title: doc.title,
              text: doc.text,
              scope: "public",
              lang: doc.lang ?? "en",
              sourceType: doc.sourceType,
              originKind: doc.originKind,
              originId: doc.originId,
              url: doc.url,
              uploadedBy: actorId,
              autoApprove: true,
            });
            if (r.skipped) skipped++; else ingested++;
          } catch (err) {
            failed++;
            // eslint-disable-next-line no-console
            console.error("[pragyaan:admin] public ingest doc failed (non-fatal)", doc.originKind, doc.originId, err);
          }
        }
        // One summary audit row for the whole run (per-source rows are written
        // by ingestSource itself).
        await writeAudit({
          actorId,
          action: "ingest_public",
          detail: { docs: docs.length, ingested, skipped, failed, duration_ms: Date.now() - startedAt },
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("[pragyaan:admin] public ingest job failed", err);
      }
    })();

    res.status(202).json({ accepted: true, message: "Public corpus ingest started" });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /approvals ──────────────────────────────────────────────────────────
// Pending kb_source approval queue: indexed-but-unapproved, not retired. These
// are the admin uploads awaiting a chairman decision. Admin or chairman may view.
pragyaanAdminRouter.get("/approvals", canGovern, async (_req, res, next) => {
  try {
    const chunkCount = sql<number>`(
      SELECT count(*)::int FROM ${kbChunks} WHERE ${kbChunks.source_id} = ${kbSources.id}
    )`.as("chunk_count");

    const rows = await db
      .select({
        id: kbSources.id,
        title: kbSources.title,
        source_type: kbSources.source_type,
        scope: kbSources.scope,
        lang: kbSources.lang,
        status: kbSources.status,
        version: kbSources.version,
        url: kbSources.url,
        file_id: kbSources.file_id,
        uploaded_by: kbSources.uploaded_by,
        created_at: kbSources.created_at,
        updated_at: kbSources.updated_at,
        chunk_count: chunkCount,
      })
      .from(kbSources)
      .where(and(isNull(kbSources.approved_at), isNull(kbSources.retired_at)))
      .orderBy(asc(kbSources.created_at))
      .limit(200);

    res.json({ rows, total: rows.length });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /sources/:id/approve ──────────────────────────────────────────────────
// Chairman approval: set approved_at/approved_by and ensure status 'indexed'
// (so it becomes retrievable). Writes an 'approve' audit row. Admin or chairman.
pragyaanAdminRouter.post("/sources/:id/approve", canGovern, async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    const src = await loadSource(id);
    if (src.retired_at) throw new ApiError(400, "Cannot approve a retired source");
    if (src.approved_at) {
      return res.json({ ok: true, id, approved_at: src.approved_at, already: true });
    }

    const now = new Date();
    await db
      .update(kbSources)
      .set({ approved_at: now, approved_by: req.user!.id, status: "indexed", error: null, updated_at: now })
      .where(eq(kbSources.id, id));

    await writeAudit({
      sourceId: id,
      actorId: req.user!.id,
      action: "approve",
      fromVersion: src.version,
      toVersion: src.version,
      detail: { scope: src.scope, note: trim(req.body?.note) || null },
    });

    res.json({ ok: true, id, approved_at: now, approved_by: req.user!.id });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── POST /sources/:id/reject ──────────────────────────────────────────────────
// Chairman rejection: mark status 'failed' and retire it so it can never be
// retrieved. Writes a 'reject' audit row (with the reason). Admin or chairman.
pragyaanAdminRouter.post("/sources/:id/reject", canGovern, async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    const src = await loadSource(id);
    const reason = trim(req.body?.reason) || trim(req.body?.note) || null;

    const now = new Date();
    await db
      .update(kbSources)
      .set({ status: "failed", retired_at: src.retired_at ?? now, approved_at: null, error: reason, updated_at: now })
      .where(eq(kbSources.id, id));

    await writeAudit({
      sourceId: id,
      actorId: req.user!.id,
      action: "reject",
      fromVersion: src.version,
      toVersion: src.version,
      detail: { reason },
    });

    res.json({ ok: true, id, status: "failed", rejected_by: req.user!.id });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── PATCH /sources/:id/retention ────────────────────────────────────────────────
// Set (or clear) the retention_expires_at cutoff. After this instant the source
// drops out of retrieval (enforced in retrieval.ts). Body: { retention_expires_at }
// (ISO date, or null/"" to clear). Writes a 'retention' audit row. Admin or chairman.
pragyaanAdminRouter.patch("/sources/:id/retention", canGovern, async (req: AuthedRequest, res, next) => {
  try {
    const id = trim(req.params.id);
    const src = await loadSource(id);

    // Distinguish "clear" (explicit null / empty) from "missing field".
    if (!("retention_expires_at" in (req.body ?? {}))) {
      throw new ApiError(400, "retention_expires_at is required (ISO date, or null to clear)");
    }
    const expires = parseOptDate(req.body?.retention_expires_at, "retention_expires_at");

    const now = new Date();
    await db
      .update(kbSources)
      .set({ retention_expires_at: expires, updated_at: now })
      .where(eq(kbSources.id, id));

    await writeAudit({
      sourceId: id,
      actorId: req.user!.id,
      action: "retention",
      fromVersion: src.version,
      toVersion: src.version,
      detail: {
        from: src.retention_expires_at ? src.retention_expires_at.toISOString() : null,
        to: expires ? expires.toISOString() : null,
      },
    });

    res.json({ ok: true, id, retention_expires_at: expires });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /feedback ──────────────────────────────────────────────────────────────
// Recent answer-quality feedback (kb_feedback) joined to the assistant message
// + its conversation, for the review queue (P1-1). Optional ?rating=up|down.
//   ?rating=  ?page=  ?pageSize=
pragyaanAdminRouter.get("/feedback", async (req, res, next) => {
  try {
    const rating = trim(req.query.rating);
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(5, Number(req.query.pageSize) || 25));
    const offset = (page - 1) * pageSize;

    const conds: any[] = [];
    if (rating === "up" || rating === "down") conds.push(eq(kbFeedback.rating, rating));
    const where = conds.length ? and(...conds) : undefined;

    const rows = await db
      .select({
        id: kbFeedback.id,
        rating: kbFeedback.rating,
        comment: kbFeedback.comment,
        user_id: kbFeedback.user_id,
        created_at: kbFeedback.created_at,
        message_id: kbMessages.id,
        message_content: kbMessages.content,
        message_citations: kbMessages.citations,
        message_role: kbMessages.role,
        conversation_id: kbConversations.id,
        conversation_lang: kbConversations.lang,
      })
      .from(kbFeedback)
      .innerJoin(kbMessages, eq(kbMessages.id, kbFeedback.message_id))
      .leftJoin(kbConversations, eq(kbConversations.id, kbMessages.conversation_id))
      .where(where)
      .orderBy(desc(kbFeedback.created_at))
      .limit(pageSize)
      .offset(offset);

    const [{ total }] = await db
      .select({ total: sql<number>`count(*)::int`.as("total") })
      .from(kbFeedback)
      .where(where);

    res.json({ rows, total, page, pageSize });
  } catch (err) { handleApiError(err, res, next); }
});

// ─── GET /analytics ──────────────────────────────────────────────────────────────
// Aggregate the kb_query_log into dashboard cards (P1-5). Empty-safe — returns
// zeroed metrics + empty arrays when no rows exist. Optional ?days=N window
// (default 30) for the headline metrics + by-day series; top questions span the
// same window.
pragyaanAdminRouter.get("/analytics", async (req, res, next) => {
  try {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const sinceSql = sql.raw(`now() - interval '${days} days'`);

    // Headline totals over the window. COALESCE/NULLIF keep it empty-safe
    // (no rows ⇒ 0s, never NaN / divide-by-zero).
    const [totals] = (await db.execute(sql`
      SELECT
        count(*)::int                                                   AS total,
        COALESCE(sum(CASE WHEN no_answer THEN 1 ELSE 0 END), 0)::int    AS no_answer_count,
        COALESCE(sum(CASE WHEN citation_count > 0 THEN 1 ELSE 0 END), 0)::int AS answered_with_citations,
        COALESCE(avg(top_similarity), 0)::float8                        AS avg_top_similarity
      FROM kb_query_log
      WHERE created_at >= ${sinceSql}
    `)) as unknown as Array<{
      total: number;
      no_answer_count: number;
      answered_with_citations: number;
      avg_top_similarity: number;
    }>;

    const total = Number(totals?.total ?? 0);
    const noAnswerCount = Number(totals?.no_answer_count ?? 0);
    const answeredWithCitations = Number(totals?.answered_with_citations ?? 0);
    const answered = total - noAnswerCount;

    // Top questions (case-insensitive grouping), window-scoped.
    const topQuestions = (await db.execute(sql`
      SELECT lower(btrim(question)) AS question, count(*)::int AS count
      FROM kb_query_log
      WHERE created_at >= ${sinceSql} AND question IS NOT NULL AND btrim(question) <> ''
      GROUP BY lower(btrim(question))
      ORDER BY count DESC, question ASC
      LIMIT 20
    `)) as unknown as Array<{ question: string; count: number }>;

    // Volume by day (UTC date), oldest→newest.
    const byDay = (await db.execute(sql`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
             count(*)::int AS count,
             COALESCE(sum(CASE WHEN no_answer THEN 1 ELSE 0 END), 0)::int AS no_answer
      FROM kb_query_log
      WHERE created_at >= ${sinceSql}
      GROUP BY date_trunc('day', created_at)
      ORDER BY date_trunc('day', created_at) ASC
    `)) as unknown as Array<{ day: string; count: number; no_answer: number }>;

    res.json({
      window_days: days,
      total,
      answered,
      no_answer_count: noAnswerCount,
      // Ratios as 0..1 floats; empty-safe (0 when no rows).
      no_answer_rate: total > 0 ? noAnswerCount / total : 0,
      citation_coverage: answered > 0 ? answeredWithCitations / answered : 0,
      avg_top_similarity: Number(totals?.avg_top_similarity ?? 0),
      top_questions: topQuestions.map((r) => ({ question: r.question, count: Number(r.count) })),
      by_day: byDay.map((r) => ({ day: r.day, count: Number(r.count), no_answer: Number(r.no_answer) })),
    });
  } catch (err) { handleApiError(err, res, next); }
});
