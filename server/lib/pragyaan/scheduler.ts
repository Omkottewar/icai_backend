// Pragyaan auto-ingest scheduler.
//
// Re-runs the public-corpus ingest on a fixed interval so newly published
// events, announcements, newsletters, papers, annual reports, and site
// content become answerable by Pragyaan without anyone manually running
// `npm run pragyaan:ingest`.
//
// Why this design (vs. hooking into every publish endpoint):
//   • ingestSource() is idempotent — it checksums the document text and
//     skips when nothing changed, so re-running the full sweep on a
//     schedule is cheap and complete.
//   • Avoids touching ~10 publish/update endpoints (events, announcements,
//     newsletters, papers, annual_reports, site_content, …). Any new
//     publishable table that buildPublicDocs() learns about automatically
//     joins the corpus without further wiring.
//   • Survives backfills, manual SQL fixes, and Studio edits — anything
//     that updates the underlying row will be picked up on the next tick.
//
// Configuration:
//   PRAGYAAN_INGEST_INTERVAL_MIN  (default 15)  — minutes between sweeps
//   PRAGYAAN_INGEST_DISABLED      (default "")  — any truthy value disables
//
// Cadence guidance: 15 minutes is the sweet spot. Shorter wastes embedding
// API budget (each new doc costs an embedding call); longer makes
// freshly-published events look invisible to Pragyaan for too long. The
// branch's content velocity is low enough that 15 min is "near-real-time"
// from a user's perspective.

import { buildPublicDocs, ingestSource } from "./ingest.js";
import { writeAudit } from "./audit.js";

const DEFAULT_INTERVAL_MIN = 15;
const STARTUP_DELAY_MS = 30_000;  // give DB pool a moment after boot

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let inFlight = false;             // never overlap sweeps

async function runSweep(): Promise<void> {
  if (inFlight) {
    console.log("[pragyaan:scheduler] sweep already running — skipping this tick");
    return;
  }
  inFlight = true;
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
          autoApprove: true,           // scheduled = system-approved
        });
        if (r.skipped) skipped++; else ingested++;
      } catch (err) {
        failed++;
        // eslint-disable-next-line no-console
        console.error("[pragyaan:scheduler] doc ingest failed", doc.originKind, doc.originId, err);
      }
    }

    const duration_ms = Date.now() - startedAt;
    // Only write an audit row if we actually did work — otherwise the audit
    // log fills up with noise every 15 minutes.
    if (ingested > 0 || failed > 0) {
      await writeAudit({
        action: "ingest_public",
        detail: { source: "scheduler", docs: docs.length, ingested, skipped, failed, duration_ms },
      });
    }

    // eslint-disable-next-line no-console
    console.log(
      `[pragyaan:scheduler] sweep done in ${duration_ms}ms — ` +
      `${ingested} new/changed, ${skipped} unchanged, ${failed} failed (of ${docs.length} docs)`,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[pragyaan:scheduler] sweep failed", err);
  } finally {
    inFlight = false;
  }
}

/**
 * Start the Pragyaan auto-ingest cron. Called once from server/index.ts at
 * boot. Idempotent — subsequent calls are no-ops.
 */
export function startPragyaanIngestCron(): void {
  if (intervalHandle) return;

  if (process.env.PRAGYAAN_INGEST_DISABLED) {
    // eslint-disable-next-line no-console
    console.log("[pragyaan:scheduler] disabled via PRAGYAAN_INGEST_DISABLED");
    return;
  }

  const minutes = Math.max(1, Number(process.env.PRAGYAAN_INGEST_INTERVAL_MIN) || DEFAULT_INTERVAL_MIN);
  const intervalMs = minutes * 60 * 1000;

  // eslint-disable-next-line no-console
  console.log(`[pragyaan:scheduler] starting — sweep every ${minutes} minutes (first run in ${STARTUP_DELAY_MS / 1000}s)`);

  // Initial sweep after a short delay so the server is fully up and the
  // first request doesn't compete with a heavy embedding run.
  setTimeout(() => {
    runSweep().catch((err) => console.error("[pragyaan:scheduler] startup sweep failed", err));
  }, STARTUP_DELAY_MS);

  intervalHandle = setInterval(() => {
    runSweep().catch((err) => console.error("[pragyaan:scheduler] periodic sweep failed", err));
  }, intervalMs);
}
