// SabPaisa encryption helpers — AES-128-CBC with PKCS7 padding, matching
// SabPaisa's current PHP7+ scheme.
//
// Transport format (confirmed by SabPaisa's own error message
// "PHP7 ciphertext must be of form <base64ct>:<base64iv>"):
//
//     encData = base64(ciphertext) + ":" + base64(iv)
//
// The IV is RANDOM per encryption (16 bytes from crypto.randomBytes). It
// travels embedded in the payload so SabPaisa's server can extract it on
// decrypt. Only the AES key is shared out-of-band; the IV is per-call.
//
// SabPaisa's own responses (callback body, webhook body, /status/verify
// response) come back in the same `base64ct:base64iv` form, so decrypt
// does the inverse: split on ":", base64-decode both halves, use the
// extracted IV with the shared key.
//
// Details that matter:
//   • Cipher:  AES-128-CBC. The key is 16 ASCII bytes (enforced in
//              config.ts). SabPaisa ships the key as an ASCII string,
//              not hex — do NOT hex-decode before use.
//   • Padding: PKCS7 (what OPENSSL_RAW_DATA emits for block ciphers by
//              default). Node's createCipheriv does this automatically
//              when autoPadding is left on.
//   • IV:      16 bytes, randomly generated per encrypt call. NOT taken
//              from env — the SABPAISA_AUTH_IV env var is a leftover
//              from F30 (PHP5 static-IV scheme) and no longer used.
//   • Transport: base64(ct) + ":" + base64(iv). The colon is literal —
//              base64's alphabet never produces one, so split-on-colon
//              is unambiguous.
//
// This module is pure (no DB, no I/O). The self-test at the bottom can be
// invoked via `npx tsx backend/server/lib/sabpaisa/crypto.ts` to verify
// the encrypt/decrypt round-trip.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Encrypts a plaintext string with SabPaisa's AES-128-CBC + PKCS7 scheme
// and returns the PHP7+ transport form `base64(ct):base64(iv)` ready to
// drop into SabPaisa's `encData` form field.
//
// `authIv` is accepted (ignored) so existing call sites compile unchanged
// — they still pass the env-configured IV from F30, but we no longer use
// it. A random IV is generated per call.
export function sabpaisaEncrypt(plaintext: string, authKey: string, _authIv?: string): string {
  assertKey(authKey);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(authKey, "utf8"), iv);
  // autoPadding defaults to true — Node applies PKCS7 which matches
  // OPENSSL_RAW_DATA's default padding. Explicitly set anyway so a future
  // Node release that changes defaults can't silently break us.
  cipher.setAutoPadding(true);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  return `${ciphertext.toString("base64")}:${iv.toString("base64")}`;
}

