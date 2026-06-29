// One-command DB bootstrap. Run after a fresh setup or a TRUNCATE to restore
// a known-good baseline state:
//
//   ✓ 15 canonical role codes seeded
//   ✓ Nagpur branch (NGP) row
//   ✓ 13 standing committees + chairman/convener/co-convener roster
//   ✓ 18 notification_templates re-seeded from migration files
//   ✓ ICAI directory imported from ../ICAI DIRECTORY.xlsx (if present)
//
// Idempotent — re-running on an already-populated DB is a no-op.
//
// Run:  npm run bootstrap
//   or: npx tsx scripts/bootstrap-db.mjs

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const STEPS = [
  { name: "Apply pending migrations",          cmd: "npm",  args: ["run", "db:migrate"] },
  { name: "Seed 15 role codes",                cmd: "npx",  args: ["tsx", "scripts/seed-roles.mjs"] },
  { name: "Seed branch + committees + staff",  cmd: "npx",  args: ["tsx", "scripts/seed-committees-and-staff.mjs"] },
  { name: "Re-seed notification templates",    cmd: "npx",  args: ["tsx", "scripts/reseed-notification-templates.mjs"] },
];

// ICAI directory — only run if the xlsx exists. Avoids breaking the bootstrap
// on a developer machine that doesn't have the file.
const xlsx = join(process.cwd(), "..", "ICAI DIRECTORY.xlsx");
if (existsSync(xlsx)) {
  STEPS.push({
    name: "Import ICAI member directory",
    cmd:  "npx",
    args: ["tsx", "scripts/import-icai-directory.ts", xlsx],
  });
} else {
  console.log(`(Skipping ICAI directory import — ${xlsx} not found.)\n`);
}

function run(step) {
  return new Promise((resolve, reject) => {
    console.log(`\n━━━ ${step.name} ━━━`);
    const proc = spawn(step.cmd, step.args, { stdio: "inherit", shell: true });
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${step.name} failed with exit code ${code}`));
    });
    proc.on("error", reject);
  });
}

let failed = 0;
for (const step of STEPS) {
  try { await run(step); }
  catch (err) { console.error(`\n✗ ${err.message}`); failed++; }
}

console.log("\n" + "━".repeat(50));
if (failed === 0) {
  console.log("✓ Bootstrap complete. Your DB is in a known-good baseline state.");
  console.log("\nNext steps:");
  console.log("  1. npm run dev               (start backend)");
  console.log("  2. cd ../frontend && npm run dev  (start frontend)");
  console.log("  3. Sign up / log in, then run scripts/grant-admin.mjs <your-email>");
} else {
  console.log(`✗ Bootstrap finished with ${failed} failed step(s). See errors above.`);
  process.exit(1);
}
