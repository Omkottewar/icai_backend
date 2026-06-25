/**
 * runTranslate.ts — Spawn translate.py as a non-blocking background process.
 *
 * Called after every successful admin save to site_content or site_settings.
 * A 5-second debounce coalesces rapid saves (e.g. an admin editing several
 * fields) into a single translation run.  If a run is already in progress when
 * the timer fires, the new run is queued for after it finishes.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DEBOUNCE_MS = 5_000;

// Path to translate.py relative to the backend cwd (icai_backend/).
const SCRIPT = join(process.cwd(), "translate.py");

// Prefer the project venv so all ML dependencies are guaranteed to be present.
// Fall back to the PYTHON env var, then plain python3.
const VENV_PYTHON = join(process.cwd(), "transenv", "bin", "python3");
const PYTHON = existsSync(VENV_PYTHON)
  ? VENV_PYTHON
  : (process.env.PYTHON ?? "python3");

let _timer: ReturnType<typeof setTimeout> | null = null;
let _running = false;
let _queued  = false;

/**
 * Schedule a translation run.  Safe to call on every admin save — the debounce
 * and single-run guard ensure at most one process runs at a time.
 */
export function scheduleTranslation(): void {
  if (_timer) clearTimeout(_timer);
  _timer = setTimeout(_fire, DEBOUNCE_MS);
}

function _fire(): void {
  _timer = null;
  if (_running) {
    _queued = true;   // run again as soon as the current one finishes
    return;
  }
  _start();
}

function _start(): void {
  if (!existsSync(SCRIPT)) {
    console.warn("[translate] Script not found at", SCRIPT, "— skipping.");
    return;
  }

  _running = true;
  _queued  = false;
  console.log("[translate] Spawning translation pipeline …");

  const child = spawn(PYTHON, [SCRIPT], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: { ...process.env },
  });

  // Stream output line-prefixed so it's easy to spot in mixed server logs.
  child.stdout.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      console.log("[translate]", line);
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      console.error("[translate:err]", line);
    }
  });

  child.on("error", (err) => {
    console.error("[translate] Failed to spawn python:", err.message);
    _done();
  });

  child.on("close", (code) => {
    if (code === 0) {
      console.log("[translate] Done — locale files updated.");
    } else {
      console.error(`[translate] Exited with code ${code ?? "null"}.`);
    }
    _done();
  });
}

function _done(): void {
  _running = false;
  if (_queued) _start();   // a save arrived while we were running — go again
}
