// SabPaisa integration smoke test — exercises each stage of the integration
// against the credentials currently in process.env, without needing a full
// browser payment flow. Intended to be run inside the Fly machine so it
// talks to the exact same env the live app sees:
//
//   fly ssh console -a icai
//   cd /app && node dist/scripts/sabpaisa-smoke.mjs
//
// (or from your laptop if your local .env points at UAT credentials.)
//
// What it checks, in order:
//   1. Env vars are present and correctly-sized
//   2. Crypto round-trip + PHP7+ `base64ct:base64iv` format emission
//   3. SabPaisa /status/verify endpoint reachability + crypto handshake
//      with a deliberately-bogus clientTxnId (expect "txn not found")
//
// Init URL and callback return URL can't be meaningfully tested from the
// CLI — they're browser-redirect targets. Webhook arrival is driven by
// SabPaisa, not us. For those, the real-browser ₹1 payment test is the
// only authoritative check.

import { randomBytes } from "node:crypto";

// Load modules via dynamic import so this script can run against the
// compiled dist OR the source tree (tsx). Resolves relative to cwd.
const cryptoMod = await import("../server/lib/sabpaisa/crypto.js").catch(
  () => import("../dist/server/lib/sabpaisa/crypto.js"),
);
const configMod = await import("../server/lib/sabpaisa/config.js").catch(
  () => import("../dist/server/lib/sabpaisa/config.js"),
);
const clientMod = await import("../server/lib/sabpaisa/client.js").catch(
  () => import("../dist/server/lib/sabpaisa/client.js"),
);

const { sabpaisaEncrypt, sabpaisaDecrypt } = cryptoMod;
const { sabpaisaConfig } = configMod;
const { verifyPayment } = clientMod;

const log = (icon, ...args) => console.log(icon, ...args);
const pass = (msg) => log("✓", msg);
const fail = (msg) => { log("✗", msg); process.exitCode = 1; };
const info = (msg) => log("•", msg);

async function main() {
  console.log("══ SabPaisa smoke test ═══════════════════════════════════════════\n");

  // ─── Test 1: config env vars ──────────────────────────────────────────
  console.log("1. Env vars present + correctly sized");
  let cfg;
  try {
    cfg = sabpaisaConfig();
    pass(`clientCode     = ${cfg.clientCode}`);
    pass(`username       = ${cfg.username.slice(0, 3)}***`);
    pass(`password       = [${cfg.password.length} chars]`);
    pass(`authKey        = [${Buffer.byteLength(cfg.authKey, "utf8")} bytes]  ${cfg.authKey.length === 16 ? "✓ AES-128 ok" : "✗ must be 16"}`);
    pass(`authIv         = [${Buffer.byteLength(cfg.authIv, "utf8")} bytes]  (unused in PHP7+ scheme, still validated)`);
    pass(`initUrl        = ${cfg.initUrl}`);
    pass(`verifyUrl      = ${cfg.verifyUrl}`);
    pass(`refundUrl      = ${cfg.refundUrl}`);
    pass(`returnUrl      = ${cfg.returnUrl}`);
  } catch (e) {
    fail(`sabpaisaConfig() threw: ${e.message}`);
    return;
  }
  console.log();

  // ─── Test 2: crypto round-trip + PHP7+ format ─────────────────────────
  console.log("2. Crypto round-trip + PHP7+ base64ct:base64iv format");
  const samplePt = "clientCode=NITE5&amount=1.00&clientTxnId=SMOKE" + Date.now();
  const enc1 = sabpaisaEncrypt(samplePt, cfg.authKey);
  const enc2 = sabpaisaEncrypt(samplePt, cfg.authKey);
  const dec1 = sabpaisaDecrypt(enc1, cfg.authKey);

  info(`plaintext:   ${samplePt}`);
  info(`encrypted:   ${enc1.slice(0, 60)}...`);
  info(`decrypted:   ${dec1}`);

  if (dec1 !== samplePt)                         { fail("Round-trip mismatch"); return; }
  else                                           pass("round-trip plaintext → ciphertext → plaintext");
  if (!enc1.includes(":"))                       fail("Output missing ':' separator (PHP7+ format broken)");
  else                                           pass("encData contains ':' separator");
  const [b64ct, b64iv] = enc1.split(":");
  if (Buffer.from(b64iv, "base64").length !== 16) fail(`IV decoded length ${Buffer.from(b64iv, "base64").length} (expected 16)`);
  else                                           pass("IV portion decodes to exactly 16 bytes");
  if (enc1 === enc2)                             fail("Two encrypts of same plaintext produced identical output — IV not random");
  else                                           pass("random IV per call confirmed (two encrypts differ)");
  console.log();

  // ─── Test 3: SabPaisa /status/verify endpoint reachability ────────────
  console.log("3. SabPaisa /status/verify endpoint reachability");
  // Use a deliberately-bogus clientTxnId SabPaisa will never have. Expect
  // either: (a) a decrypt-able response saying "not found", or (b) a
  // specific error code we can interpret. Any 500/timeout = network issue.
  const bogusTxnId = `SMOKE-${randomBytes(6).toString("hex")}-${Date.now()}`;
  info(`querying verify endpoint with bogus clientTxnId: ${bogusTxnId}`);
  try {
    const result = await verifyPayment(bogusTxnId);
    pass(`verify endpoint reachable`);
    info(`  outcome:  ${result.outcome}`);
    info(`  response: ${JSON.stringify(result.response, null, 2)}`);
    // If outcome is "pending" with no response, SabPaisa probably doesn't
    // know the txn (expected). If outcome is "failed"/"aborted" with a
    // statusDesc like "transaction not found", also fine. If it blows up
    // decrypting the response, that's the real signal we care about.
    if (!result.response) {
      info("  (no decoded response body — SabPaisa may have replied with a non-standard shape; worth inspecting raw)");
    }
  } catch (e) {
    fail(`verify endpoint threw: ${e.message}`);
    if (/decrypt/i.test(e.message)) {
      info("  → SabPaisa's response could not be decrypted with our key. Either:");
      info("    (a) SABPAISA_AUTH_KEY on Fly doesn't match the merchant's key");
      info("    (b) SabPaisa's response is in a different format than we expect");
    } else if (/ENOTFOUND|ECONN|timeout/i.test(e.message)) {
      info("  → network reachability problem. Check SABPAISA_VERIFY_URL value + Fly outbound.");
    } else if (/HTTP 4\d\d/.test(e.message)) {
      info("  → HTTP 4xx. SabPaisa accepted the request but rejected it.");
      info("    Check credential pairing (clientCode / username / password).");
    }
  }
  console.log();

  // ─── Summary ──────────────────────────────────────────────────────────
  if (process.exitCode) {
    console.log("══ FAIL — some checks did not pass ═══════════════════════════════");
  } else {
    console.log("══ PASS — all smoke checks green ══════════════════════════════════");
    console.log();
    console.log("Next step: open a paid event in the browser (live site), click Register,");
    console.log("complete a ₹1 payment. Watch logs:");
    console.log("  fly logs -a icai");
    console.log("Successful flow produces:");
    console.log("  [sabpaisa] /return handler — payment X flipped to success");
  }
}

main().catch((e) => {
  console.error("\nSmoke test crashed:", e);
  process.exit(1);
});
