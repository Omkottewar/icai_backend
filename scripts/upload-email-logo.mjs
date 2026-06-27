// One-shot: upload the branch logo to Supabase Storage so it can be embedded
// as a stable <img src> in transactional email templates (Auth0 verification,
// password reset, etc.) without depending on the frontend's deploy URL.
//
// Run:  npx tsx scripts/upload-email-logo.mjs
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { storage } from "../server/lib/storage.ts";

const LOGO_PATH = join(process.cwd(), "..", "frontend", "public", "pwa-192.png");
const TARGET_BUCKET = "email-assets";
const TARGET_FILENAME = "icai-nagpur-logo.png";

console.log(`Reading: ${LOGO_PATH}`);
const bytes = await readFile(LOGO_PATH);
console.log(`Size: ${bytes.length} bytes`);

console.log(`Uploading to Supabase: ${TARGET_BUCKET}/${TARGET_FILENAME}`);
const driver = storage();
const storagePath = await driver.put(TARGET_BUCKET, TARGET_FILENAME, bytes, "image/png");
const publicUrl = driver.url(storagePath);

console.log("");
console.log("Done. Public URL:");
console.log(publicUrl);
console.log("");
console.log("Paste this URL into the email template's <img src=\"...\">");