// Inverse of sabpaisaEncrypt — takes the PHP7+ `base64(ct):base64(iv)`
// string SabPaisa sends in callbacks / webhook bodies / verify responses
// and returns the plaintext. Throws on a malformed / tampered payload
// (missing colon, bad base64, truncated ciphertext, bad PKCS7 padding).
//
// SabPaisa occasionally URL-encodes the payload in return-redirect query
// params; we normalise ` ` → `+` before b64-decoding. Spaces in a b64
// string almost always mean a `+` got lost in a URL round-trip.
export function sabpaisaDecrypt(encData: string, authKey: string, _authIv?: string): string {
  assertKey(authKey);
  const normalised = encData.replace(/ /g, "+").trim();
  const colon = normalised.indexOf(":");
  if (colon < 0) {
    throw new Error("SabPaisa decrypt: payload missing ':' separator — expected 'base64(ct):base64(iv)'");
  }
  const b64Ct = normalised.slice(0, colon);
  const b64Iv = normalised.slice(colon + 1);
  const ciphertext = Buffer.from(b64Ct, "base64");
  const iv = Buffer.from(b64Iv, "base64");
  if (iv.length !== 16) {
    throw new Error(`SabPaisa decrypt: IV must be 16 bytes after base64 decode (got ${iv.length})`);
  }
  const decipher = createDecipheriv("aes-128-cbc", Buffer.from(authKey, "utf8"), iv);
  decipher.setAutoPadding(true);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

function assertKey(authKey: string): void {
  if (Buffer.byteLength(authKey, "utf8") !== 16) {
    throw new Error(`SabPaisa auth key must be 16 bytes (AES-128); got ${Buffer.byteLength(authKey, "utf8")}`);
  }
}

// ─── Self-test (not run at import time) ───────────────────────────────────
// Runs when this file is executed directly:
//   npx tsx backend/server/lib/sabpaisa/crypto.ts
//
// Verifies round-trip encrypt → decrypt and prints a sample ciphertext.
// If SabPaisa's integration docs ship an "expected ciphertext" test vector,
// add it to KNOWN_VECTOR below and the script will compare.
//
// Guard uses `import.meta.url` so the self-test only fires under direct
// invocation, never when another module imports this file.
async function _selfTest(): Promise<void> {
  const demoKey = "1234567890123456";  // 16 bytes
  const plaintext = "clientCode=NITE5&amount=100.00&clientTxnId=DEMO123";

  const encrypted = sabpaisaEncrypt(plaintext, demoKey);
  const decrypted = sabpaisaDecrypt(encrypted, demoKey);

  // eslint-disable-next-line no-console
  console.log("plaintext:   ", plaintext);
  // eslint-disable-next-line no-console
  console.log("encrypted:   ", encrypted);  // should contain exactly one ':'
  // eslint-disable-next-line no-console
  console.log("decrypted:   ", decrypted);

  if (decrypted !== plaintext) {
    throw new Error("Round-trip mismatch — crypto.ts is broken");
  }
  if (!encrypted.includes(":")) {
    throw new Error("Encrypted output missing ':' separator — PHP7+ format broken");
  }
  // eslint-disable-next-line no-console
  console.log("✓ round-trip OK (PHP7+ base64ct:base64iv format)");

  // Sanity check — two consecutive encryptions of the same plaintext
  // should produce DIFFERENT ciphertexts (random IV per call). If they
  // match, randomBytes isn't firing and SabPaisa would eventually reject.
  const encrypted2 = sabpaisaEncrypt(plaintext, demoKey);
  if (encrypted === encrypted2) {
    throw new Error("Two encrypts produced identical output — IV is not random");
  }
  // eslint-disable-next-line no-console
  console.log("✓ random IV per call confirmed");

  // If SabPaisa ever publishes a test vector (plaintext + known expected
  // ciphertext), uncomment below and compare. The KNOWN_VECTOR block is
  // the single place ongoing maintenance happens — update it when SabPaisa
  // ships new reference material.
  //
  // const KNOWN_VECTOR = {
  //   plaintext:  "<paste from SabPaisa PHP reference>",
  //   expectedB64: "<paste expected base64 output>",
  //   key:        "<paste 16-byte key>",
  //   iv:         "<paste 16-byte IV>",
  // };
  // const vectorOut = sabpaisaEncrypt(KNOWN_VECTOR.plaintext, KNOWN_VECTOR.key, KNOWN_VECTOR.iv);
  // if (vectorOut !== KNOWN_VECTOR.expectedB64) {
  //   throw new Error(`Known-vector mismatch\n  got:      ${vectorOut}\n  expected: ${KNOWN_VECTOR.expectedB64}`);
  // }
  // console.log("✓ known-vector OK");
}

// ESM "run if invoked directly" idiom. Works under tsx and plain node.
// Checks that the file's URL matches the process's argv entry point.
if (typeof import.meta !== "undefined" && import.meta.url && typeof process !== "undefined") {
  const invokedPath = process.argv[1]?.replace(/\\/g, "/");
  const thisPath    = decodeURIComponent(import.meta.url.replace(/^file:\/\//, "").replace(/^\/([A-Za-z]:)/, "$1"));
  if (invokedPath && thisPath.endsWith(invokedPath.replace(/\\/g, "/").split("/").slice(-5).join("/"))) {
    _selfTest().catch((e) => {
      // eslint-disable-next-line no-console
      console.error(e);
      process.exit(1);
    });
  }
}
