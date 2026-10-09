// AES-128-CBC + PKCS7 helpers matching SabPaisa's PHP7+ integration scheme.
//
// Discovered empirically from SabPaisa's own error response when we first
// tried the fixed-IV scheme (which is what their older docs described):
//
//     {"errorCode":"DECRYPT_FAILED",
//      "errorMessage":"Could not decrypt encData:
//                      PHP7 ciphertext must be of form <base64ct>:<base64iv>"}
//
// So SabPaisa's PHP7+ init scheme is:
//
//   1. Generate a random 16-byte IV per encryption (not the AUTH_IV from
//      the merchant credentials — that one is only used as a fallback for
//      decrypting responses).
//   2. AES-128-CBC encrypt the plaintext with the merchant's AUTH_KEY and
//      the random IV. PKCS7 padding.
//   3. Wire format: `base64(ciphertext) + ":" + base64(iv)` — one string,
//      colon-delimited, both halves base64-encoded independently. The
//      receiver splits on `:`, decodes both, then AES-decrypts.
//
// Decryption accepts BOTH shapes so we can handle:
//   • SabPaisa return/webhook payloads encoded in the new PHP7+ format
//     (base64ct:base64iv) — the colon tells us to split.
//   • Older/legacy callbacks that are still plain base64 ciphertext using
//     the AUTH_IV from credentials — fallback branch.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-128-cbc";

// ─── Encrypt ─────────────────────────────────────────────────────────────
// Random IV per call → `base64(ct):base64(iv)`. Caller never passes an IV
// because SabPaisa decrypts with the IV embedded in the payload itself.
export function encrypt(plaintext: string, key: string): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, Buffer.from(key, "utf8"), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return `${ciphertext.toString("base64")}:${iv.toString("base64")}`;
}

// ─── Decrypt ─────────────────────────────────────────────────────────────
// Accepts both the new `base64ct:base64iv` format (PHP7+) and the legacy
// bare `base64ct` format (uses the merchant's AUTH_IV from credentials as
// a fallback IV). This lets us handle every SabPaisa response variant
// without the caller having to know which era the field came from.
export function decrypt(encoded: string, key: string, fallbackIv: string): string {
  const colonIdx = encoded.indexOf(":");
  let ciphertextB64: string;
  let ivBuf: Buffer;

  if (colonIdx !== -1) {
    // New PHP7+ format: split and base64-decode both halves.
    ciphertextB64 = encoded.slice(0, colonIdx);
    const ivB64 = encoded.slice(colonIdx + 1);
    ivBuf = Buffer.from(ivB64, "base64");
    if (ivBuf.length !== 16) {
      throw new Error(`SabPaisa decrypt: embedded IV is ${ivBuf.length} bytes, expected 16`);
    }
  } else {
    // Legacy format: whole string is base64 ciphertext, use env IV.
    ciphertextB64 = encoded;
    ivBuf = Buffer.from(fallbackIv, "utf8");
  }

  const decipher = createDecipheriv(ALGORITHM, Buffer.from(key, "utf8"), ivBuf);
  const plaintext = Buffer.concat([
    decipher.update(ciphertextB64, "base64"),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
