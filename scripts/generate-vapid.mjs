// Generate a VAPID keypair for web-push notifications.
//
// Run once per environment (dev / staging / prod). The OUTPUT is meant
// to be pasted into the matching .env file — never commit the private key.
//
//   node scripts/generate-vapid.mjs                 # prints the pair
//   node scripts/generate-vapid.mjs >> .env         # appends to .env (use with care)
//
// Rotating these keys invalidates every existing push subscription, so
// run this exactly ONCE for production and treat the private key as a
// long-lived secret.

import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
const subject = process.env.VAPID_SUBJECT || "mailto:nagpur@icai.org";

const out = [
  "# --- VAPID keypair generated " + new Date().toISOString() + " ---",
  "VAPID_PUBLIC_KEY=" + publicKey,
  "VAPID_PRIVATE_KEY=" + privateKey,
  "VAPID_SUBJECT=" + subject,
  "",
].join("\n");

process.stdout.write(out);
