// Pragyaan AI — public corpus ingestion job (FIN-151, P0-4).
//
// Walks the PUBLISHED public content (events, site_content, announcements,
// branch resources, PDF-backed newsletters/annual_reports/paper_presentations)
// via buildPublicDocs() and ingests each as a scope='public', auto-approved
// kb_source. Re-runnable: ingestSource skips sources whose text checksum hasn't
// changed and are already indexed (no embedding spend).
//
// Run via the package scripts (tsx transpiles the imported TS on the fly):
//   npm run pragyaan:ingest        → ingest for real
//   npm run pragyaan:ingest:dry    → list candidates + counts, write NOTHING
//
// Flags:
//   --dry-run   Build the candidate docs and print a per-origin-kind summary
//               and total, WITHOUT calling ingestSource (no DB writes, no
//               provider/embedding calls).
//
// Style mirrors scripts/run-migrations.mjs: load dotenv first, do the work in a
// top-level try, set process.exitCode on failure. Exits explicitly at the end
// because the db singleton owns a long-lived connection pool.

import "dotenv/config";
import { buildPublicDocs, ingestSource } from "../server/lib/pragyaan/ingest.ts";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");

// Tally helper: count docs per originKind for the summary line.
function countByKind(docs) {
  const m = new Map();
  for (const d of docs) m.set(d.originKind, (m.get(d.originKind) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

async function run() {
  console.log(`Pragyaan public ingestion — ${dryRun ? "DRY RUN (no writes)" : "LIVE"}\n`);

  const docs = await buildPublicDocs();

  if (docs.length === 0) {
    console.log("No published public content found to ingest.");
    return;
  }

  // ── Dry run: just print the candidates + counts and stop. ────────────────
  if (dryRun) {
    console.log(`Candidate documents: ${docs.length}\n`);
    for (const d of docs) {
      const approxTokens = Math.ceil(d.text.length / 4);
      console.log(
        `  • [${d.originKind}] ${truncate(d.title, 60)}` +
          `  (${d.text.length} chars ≈ ${approxTokens} tok)` +
          (d.url ? `  → ${d.url}` : ""),
      );
    }
    console.log("\nCounts by origin_kind:");
    for (const [kind, n] of countByKind(docs)) {
      console.log(`  ${kind.padEnd(20)} ${n}`);
    }
    console.log(`\nTotal: ${docs.length} candidate document(s). (dry-run — nothing written)`);
    return;
  }

  // ── Live run: ingest each doc as public + auto-approved. ─────────────────
  let indexed = 0;
  let skipped = 0;
  let empty = 0;
  let failed = 0;
  let totalChunks = 0;

  for (const d of docs) {
    process.stdout.write(`→ [${d.originKind}] ${truncate(d.title, 60)} ... `);
    try {
      const res = await ingestSource({
        title: d.title,
        text: d.text,
        scope: "public",
        lang: d.lang ?? "en",
        sourceType: d.sourceType,
        originKind: d.originKind,
        originId: d.originId,
        url: d.url,
        autoApprove: true,
      });
      if (res.status === "indexed") {
        indexed++;
        totalChunks += res.chunkCount;
        console.log(`indexed (${res.chunkCount} chunk${res.chunkCount === 1 ? "" : "s"})`);
      } else if (res.status === "skipped") {
        skipped++;
        console.log("unchanged — skipped");
      } else {
        empty++;
        console.log("empty — skipped");
      }
    } catch (err) {
      failed++;
      console.log("FAILED");
      console.error(`   ${err?.message ?? err}`);
    }
  }

  console.log(
    `\n✓ Done. indexed=${indexed} (chunks=${totalChunks}), ` +
      `skipped=${skipped}, empty=${empty}, failed=${failed}, total=${docs.length}.`,
  );
  if (failed > 0) process.exitCode = 1;
}

function truncate(s, n) {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

try {
  await run();
  // The db singleton keeps a pooled connection open; exit explicitly so the
  // process doesn't hang after the work is done.
  process.exit(process.exitCode ?? 0);
} catch (err) {
  console.error("\n✗ Ingestion failed:", err?.message ?? err);
  process.exit(1);
}
