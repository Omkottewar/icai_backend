// Pragyaan AI — tamper-evident audit log (FIN-151, P0-8).
//
// Every KB source mutation (upload / approve / reject / reindex / rollback /
// retire / retention change) appends one row to kb_audit. The table is
// append-only at the DB level (a trigger blocks UPDATE/DELETE — see migration
// 0038), and each row is hash-chained:
//
//   row_hash = sha256( prev_hash + "\n" + canonicalJSON(payload) )
//
// where payload includes the row's own created_at. Because each hash folds in
// the previous row's hash, rewriting or deleting any historical row breaks
// every subsequent hash — verifyAuditChain() detects exactly where.
//
// Appends are serialized with a transaction-scoped advisory lock so two
// concurrent writers can't read the same chain tip and fork it.

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../../../db/client.js";

/** Arbitrary constant key for the append-serializing advisory lock. */
const AUDIT_LOCK_KEY = 0x70726761; // "prga"

export type AuditAction =
  | "upload"
  | "approve"
  | "reject"
  | "reindex"
  | "rollback"
  | "retire"
  | "retention"
  | "ingest_public";

export interface AuditInput {
  sourceId?: string | null;
  actorId?: string | null;
  action: AuditAction | string;
  fromVersion?: number | null;
  toVersion?: number | null;
  detail?: Record<string, unknown>;
}

/** Deterministic JSON: object keys sorted recursively so the hash is stable. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

function hashRow(prevHash: string | null, payload: unknown): string {
  return createHash("sha256").update(`${prevHash ?? ""}\n${canonical(payload)}`).digest("hex");
}

/**
 * Append one tamper-evident row to kb_audit. Returns the new row's id + hash.
 * Safe under concurrency (advisory-locked); never throws on a missing detail.
 */
export async function writeAudit(input: AuditInput): Promise<{ id: string; rowHash: string; seq: number }> {
  return db.transaction(async (tx) => {
    // Serialize appends — only one writer extends the chain at a time.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_KEY})`);

    const tip = (await tx.execute(
      sql`SELECT row_hash FROM kb_audit ORDER BY seq DESC LIMIT 1`,
    )) as unknown as Array<{ row_hash: string }>;
    const prevHash = tip.length ? tip[0]!.row_hash : null;

    const createdAt = new Date().toISOString();
    const detail = input.detail ?? {};
    const payload = {
      source_id: input.sourceId ?? null,
      actor_id: input.actorId ?? null,
      action: input.action,
      from_version: input.fromVersion ?? null,
      to_version: input.toVersion ?? null,
      detail,
      created_at: createdAt,
    };
    const rowHash = hashRow(prevHash, payload);

    const inserted = (await tx.execute(sql`
      INSERT INTO kb_audit
        (source_id, actor_id, action, from_version, to_version, detail, prev_hash, row_hash, created_at)
      VALUES (
        ${payload.source_id},
        ${payload.actor_id},
        ${payload.action},
        ${payload.from_version},
        ${payload.to_version},
        ${JSON.stringify(detail)}::jsonb,
        ${prevHash},
        ${rowHash},
        ${createdAt}::timestamptz
      )
      RETURNING id, seq
    `)) as unknown as Array<{ id: string; seq: number | string }>;

    const row = inserted[0]!;
    return { id: row.id, rowHash, seq: Number(row.seq) };
  });
}

export interface ChainVerification {
  ok: boolean;
  /** kb_audit.seq of the first row whose recomputed hash diverges, if any. */
  brokenAtSeq?: number;
  rowsChecked: number;
}

/**
 * Recompute the whole chain and confirm each row's prev_hash + row_hash still
 * agree. Returns the first divergence (tamper point) if the chain is broken.
 */
export async function verifyAuditChain(): Promise<ChainVerification> {
  const rows = (await db.execute(sql`
    SELECT seq, source_id, actor_id, action, from_version, to_version, detail, prev_hash, row_hash, created_at
    FROM kb_audit ORDER BY seq ASC
  `)) as unknown as Array<{
    seq: number | string;
    source_id: string | null;
    actor_id: string | null;
    action: string;
    from_version: number | null;
    to_version: number | null;
    detail: Record<string, unknown>;
    prev_hash: string | null;
    row_hash: string;
    created_at: string | Date;
  }>;

  let prevHash: string | null = null;
  let checked = 0;
  for (const r of rows) {
    const createdAt = r.created_at instanceof Date ? r.created_at.toISOString() : new Date(r.created_at).toISOString();
    const payload = {
      source_id: r.source_id,
      actor_id: r.actor_id,
      action: r.action,
      from_version: r.from_version,
      to_version: r.to_version,
      detail: r.detail ?? {},
      created_at: createdAt,
    };
    const expected = hashRow(prevHash, payload);
    checked++;
    if (r.prev_hash !== prevHash || r.row_hash !== expected) {
      return { ok: false, brokenAtSeq: Number(r.seq), rowsChecked: checked };
    }
    prevHash = r.row_hash;
  }
  return { ok: true, rowsChecked: checked };
}
