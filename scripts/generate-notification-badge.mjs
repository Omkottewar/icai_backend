// One-shot: regenerate frontend/public/notification-badge.png as a proper
// Android-compatible monochrome silhouette derived from the same CA India
// logo the mobile wrapper uses.
//
// Why this file matters: Android renders the notification BADGE (the tiny
// icon in the status bar + app row) by tinting every non-transparent pixel
// with the device's accent colour. A full-colour logo therefore comes out
// as a black square. The badge must be a clean silhouette — pure white
// pixels on a fully transparent background.
//
// Source: frontend/src/assets/CA India Logo.png (the wrapper launcher logo)
// Output:  frontend/public/notification-badge.png (96×96, white silhouette,
//          PNG with alpha)
//
// Run:  npx tsx scripts/generate-notification-badge.mjs

import "dotenv/config";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const SRC = join(process.cwd(), "..", "frontend", "src", "assets", "CA India Logo.png");
const DST = join(process.cwd(), "..", "frontend", "public", "notification-badge.png");
const SIZE = 96; // Android's recommended badge size

console.log(`Reading source: ${SRC}`);
const sourceBuf = await readFile(SRC);

// Pipeline:
// 1. Resize to badge dimensions
// 2. Extract the alpha channel — gives us the silhouette shape
// 3. Use that alpha as a mask over a pure-white layer
// 4. Save as PNG (preserves alpha)
const resized = await sharp(sourceBuf)
  .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
  .ensureAlpha()
  .toBuffer();

// Read pixels so we can build the silhouette manually — anything visible
// in the source becomes pure white in the badge, transparency is preserved.
const { data, info } = await sharp(resized)
  .raw()
  .toBuffer({ resolveWithObject: true });

const out = Buffer.alloc(data.length);
for (let i = 0; i < data.length; i += 4) {
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  const a = data[i + 3];
  // Treat any sufficiently opaque non-white-ish pixel as "ink" → opaque white.
  // White-ish background pixels (if any) stay transparent so the silhouette
  // matches the visible shape of the source logo.
  const brightness = (r + g + b) / 3;
  const isBackground = a < 32 || brightness > 240;
  if (isBackground) {
    out[i] = out[i + 1] = out[i + 2] = 0;
    out[i + 3] = 0;
  } else {
    out[i] = out[i + 1] = out[i + 2] = 255;
    out[i + 3] = a; // preserve the original alpha for smooth edges
  }
}

await sharp(out, {
  raw: { width: info.width, height: info.height, channels: 4 },
})
  .png({ compressionLevel: 9 })
  .toFile(DST);

const stat = await readFile(DST);
console.log(`✓ Wrote ${DST}`);
console.log(`  ${info.width}×${info.height} px · ${(stat.length / 1024).toFixed(1)} KB`);
console.log("\nDon't forget to clear your phone's site data so the new badge is picked up");
console.log("(or wait — service worker caches images, so it'll update on next deploy).");
