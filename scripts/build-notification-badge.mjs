// Regenerate frontend/public/notification-badge.png from the source CA
// India logo. The badge is the small monochrome icon Android shows next
// to "ICAI Nagpur" in push notifications — Android tints it with the
// system accent colour, so it has to be white on transparent (a full-
// colour PNG comes out as a black square).
//
// One-off script. Run with:
//   cd backend
//   node scripts/build-notification-badge.mjs
//
// Re-run after replacing frontend/src/assets/CA India Logo.png.

import sharp from "sharp";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "../../frontend/src/assets/CA India Logo.png");
const DST = resolve(__dirname, "../../frontend/public/notification-badge.png");

async function main() {
  // Pull the logo as raw RGBA.
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  // Recolour: every non-transparent pixel → opaque white. Transparent
  // pixels stay transparent. Threshold of 16 ignores tiny anti-alias
  // ghosts at the edges of the source.
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 16) {
      data[i] = 255;
      data[i + 1] = 255;
      data[i + 2] = 255;
    } else {
      data[i + 3] = 0;
    }
  }

  // Trim transparent edges, resize to fit 80x80, then pad to 96x96 so
  // the shape doesn't kiss the badge's outer edge when Android masks it.
  await sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
    .trim({ threshold: 1 })
    .resize({ width: 80, height: 80, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({ top: 8, bottom: 8, left: 8, right: 8, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toFile(DST);

  console.log(`Wrote ${DST} (${fs.statSync(DST).size} bytes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
