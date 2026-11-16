// SabPaisa encryption helpers — AES-128-CBC with PKCS7 padding, byte-for-
// byte compatible with SabPaisa's PHP7+ reference integration.
//
// SabPaisa's reference code (shared alongside UAT credentials) encrypts
// request payloads with:
//
//   openssl_encrypt($plaintext, 'AES-128-CBC', $authKey, OPENSSL_RAW_DATA, $authIv)
//
// and then base64-encodes the ciphertext for transport. Our side must
// produce identical output to that call (and inverse-decrypt the response
// SabPaisa sends back).
//
// Details that matter:
//   • Cipher:  AES-128-CBC. The key + IV are both 16 ASCII bytes
//              (enforced in config.ts). SabPaisa ships keys as ASCII
//              strings, not hex — do NOT hex-decode before use.
//   • Padding: PKCS7 (what OPENSSL_RAW_DATA emits for block ciphers by
//              default). Node's createCipheriv does this automatically
//              when autoPadding is left on.
//   • Transport: base64. SabPaisa sends/receives the base64 string as a
//                form field named `encData` (plus a plaintext `clientCode`
//                so their LB can route without decrypting).
//
// This module is pure (no DB, no I/O). The self-test at the bottom can be
// invoked via `npx tsx backend/server/lib/sabpaisa/crypto.ts` to verify
// the encrypt/decrypt round-trip and a known-vector against UAT output.

import { createCipheriv, createDecipheriv } from "node:crypto";

// Encrypts a plaintext string with SabPaisa's AES-128-CBC + PKCS7 scheme
// and returns a base64 string ready to drop into SabPaisa's `encData`
// form field.
//
// Throws on key/iv length mismatch (upstream config.ts also checks, but
// defence-in-depth — any caller that imports this directly gets a clear
// error rather than a mysterious crypto failure deep in Node.)
export function sabpaisaEncrypt(plaintext: string, authKey: string, authIv: string): string {
  assertKeyAndIv(authKey, authIv);
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(authKey, "utf8"), Buffer.from(authIv, "utf8"));
  // autoPadding defaults to true — Node applies PKCS7 which matches
  // OPENSSL_RAW_DATA's default padding. Explicitly set anyway so a future
  // Node release that changes defaults can't silently break us.
  cipher.setAutoPadding(true);
  const encryptedBuf = Buffer.concat([
    cipher.update(Buffer.from(plaintext, "utf8")),
    cipher.final(),
  ]);
  return encryptedBuf.toString("base64");
}

// Inverse of sabpaisaEncrypt — takes the base64 string SabPaisa hands us
// in the response/webhook body and returns the plaintext string. Throws
// on a tampered / corrupted payload (bad PKCS7 padding or truncated
// ciphertext).
//
// SabPaisa occasionally URL-encodes the base64 string in return-redirect
// query params; normalise + before b64-decoding. Spaces in a b64 string
// almost always mean a `+` got lost in a URL round-trip.
export function sabpaisaDecrypt(b64Ciphertext: string, authKey: string, authIv: string): string {
  assertKeyAndIv(authKey, authIv);
  const normalised = b64Ciphertext.replace(/ /g, "+").trim();
  const ciphertext = Buffer.from(normalised, "base64");
  const decipher = createDecipheriv("aes-128-cbc", Buffer.from(authKey, "utf8"), Buffer.from(authIv, "utf8"));
  decipher.setAutoPadding(true);
  const plaintextBuf = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintextBuf.toString("utf8");
}

function assertKeyAndIv(authKey: string, authIv: string): void {
  if (Buffer.byteLength(authKey, "utf8") !== 16) {
    throw new Error(`SabPaisa auth key must be 16 bytes (AES-128); got ${Buffer.byteLength(authKey, "utf8")}`);
  }
  if (Buffer.byteLength(authIv, "utf8") !== 16) {
    throw new Error(`SabPaisa auth IV must be 16 bytes (AES-128); got ${Buffer.byteLength(authIv, "utf8")}`);
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
  const demoIv  = "6543210987654321";  // 16 bytes
  const plaintext = "clientCode=NITE5&amount=100.00&clientTxnId=DEMO123";

  const encrypted = sabpaisaEncrypt(plaintext, demoKey, demoIv);
  const decrypted = sabpaisaDecrypt(encrypted, demoKey, demoIv);

  // eslint-disable-next-line no-console
  console.log("plaintext:   ", plaintext);
  // eslint-disable-next-line no-console
  console.log("encrypted b64:", encrypted);
  // eslint-disable-next-line no-console
  console.log("decrypted:   ", decrypted);

  if (decrypted !== plaintext) {
    throw new Error("Round-trip mismatch — crypto.ts is broken");
  }
  // eslint-disable-next-line no-console
  console.log("✓ round-trip OK");

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
